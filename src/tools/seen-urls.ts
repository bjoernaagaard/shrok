import type { Context } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

import { quoted } from "./approvals.ts";
import type { Approvals, Call, Outcome } from "./approvals.ts";

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

/** Where an opened page loads: the tool's own environment, or the approvals' when it opens after a /yes. */
type Open = (where: {
  readonly env: ExecutionEnv | undefined;
  readonly context: Context;
}) => Promise<string>;

/**
 * Web addresses the owner sent or a tool showed. web_fetch and browser_open open these without asking.
 * Any other address was written by the model, and so could carry private data it read to a third party
 * in its path or query. Opening one waits for the owner's /yes to the exact address, unless he allowed the site.
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

  /** Opens a seen address at once, and any other after the owner's /yes to it. */
  async open(
    call: Call & { readonly env: ExecutionEnv | undefined },
    tool: "web_fetch" | "browser_open",
    url: string,
    context: Context,
    open: Open
  ): Promise<Outcome> {
    const href = canonical(url);

    if (href !== undefined && this.#urls.has(href)) {
      return { ran: true, result: await open({ context, env: call.env }) };
    }

    const host = href === undefined ? url : new URL(href).host;

    return await this.#approvals.request(call, () => ({
      arguments: { url },
      grants: [`opening any address on ${host}`],
      run: async (where) => await open(where),
      state: {},
      summary: `open an address that neither you nor a page gave me: ${quoted(url, 2000)}`,
      tool,
    }));
  }
}
