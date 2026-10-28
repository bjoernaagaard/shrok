import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { chromium } from "playwright-core";
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  LaunchOptions,
  Locator,
  Page,
  Request,
} from "playwright-core";
import { Value } from "typebox/value";

import { report } from "../events.ts";
import { browserPath, locale, timeZone } from "../settings.ts";
import type { Approvals } from "./approvals.ts";
import type { PublicWeb } from "./public-web.ts";
import { publicUrl } from "./public-web.ts";
import { safeEnv } from "./sandbox.ts";
import type { SeenUrls } from "./seen-urls.ts";

const IDLE_MS = 10 * 60 * 1000;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_STATE_COOKIES = 512;

const SavedCookies = Type.Object({
  cookies: Type.Array(
    Type.Object({
      domain: Type.String(),
      expires: Type.Number(),
      httpOnly: Type.Boolean(),
      name: Type.String(),
      path: Type.String(),
      sameSite: Type.Union([
        Type.Literal("Strict"),
        Type.Literal("Lax"),
        Type.Literal("None"),
      ]),
      secure: Type.Boolean(),
      value: Type.String(),
    }),
    { maxItems: MAX_STATE_COOKIES }
  ),
});

const QUIET_MS = 300;
const SETTLE_CAP_MS = 3000;
const POLL_MS = 50;
const NAVIGATION_TIMEOUT_MS = 45_000;
const ACTION_TIMEOUT_MS = 15_000;
const SNAPSHOT_CHARS = 50_000;
const HEADLESS = /HeadlessChrome/gu;

const FOLD_AT = 12;
const FOLD_HEAD = 8;
const FOLD_TAIL = 2;
const NOT_SPACE = /\S/u;
const REF = /\[ref=(?<ref>[^\]]+)\]/u;

const OWN_PARTS = / \[ref=[^\]]+\]|"(?:[^"\\]|\\.)*"|: .*$/gu;

const VersionResponse = Type.Object({ userAgent: Type.String() });

const DEBIAN_CHROMIUM = "/usr/bin/chromium";

/** SHROK_BROWSER, else Google Chrome on macOS, Debian's chromium, or Playwright's own headless shell. */
const whichBrowser = (): LaunchOptions => {
  if (browserPath !== undefined) {
    return { executablePath: browserPath };
  }

  if (process.platform === "darwin") {
    return { channel: "chrome" };
  }

  return existsSync(DEBIAN_CHROMIUM) ? { executablePath: DEBIAN_CHROMIUM } : {};
};

/**
 * Keeps Chrome on the public-web proxy. It resolves no names itself, so every request, redirect and
 * subresource, loopback included, goes to the proxy by name; WebRTC may not send UDP around the proxy, and
 * QUIC, which a proxy cannot carry, is off.
 */
const PROXY_ONLY = [
  "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--disable-quic",
];

declare global {
  /** When the page last changed, by performance.now(), set by the init script in the page. */
  var __shrokChanged: number | undefined;
}

const DATA_REQUESTS = new Set(["fetch", "xhr"]);
const inFlight = new WeakMap<Page, ReadonlySet<Request>>();

interface Open {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
}

// Some sites hold back a browser whose user agent says "HeadlessChrome".
class Session {
  readonly #stateFile: string;
  readonly #publicWeb: PublicWeb;
  #open: Promise<Open> | undefined;
  #idle: NodeJS.Timeout | undefined;

  constructor(stateFile: string, publicWeb: PublicWeb) {
    this.#stateFile = stateFile;
    this.#publicWeb = publicWeb;
  }

  async page(): Promise<Page> {
    clearTimeout(this.#idle);
    this.#idle = setTimeout(() => {
      // Idle cleanup has no caller. close still releases Chromium when persistence fails.
      void this.close().catch(() => {
        report("browser", "Browser idle cleanup or state persistence failed.");
      });
    }, IDLE_MS);
    this.#idle.unref();

