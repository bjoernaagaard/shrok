import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import type { Brain } from "./brain.ts";
import { report } from "./events.ts";
import type { Notify } from "./schedules.ts";
import { shareMessage } from "./shares.ts";

const CHECK_MS = 10 * 60 * 1000;
const MAX_TRIES = 5;

const LABEL = "🔗 _From Save Link_";

const linksIn = (text: string): string[] => {
  const links = text.split("\n").flatMap((line) => {
    const url = URL.parse(line.trim());

    return url?.protocol === "https:" || url?.protocol === "http:"
      ? [line.trim()]
      : [];
  });

  return [...new Set(links)];
};

/** Each try of a link has its own request ID, so a try that went unanswered, such as on a rate limit, can be made again. */
const tryId = (url: string, attempt: number): string =>
  attempt === 1 ? `links:${url}` : `links:${url}#${attempt}`;

/**
 * Saves each new link in `file`, checking it every ten minutes. A link counts as saved once one try was answered;
 * the request IDs make that hold across restarts. Returns how to stop.
 */
export const watchLinks = (
  file: string,
  brain: Pick<Brain, "answer" | "settled">,
  notify: Notify
): (() => void) => {
  const stopped = new AbortController();

  /** The next try to make for a link, or undefined when it is saved or out of tries. */
  const nextTry = async (url: string): Promise<number | undefined> => {
    for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- tries are looked up in order until the first unmade one
      const settled = await brain.settled(tryId(url, attempt));

      if (settled === "done") {
        return undefined;
      }

      if (settled === undefined) {
        return attempt;
      }
    }

    return undefined;
  };

  const check = async (): Promise<void> => {
    for (const url of linksIn(await readFile(file, "utf-8"))) {
      // oxlint-disable-next-line no-await-in-loop -- one link at a time, so a burst doesn't hit rate limits
      const attempt = await nextTry(url);

      if (stopped.signal.aborted || attempt === undefined) {
        continue;
      }

      const at = new Date();

      // oxlint-disable-next-line no-await-in-loop
      const answer = await brain.answer(
        shareMessage({ kind: "link", preview: "", text: url, title: "", url }),
        tryId(url, attempt),
        at
      );

      // oxlint-disable-next-line no-await-in-loop
      if ((await brain.settled(tryId(url, attempt))) !== "done") {
        report(
          "links",
          `Shrok could not save ${url} on try ${attempt} of ${MAX_TRIES}.`
        );

        continue;
      }

      try {
        // oxlint-disable-next-line no-await-in-loop
        await notify(`${LABEL}\n\n${answer}`, at);
      } catch (error) {
        report(
          "links",
          `Shrok saved ${url} but could not say so: ${String(error)}`
        );
      }
    }
  };

  const loop = async (): Promise<void> => {
    while (!stopped.signal.aborted) {
      try {
        // oxlint-disable-next-line no-await-in-loop
        await check();
      } catch (error) {
        if (!stopped.signal.aborted) {
          report(
            "links",
            `Shrok could not save from ${file}: ${String(error)}`
          );
        }
      }

      try {
        // oxlint-disable-next-line no-await-in-loop
        await sleep(CHECK_MS, undefined, { signal: stopped.signal });
      } catch {
        break;
      }
    }
  };

  void loop();

  return () => {
    stopped.abort();
  };
};
