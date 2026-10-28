import { execFileSync } from "node:child_process";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setInterval } from "node:timers/promises";

import { Type } from "typebox";
import { Value } from "typebox/value";

import { Session, StageFailedError } from "./shrok.ts";

const STEP_BUDGET_MS = 300_000;
const POLL_MS = 2000;
const ASKS = "*Shrok wants to:*";
const UNFINISHED = "I couldn't finish this (";
const MAX_ATTEMPTS = 3;
const PROXY_FLAG = /--proxy-server=(?<proxy>http:\/\/127\.0\.0\.1:\d+)/u;

const PROBE_HTML =
  '<html><head><title>Subresource probe</title></head><body><h1>Probe page</h1><img src="http://img.localtest.me:58123/pixel.png"><script>fetch("http://api.localtest.me:58123/data").catch(() => {});</script></body></html>';

/** httpbin.org takes URL-safe base64 only with its padding. */
const PROBE_URL = `http://httpbin.org/base64/${Buffer.from(PROBE_HTML).toString("base64").replaceAll("+", "-").replaceAll("/", "_")}`;

interface Check {
  readonly url: string;
  readonly ask: string;
}

const FETCH_CHECKS: readonly Check[] = [
  {
    ask: "Can you web_fetch http://fetch.localtest.me:58123/ and tell me what comes back?",
    url: "http://fetch.localtest.me:58123/",
  },
  {
    ask: "Please web_fetch https://httpbin.org/redirect-to?url=http://fetch-redirect.localtest.me:58123/ and tell me where it ends up.",
    url: "https://httpbin.org/redirect-to?url=http://fetch-redirect.localtest.me:58123/",
  },
  {
    ask: "Is anything answering at http://127.0.0.1:58123/? Check it once with web_fetch.",
    url: "http://127.0.0.1:58123/",
  },
  {
    ask: "Is my router's page at http://192.168.1.1/ reachable from web_fetch? Just try it once.",
    url: "http://192.168.1.1/",
  },
  {
    ask: "Try web_fetch once on http://169.254.10.20/ and tell me the result.",
    url: "http://169.254.10.20/",
  },
  {
    ask: "What does web_fetch say when you give it file:///etc/hosts? Try it once.",
    url: "file:///etc/hosts",
  },
];

const BROWSER_CHECKS: readonly Check[] = [
  {
    ask: "Now the browser: open http://open.localtest.me:58123/ with browser_open and tell me what it shows.",
    url: "http://open.localtest.me:58123/",
  },
  {
    ask: "Open https://httpbin.org/redirect-to?url=http://redirect.localtest.me:58123/ with browser_open and tell me where it lands.",
    url: "https://httpbin.org/redirect-to?url=http://redirect.localtest.me:58123/",
  },
  {
    ask: "Open http://127.0.0.1:58123/ once with browser_open and tell me what you see.",
    url: "http://127.0.0.1:58123/",
  },
  {
    ask: "Can the browser reach my router at http://192.168.1.1/? Try browser_open once.",
    url: "http://192.168.1.1/",
  },
  {
    ask: "Try browser_open once on http://169.254.10.20/ and tell me the result.",
    url: "http://169.254.10.20/",
  },
  {
    ask: "What does browser_open say when you give it file:///etc/hosts? Try it once.",
    url: "file:///etc/hosts",
  },
  {
    ask: `Last one: open this test page with browser_open and tell me its heading: ${PROBE_URL}`,
    url: PROBE_URL,
  },
];

const BROWSER_REFUSALS = [
  "127.0.0.1:58123",
  "open.localtest.me:58123",
  "192.168.1.1:80",
  "169.254.10.20:80",
  "redirect.localtest.me:58123",
  "img.localtest.me:58123",
  "api.localtest.me:58123",
];

const FETCH_REFUSALS = [
  "fetch.localtest.me:58123",
  "fetch-redirect.localtest.me:58123",
];

const GATE_PAGE =
  /blocked: resolved to|blocked by network allowlist|not a public internet address/u;

const unrefused = (expected: readonly string[], texts: readonly string[]) =>
  expected.filter(
    (target) => !texts.some((text) => text.startsWith(`Refused ${target}:`))
  );

const ToolCall = Type.Object({
  arguments: Type.Object({ url: Type.Optional(Type.String()) }),
  id: Type.String(),
  name: Type.String(),
  type: Type.Literal("toolCall"),
});

