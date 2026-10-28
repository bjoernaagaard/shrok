import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import type { Brain } from "./brain.ts";
import { report } from "./events.ts";
import type { Notify } from "./schedules.ts";
import { shareMessage } from "./shares.ts";

const CHECK_MS = 10 * 60 * 1000;

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

/** The request ID is the link, so each link is saved once across restarts. Returns how to stop. */
export const watchLinks = (
  file: string,
  brain: Pick<Brain, "answer" | "finished">,
  notify: Notify
): (() => void) => {
  const stopped = new AbortController();

  const check = async (): Promise<void> => {
    for (const url of linksIn(await readFile(file, "utf-8"))) {
      const requestId = `links:${url}`;

      // oxlint-disable-next-line no-await-in-loop
      if (stopped.signal.aborted || (await brain.finished(requestId))) {
        continue;
      }

      const at = new Date();

      // oxlint-disable-next-line no-await-in-loop
      const answer = await brain.answer(
        shareMessage({ kind: "link", preview: "", text: url, title: "", url }),
        requestId,
        at
      );

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
