import type { Context } from "@earendil-works/chord";

import type { Approvals } from "./approvals.ts";

interface Call {
  readonly taskId: number;
  readonly conversationId: number;
  readonly callId: string;
}

const MAX_SEEN = 50_000;
const ABSOLUTE = /https?:\/\/[^\s<>"'`)\]}|]+/giu;
const MARKDOWN_LINK = /\]\((?<link>[^\s)]+)\)/gu;
const SNAPSHOT_LINK = /\/url: (?<link>\S+)/gu;
const PAGE_URL = /^URL: (?<url>\S+)$/mu;
const TRAILING = /[.,;:!?'"]+$/u;

const canonical = (url: string, base?: string): string | undefined => {
  try {
    const parsed = new URL(url, base);

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }

    parsed.hash = "";

    return parsed.href;
  } catch {
    return undefined;
  }
};

/**
 * Web addresses the owner sent or a tool showed. web_fetch and browser_open open these without asking.
 * Any other address was written by the model, and so could carry private data it read to a third party
 * in its path or query. Opening one waits for the owner's /yes to the exact address.
 */
export class SeenUrls {
  readonly #urls = new Set<string>();
  readonly #approvals: Approvals;

  constructor(approvals: Approvals) {
    this.#approvals = approvals;
  }

  /** Notes every address in text from the owner or a web page. `base` resolves the page's relative links. */
  note(text: string, base?: string): void {
    this.#add([
      ...[...text.matchAll(ABSOLUTE)].map(([url]) =>
        canonical(url.replace(TRAILING, ""))
      ),
      ...[...text.matchAll(MARKDOWN_LINK)].map((match) =>
        canonical(match.groups?.link ?? "", base)
      ),
    ]);
  }

  /**
   * Notes the page and its link targets in a browser snapshot. Other text there can repeat what the model
   * typed into a field, so it does not count.
   */
  noteSnapshot(snapshot: string): void {
    const page = PAGE_URL.exec(snapshot)?.groups?.url;

    if (page === undefined) {
      return;
    }

    this.#add([
      canonical(page),
      ...[...snapshot.matchAll(SNAPSHOT_LINK)].map((match) =>
        canonical(match.groups?.link ?? "", page)
      ),
    ]);
  }

  #add(found: readonly (string | undefined)[]): void {
    for (const url of found) {
      if (url !== undefined) {
        this.#urls.delete(url);
        this.#urls.add(url);
      }
    }

    for (const oldest of this.#urls) {
      if (this.#urls.size <= MAX_SEEN) {
        break;
      }

      this.#urls.delete(oldest);
    }
  }

  /** Runs `open` for `url` at once if it was seen, or after the owner's /yes to it otherwise. */
  async open<T>(
    call: Call,
    tool: "web_fetch" | "browser_open",
    url: string,
    open: () => Promise<T>,
    context: Context
  ): Promise<T> {
    const href = canonical(url);

    if (href !== undefined && this.#urls.has(href)) {
      return await open();
    }

    let opened: { value: T } | undefined;

    await this.#approvals.execute(
      call,
      () => ({
        adapter: "web-open-v1" as const,
        arguments: { url },
        expectedState: {},
        identity: {},
        payload: {},
        resource: { url },
        summary: `open an address that neither you nor a page gave me: ${url}`,
        tool,
      }),
      async () => {
        opened = { value: await open() };
      },
      context.abortSignal
    );

    if (opened === undefined) {
      throw new Error(`${url} was not opened.`);
    }

    return opened.value;
  }
}