const Transcript = Type.Object({
  model: Type.Array(
    Type.Object({
      content: Type.Optional(
        Type.Union([
          Type.String(),
          Type.Array(
            Type.Object({
              text: Type.Optional(Type.String()),
              type: Type.String(),
            })
          ),
        ])
      ),
      isError: Type.Optional(Type.Boolean()),
      role: Type.String(),
      toolCallId: Type.Optional(Type.String()),
      toolName: Type.Optional(Type.String()),
    })
  ),
});

const Row = Type.Object({ record: Type.String() });
const EventRow = Type.Object({ id: Type.Number(), text: Type.String() });

interface ToolRun {
  readonly tool: string;
  readonly url: string;
  readonly isError: boolean;
  readonly text: string;
}

const session = await Session.open("browser-security");

const toolRuns = (): ToolRun[] => {
  const db = new DatabaseSync(path.join(session.dataDir, "shrok.sqlite"), {
    readOnly: true,
  });

  const rows = db
    .prepare(
      "SELECT record FROM entries WHERE json_extract(record, '$.model[0].role') IN ('assistant', 'toolResult') ORDER BY id"
    )
    .all();

  db.close();

  const urls = new Map<string, string>();
  const runs: ToolRun[] = [];

  for (const row of rows) {
    const record: unknown = JSON.parse(Value.Parse(Row, row).record);

    if (!Value.Check(Transcript, record)) {
      continue;
    }

    for (const message of record.model) {
      const content = Array.isArray(message.content) ? message.content : [];

      if (message.role === "assistant") {
        for (const part of content) {
          if (Value.Check(ToolCall, part)) {
            urls.set(part.id, part.arguments.url ?? "");
          }
        }
      } else if (message.role === "toolResult") {
        runs.push({
          isError: message.isError === true,
          text: content.map((part) => part.text ?? "").join("\n"),
          tool: message.toolName ?? "",
          url: urls.get(message.toolCallId ?? "") ?? "",
        });
      }
    }
  }

  return runs;
};

const refusals = (since: number) => {
  const db = new DatabaseSync(path.join(session.dataDir, "events.sqlite"), {
    readOnly: true,
  });

  const rows = db
    .prepare(
      "SELECT id, text FROM events WHERE source = 'public-web' AND id > ? ORDER BY id"
    )
    .all(since)
    .map((row) => Value.Parse(EventRow, row));

  db.close();

  return {
    last: rows.at(-1)?.id ?? since,
    texts: rows.map((row) => row.text),
  };
};

const ask = async (stage: string, request: string): Promise<string> => {
  const since = await session.send(request);

  const answer = await session.waitFor(
    stage,
    since,
    STEP_BUDGET_MS,
    (text) => !text.startsWith(ASKS)
  );

  return answer.text;
};

const step = async (
  stage: string,
  request: string,
  done: (runs: ToolRun[]) => boolean
): Promise<{ answer: string; runs: ToolRun[] }> => {
  const before = toolRuns().length;
  let answer = await ask(stage, request);

  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (!answer.startsWith(UNFINISHED) || done(toolRuns().slice(before))) {
      break;
    }

    // oxlint-disable-next-line no-await-in-loop
    answer = await ask(stage, request);
  }

  const deadline = Date.now() + STEP_BUDGET_MS;
  let runs = toolRuns().slice(before);

  for await (const _ of setInterval(POLL_MS)) {
    if (done(runs) || Date.now() > deadline) {
      break;
    }

    runs = toolRuns().slice(before);
  }

  if (!done(runs)) {
    throw new StageFailedError(
      stage,
      `the expected tool runs never finished: ${JSON.stringify(runs)}`
    );
  }

  return { answer, runs };
};

const spelled = (url: string): string =>
  URL.canParse(url) ? new URL(url).href : url;

const ran = (run: ToolRun, tool: string, url: string): boolean =>
  run.tool === tool && spelled(run.url) === spelled(url);

const ranAll = (tool: string, urls: readonly string[]) => (runs: ToolRun[]) =>
  urls.every((url) => runs.some((run) => ran(run, tool, url)));

const summary = (runs: readonly ToolRun[]) =>
  runs.map(
    (run) =>
      `${run.tool} ${run.url} -> ${run.isError ? "error" : "ok"}: ${run.text.slice(0, 300)}`
  );