    this.#open ??= this.#launch();

    try {
      const { page } = await this.#open;

      return page;
    } catch (error) {
      this.#open = undefined;
      throw error;
    }
  }

  async save(): Promise<void> {
    const open = await this.#open;

    if (open !== undefined) {
      await this.#saveState(open.context);
    }
  }

  /** Persist cookies only: storageState also collects unbounded publisher-controlled localStorage. */
  async #saveState(context: BrowserContext): Promise<void> {
    const cookies = await context.cookies();

    if (cookies.length > MAX_STATE_COOKIES) {
      throw new Error("Browser cookies exceed the persistence count limit.");
    }

    const state = JSON.stringify({ cookies, origins: [] });

    if (Buffer.byteLength(state, "utf-8") > MAX_STATE_BYTES) {
      throw new Error("Browser cookies exceed the persistence byte limit.");
    }

    writeFileSync(this.#stateFile, state, { mode: 0o600 });
  }

  #loadState(): Exclude<BrowserContextOptions["storageState"], string> {
    if (!existsSync(this.#stateFile)) {
      return undefined;
    }

    const file = openSync(this.#stateFile, "r");

    try {
      // Read at most the budget plus one byte, even if the file grows during the read.
      const buffer = Buffer.alloc(MAX_STATE_BYTES + 1);
      let size = 0;

      while (size < buffer.length) {
        const read = readSync(file, buffer, size, buffer.length - size, null);

        if (read === 0) {
          break;
        }

        size += read;
      }

      if (size > MAX_STATE_BYTES) {
        throw new Error("Saved browser state exceeds the restore byte limit.");
      }

      const { cookies } = Value.Parse(
        SavedCookies,
        JSON.parse(buffer.subarray(0, size).toString("utf-8"))
      );

      // Ignore legacy localStorage rather than restoring publisher-controlled origin data.
      return { cookies, origins: [] };
    } finally {
      closeSync(file);
    }
  }

  /** Starts the browser and closes it again, so a browser that can't start stops Shrok at startup. */
  async check(): Promise<void> {
    let open: Open;

    try {
      open = await this.#launch();
    } catch (error) {
      throw new Error(
        process.platform === "linux"
          ? "The browser did not start. In a container, run with packaging/oci/seccomp.json and systempaths=unconfined, so its sandbox can start."
          : "The browser did not start. Install Google Chrome, or set SHROK_BROWSER to a Chromium binary.",
        { cause: error }
      );
    }

    await open.browser.close();
  }

  async close(): Promise<void> {
    const open = this.#open;

    clearTimeout(this.#idle);
    this.#open = undefined;

    if (open === undefined) {
      return;
    }

    const { browser, context } = await open;

    try {
      await this.#saveState(context);
    } finally {
      await browser.close();
    }
  }

  async #launch(): Promise<Open> {
    mkdirSync(path.dirname(this.#stateFile), { recursive: true });

    const browser = await chromium.launch({
      ...whichBrowser(),
      args: PROXY_ONLY,
      chromiumSandbox: true,
      env: safeEnv(),
      // Shrok's own shutdown closes the browser. Playwright's handlers would close it and exit the process on
      // SIGINT before Shrok closes SimpleX and its databases.
      handleSIGHUP: false,
      handleSIGINT: false,
      handleSIGTERM: false,
      headless: true,
      proxy: this.#publicWeb.proxy,
    });

    try {
      return await this.#initialize(browser);
    } catch (error) {
      // Keep the setup error, but never lose the handle to a partially initialized browser.
      await browser.close().catch(() => {
        report(
          "browser",
          "Browser cleanup failed after initialization failed."
        );
      });
      throw error;
    }
  }

  async #initialize(browser: Browser): Promise<Open> {
    const cdp = await browser.newBrowserCDPSession();

    const { userAgent } = Value.Parse(
      VersionResponse,
      await cdp.send("Browser.getVersion")
    );

    await cdp.detach();

    const context = await browser.newContext({
      locale,
      storageState: this.#loadState(),
      timezoneId: timeZone,
      userAgent: userAgent.replaceAll(HEADLESS, "Chrome"),
    });

    await context.addInitScript(() => {
      globalThis.__shrokChanged = performance.now();
      new MutationObserver(() => {
        globalThis.__shrokChanged = performance.now();
      }).observe(document, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
    });

    context.setDefaultTimeout(ACTION_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

    const page = await context.newPage();
    const pending = new Set<Request>();

    page.on("request", (request) => {
      if (DATA_REQUESTS.has(request.resourceType())) {
        pending.add(request);
      }
    });
    page.on("requestfinished", (request) => pending.delete(request));
    page.on("requestfailed", (request) => pending.delete(request));
    inFlight.set(page, pending);

    return { browser, context, page };
  }
}

const QuietResponse = Type.Object({
  changed: Type.Number(),
  now: Type.Number(),
});

/**
 * Waits until the page has not changed for QUIET_MS and has no data request in flight, at most SETTLE_CAP_MS, and
 * returns how long it waited. Some pages load new content about a second after a click with the page still, so a
 * quiet page alone is not settled. Exported for tools built on the browser session.
 *
 * @public
 */
export const settle = async (page: Page): Promise<number> => {
  const start = Date.now();

  while (Date.now() - start < SETTLE_CAP_MS) {
    // oxlint-disable-next-line no-await-in-loop
    await page.waitForTimeout(POLL_MS);

    const { changed, now } = Value.Parse(
      QuietResponse,
      // oxlint-disable-next-line no-await-in-loop
      await page
        .evaluate(() => ({
          changed: globalThis.__shrokChanged ?? 0,
          now: performance.now(),
        }))
        .catch(() => ({ changed: performance.now(), now: 0 }))
    );

    if (now - changed >= QUIET_MS && (inFlight.get(page)?.size ?? 0) === 0) {
      break;
    }
  }

  return Date.now() - start;
};

const text = (value: string) => ({
  output: [{ text: value, type: "text" as const }],
});

interface SnapshotNode {
  readonly children: SnapshotNode[];
  readonly line: string;
}

const parseSnapshot = (tree: string): SnapshotNode => {
  const root: SnapshotNode = { children: [], line: "" };

  const open: { indent: number; node: SnapshotNode }[] = [
    { indent: -1, node: root },
  ];

  for (const line of tree.split("\n")) {
    const indent = line.search(NOT_SPACE);

    while ((open.at(-1)?.indent ?? -1) >= indent) {
      open.pop();
    }

    const node: SnapshotNode = { children: [], line };

    (open.at(-1)?.node ?? root).children.push(node);
    open.push({ indent, node });
  }

  return root;
};

const roleOf = (line: string) => line.replaceAll(OWN_PARTS, "").trim();

const runEnd = (children: readonly SnapshotNode[], start: number) => {
  const role = roleOf(children[start]?.line ?? "");
  let end = start + 1;

  while (end < children.length && roleOf(children[end]?.line ?? "") === role) {
    end += 1;
  }

  return end;
};

const writeTree = (
  node: SnapshotNode,
  around: string | undefined,
  out: string[]
) => {
  if (node.line !== "") {
    out.push(node.line);
  }

  const ref = REF.exec(node.line)?.groups?.ref ?? around;
  const { children } = node;

  for (let start = 0; start < children.length;) {
    const end = runEnd(children, start);
    const run = children.slice(start, end);

    if (run.length > FOLD_AT) {
      const line = run[0]?.line ?? "";
      const indent = line.slice(0, line.search(NOT_SPACE));

      const reader =
        ref === undefined
          ? ""
          : ` browser_read with ref ${ref} reads more of them.`;

      for (const child of run.slice(0, FOLD_HEAD)) {
        writeTree(child, ref, out);
      }

      out.push(
        `${indent}- [${run.length - FOLD_HEAD - FOLD_TAIL} more like these cut.${reader}]`
      );

      for (const child of run.slice(-FOLD_TAIL)) {
        writeTree(child, ref, out);
      }
    } else {
      for (const child of run) {
        writeTree(child, ref, out);
      }
    }

    start = end;
  }
};

const fold = (tree: string): string => {
  const out: string[] = [];

  writeTree(parseSnapshot(tree), undefined, out);

  return out.join("\n");
};

const cut = (tree: string): string =>
  tree.length > SNAPSHOT_CHARS
    ? `${tree.slice(0, SNAPSHOT_CHARS)}\n[cut at ${SNAPSHOT_CHARS} characters]`
    : tree;

const heading = async (page: Page) =>
  `URL: ${page.url()}\nTitle: ${await page.title()}\n\n`;

const snapshot = async (page: Page): Promise<string> =>
  `${await heading(page)}${cut(fold(await page.ariaSnapshot({ mode: "ai" })))}`;

const elementSnapshot = async (page: Page, element: Locator) => {
  const tree = await element.ariaSnapshot({ mode: "ai" });

  // Playwright resolves refs against the latest snapshot only, and an element snapshot replaces it.
  await page.ariaSnapshot({ mode: "ai" });

  return `${await heading(page)}${cut(tree)}`;
};

/**
 * The element behind a ref, or undefined when the page no longer has it. Playwright numbers refs per loaded document
 * (`f3e12`), so a ref from before a page load throws "Invalid frame" and one from before a re-render matches nothing.
 */
const find = async (page: Page, ref: string) => {
  const element = page.getByRef(ref);
  const matches = await element.count().catch(() => 0);

  return matches === 1 ? element : undefined;
};

const GRID = [0.5, 0.25, 0.75, 0.1, 0.9] as const;

/**
 * A point inside the element that a click would really land on. Playwright aims at the middle, and some sites put
 * a hidden 1px input there, which takes the click and ignores it.
 */
const clickPoint = async (element: Locator) => {
  await element.scrollIntoViewIfNeeded();

  return await element.evaluate((node, fractions) => {
    const box = node.getBoundingClientRect();

    for (const fy of fractions) {
      for (const fx of fractions) {
        const x = box.left + box.width * fx;
        const y = box.top + box.height * fy;
        const hit = node.ownerDocument.elementFromPoint(x, y);

        if (hit !== null && node.contains(hit)) {
          return { x: x - box.left, y: y - box.top };
        }
      }
    }

    return null;
  }, GRID);
};

/**
 * Exported for tools built on the browser session.
 *
 * @public
 */
export const clickElement = async (element: Locator) => {
  const position = await clickPoint(element);

  // Nothing inside the element takes the click when an overlay covers all of it. A tap there still reaches the
  // control under it, as on a pay-later option, so click through like a tap.
  await element.click(position === null ? { force: true } : { position });
};

/**
 * Words on a control that books, buys, pays, signs up or sends. A click on one waits for the owner's /yes.
 * They match anywhere in the control's text, so "Pay $19.99" and "Place your order" count, whatever the role.
 */
const COMMIT_WORDS =
  /\b(?:pay|payment|buy|order|purchase|book|booking|checkout|check out|subscribe|donate|reserve|rent|upgrade|trial|confirm|submit|send|complete|sign up|register|enroll|join|bid)\b/iu;

const MAX_LABEL_CHARS = 120;
const MAX_AROUND_CHARS = 2000;
const MAX_SHOWN_AROUND_CHARS = 500;

interface Commit {
  readonly label: string;
  /** The site the control is on, which differs from the page's when it sits in an embedded frame. */
  readonly site: string;
  /** The text and field values of the form or dialog around the control, as the owner approves them. */
  readonly around: string;
}

// An element ariaSnapshot would replace the page's refs, so read the control in the page instead.
// Refs reach into frames, so this also sees a pay button inside an embedded payment frame.
const commitButton = async (element: Locator): Promise<Commit | null> => {
  const control = await element.evaluate((node) => {
    const target =
      node.closest(
        "a, button, input, select, summary, [role=button], [role=link], [role=menuitem], [role=option], [role=tab]"
      ) ?? node;

    const parts = [
      target.getAttribute("aria-label"),
      target.getAttribute("title"),
      target.getAttribute("value"),
      target.textContent,
      ...(target.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/u)
        .filter(Boolean)
        .map(
          (id) =>
            target.ownerDocument.querySelector(`#${CSS.escape(id)}`)
              ?.textContent
        ),
      ...[...target.querySelectorAll("img[alt]")].map((image) =>
        image.getAttribute("alt")
      ),
    ];

    // A button in a form submits it unless its type says otherwise, whatever its text.
    const submits =
      target.matches(
        "input[type=submit], input[type=image], button:not([type=button]):not([type=reset])"
      ) && target.closest("form") !== null;

    const area =
      target.closest("form, dialog, [role=dialog]") ??
      target.ownerDocument.querySelector("main") ??
      target.ownerDocument.body;

    // Field values without passwords and card codes, which must not reach the approval details.
    const fields = [
      ...area.querySelectorAll("input, select, textarea"),
    ].flatMap((field) =>
      field.getAttribute("type") === "password" ||
      /^cc-(?:number|csc)$/u.test(field.getAttribute("autocomplete") ?? "")
        ? []
        : [
            `${field.getAttribute("name") ?? field.getAttribute("aria-label") ?? ""}=${"value" in field ? String(field.value) : ""}`,
          ]
    );

    return {
      around: [area.textContent ?? "", ...fields].join(" "),
      label: parts.filter(Boolean).join(" "),
      site: target.ownerDocument.location.host,
      submits,
    };
  });

  const label = control.label.replaceAll(/\s+/gu, " ").trim();

  if (!control.submits && !COMMIT_WORDS.test(label)) {
    return null;
  }

  return {
    around: control.around
      .replaceAll(/\s+/gu, " ")
      .trim()
      .slice(0, MAX_AROUND_CHARS),
    label: (label === "" ? "submit" : label).slice(0, MAX_LABEL_CHARS),
    site: control.site,
  };
};

const gone = async (page: Page, ref: string) =>
  text(
    `Ref ${ref} is not on the page any more: the page changed since that read. Use a ref from this one.\n\n${await snapshot(page)}`
  );

const ElementParameters = {
  element: Type.String({
    description:
      "What the element is, in a few words, such as: the Book button for 10:00. Shown when asking the user.",
  }),
  ref: Type.String({
    description: "The element's ref from the latest snapshot, such as e12",
  }),
};

export const createBrowserTools = (
  stateFile: string,
  publicWeb: PublicWeb,
  approvals: Approvals,
  seenUrls: SeenUrls
) => {
  const session = new Session(stateFile, publicWeb);

  // Sites the owner let Shrok type on. A page can send what is typed into it to its site at once.
  const typingHosts = new Set<string>();

  const shown = (value: string) => {
    seenUrls.noteSnapshot(value);

    return text(value);
  };

  const settled = async (page: Page) => {
    const settleMs = await settle(page);

    await session.save();

    return { ...shown(await snapshot(page)), details: { settleMs } };
  };

  return {
    check: async () => {
      await session.check();
    },
    close: async () => {
      await session.close();
    },
    page: async () => await session.page(),
    save: async () => {
      await session.save();
    },
    tools: [
      defineTool({
        description:
          "Open a web page in the browser and read it. Use for pages that need clicking, such as booking sites; for reading an article use web_fetch. An address that neither the owner nor a tool gave waits for his /yes.",
        execute: async (args, api, context) => {
          const page = await session.page();

          await seenUrls.open(
            api,
            "browser_open",
            args.url,
            async () => {
              await page.goto(publicUrl(args.url), {
                waitUntil: "domcontentloaded",
              });
            },
            context
          );

          return await settled(page);
        },
        name: "browser_open",
        parameters: Type.Object({ url: Type.String() }),
      }),
      defineTool({
        description:
          "Read the page open in the browser again, such as after waiting for it to update. With a ref, read that element in full, including the parts a long list had cut.",
        execute: async (args) => {
          const page = await session.page();

          if (args.ref === undefined) {
            return shown(await snapshot(page));
          }

          const element = await find(page, args.ref);

          return element === undefined
            ? await gone(page, args.ref)
            : shown(await elementSnapshot(page, element));
        },
        name: "browser_read",
        parameters: Type.Object({
          ref: Type.Optional(
            Type.String({
              description:
                "The ref of an element to read in full, such as the one a cut list names",
            })
          ),
        }),
        replay: "safe",
      }),
      defineTool({
        description:
          "Click an element on the page open in the browser, by its ref from the latest snapshot. A button that submits a form, or a control that books, buys, pays, orders, subscribes, signs up, confirms or sends, waits for the owner's /yes.",
        execute: async (args, api, context) => {
          const page = await session.page();
          const element = await find(page, args.ref);

          if (element === undefined) {
            return await gone(page, args.ref);
          }

          if ((await commitButton(element)) === null) {
            await clickElement(element);

            return await settled(page);
          }

          const prepare = async () => {
            const target = await find(page, args.ref);

            const button =
              target === undefined ? null : await commitButton(target);

            if (target === undefined || button === null) {
              throw new Error(
                "The page changed while waiting for approval. Read it again before asking."
              );
            }

            const url = page.url();
            const { host } = new URL(url);

            const site =
              button.site === host ? host : `${button.site}, inside ${host}`;

            // The text around the button, such as the cart and its total, is rechecked after /yes, so the
            // click fails if the page changed what the owner approved.
            return {
              adapter: "browser-commit-v1" as const,
              arguments: args,
              expectedState: { around: button.around, button: button.label },
              identity: { title: await page.title(), url },
              payload: {},
              resource: { site },
              summary: `press ${JSON.stringify(button.label)} on ${site}: ${args.element}\n\nThe page around it says: ${button.around.slice(0, MAX_SHOWN_AROUND_CHARS)}${button.around.length > MAX_SHOWN_AROUND_CHARS ? " (cut here; the rest is in the attached details)" : ""}`,
              tool: "browser_click" as const,
            };
          };

          await approvals.execute(
            api,
            prepare,
            async () => {
              const target = await find(page, args.ref);

              if (target === undefined) {
                throw new Error("The approved button is gone.");
              }

              await clickElement(target);
            },
            context.abortSignal
          );

          return await settled(page);
        },
        name: "browser_click",
        parameters: Type.Object(ElementParameters),
      }),
      defineTool({
        description:
          "Type into a text field on the page open in the browser, replacing what it holds. This never presses Enter or submits a form. Use browser_click for submission buttons, checkboxes and radios. The first time on each site waits for the owner's /yes.",
        execute: async (args, api, context) => {
          const page = await session.page();
          const field = await find(page, args.ref);

          if (field === undefined) {
            return await gone(page, args.ref);
          }

          const { host } = new URL(page.url());

          if (!typingHosts.has(host)) {
            await approvals.execute(
              api,
              () => ({
                adapter: "browser-type-v1" as const,
                arguments: { host },
                expectedState: {},
                identity: {},
                payload: {},
                resource: { site: host },
                summary: `type into pages on ${host} until Shrok restarts, starting with ${args.element}`,
                tool: "browser_type" as const,
              }),
              () => {
                typingHosts.add(host);
              },
              context.abortSignal
            );
          }

          await field.fill(args.text);

          return await settled(page);
        },
        name: "browser_type",
        parameters: Type.Object({
          ...ElementParameters,
          text: Type.String(),
        }),
      }),
    ],
  };
};