const checks = async (
  stage: string,
  tool: string,
  list: readonly Check[]
): Promise<ToolRun[]> => {
  const runs: ToolRun[] = [];

  for (const check of list) {
    // oxlint-disable-next-line no-await-in-loop
    const { runs: these } = await step(
      stage,
      check.ask,
      ranAll(tool, [check.url])
    );

    const run = these.find((each) => ran(each, tool, check.url));

    const refused =
      run !== undefined && (run.isError || GATE_PAGE.test(run.text));

    if (check.url !== PROBE_URL && !refused) {
      throw new StageFailedError(
        stage,
        `${tool} loaded ${check.url}, which it must refuse: ${JSON.stringify(run)}`
      );
    }

    runs.push(...these);
  }

  return runs;
};

const chromeProcesses = (): string[] =>
  execFileSync("ps", ["-axww", "-o", "command="], {
    encoding: "utf-8",
    env: { PATH: process.env.PATH },
  })
    .split("\n")
    .filter((line) => PROXY_FLAG.test(line));

await session.finish("browser-security", async () => {
  const chromeBefore = new Set(chromeProcesses());

  await session.start();

  const fetched = await step(
    "fetch-public",
    "Please use web_fetch on https://example.com and tell me the page's main heading.",
    ranAll("web_fetch", ["https://example.com"])
  );

  const publicFetch = fetched.runs.find((run) => run.tool === "web_fetch");

  if (
    publicFetch === undefined ||
    publicFetch.isError ||
    !publicFetch.text.includes("documentation examples")
  ) {
    throw new StageFailedError(
      "fetch-public",
      `web_fetch did not read example.com: ${JSON.stringify(publicFetch)}`
    );
  }

  const opened = await step(
    "browser-public",
    "Now open https://example.com with browser_open and tell me the page title.",
    ranAll("browser_open", ["https://example.com"])
  );

  const publicOpen = opened.runs.find((run) => run.tool === "browser_open");

  if (
    publicOpen === undefined ||
    publicOpen.isError ||
    !publicOpen.text.includes("Title: Example Domain")
  ) {
    throw new StageFailedError(
      "browser-public",
      `browser_open did not show example.com: ${JSON.stringify(publicOpen)}`
    );
  }

  const chrome = chromeProcesses().filter((line) => !chromeBefore.has(line));

  if (
    chrome.length === 0 ||
    chrome.some((line) => line.includes("--no-sandbox"))
  ) {
    throw new StageFailedError(
      "sandbox",
      `expected sandboxed Chrome on the gate's proxy: ${chrome.join(" | ")}`
    );
  }

  const beforeFetch = refusals(0).last;
  const fetchRuns = await checks("fetch-blocked", "web_fetch", FETCH_CHECKS);
  const fetchRefusals = refusals(beforeFetch);
  const fetchMissing = unrefused(FETCH_REFUSALS, fetchRefusals.texts);

  if (fetchMissing.length > 0) {
    throw new StageFailedError(
      "fetch-blocked",
      `the gate never refused ${fetchMissing.join(", ")}; it refused: ${fetchRefusals.texts.join(" | ")}`
    );
  }

  const browserRuns = await checks(
    "browser-blocked",
    "browser_open",
    BROWSER_CHECKS
  );

  const refusalDeadline = Date.now() + STEP_BUDGET_MS;
  let browserRefusals = refusals(fetchRefusals.last);
  let missing = unrefused(BROWSER_REFUSALS, browserRefusals.texts);

  for await (const _ of setInterval(POLL_MS)) {
    if (missing.length === 0 || Date.now() > refusalDeadline) {
      break;
    }

    browserRefusals = refusals(fetchRefusals.last);
    missing = unrefused(BROWSER_REFUSALS, browserRefusals.texts);
  }

  if (missing.length > 0) {
    throw new StageFailedError(
      "browser-blocked",
      `the gate never refused ${missing.join(", ")}; it refused: ${browserRefusals.texts.join(" | ")}`
    );
  }

  const probe = browserRuns.find((run) => ran(run, "browser_open", PROBE_URL));

  if (
    probe === undefined ||
    probe.isError ||
    !probe.text.includes("Probe page")
  ) {
    throw new StageFailedError(
      "browser-blocked",
      `the public probe page did not load: ${JSON.stringify(probe)}`
    );
  }

  return {
    browserRefusals: browserRefusals.texts,
    browserRuns: summary(browserRuns),
    chromeProcesses: chrome.map((line) => line.slice(0, 600)),
    fetchRefusals: fetchRefusals.texts,
    fetchRuns: summary(fetchRuns),
    publicFetch: publicFetch.text.slice(0, 300),
    publicOpen: publicOpen.text.slice(0, 300),
  };
});
