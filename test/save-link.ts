import {
  appendFile,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { REPLY_BUDGET_MS, Session, StageFailedError } from "./shrok.ts";

const POST =
  "https://x.com/kr0der/status/2106429105671643587?s=46&t=kEBcxZxM8ciCA_idlEKETw";

const PAGE = "https://data-star.dev/guide/getting_started";
const LATER = "https://mkdir.directory/";

const FULL_TEXT_ONLY = "Coordinator updates";
const LABEL = "🔗 _From Save Link_";

const FIRST_CHECK_MS = 300_000;

const LINKS_CHECK_MS = 10 * 60_000;
const NEXT_CHECK_MS = LINKS_CHECK_MS + 60_000;
const QUIET_MS = 90_000;
const POLL_MS = 5000;

const session = await Session.open("save-link");
const itemsDir = path.join(session.dataDir, "workspace", "items");

const linksFile = path.join(
  await mkdtemp(path.join(tmpdir(), "shrok-save-link-")),
  "links.md"
);

session.linksFile = linksFile;

const savedItems = async (): Promise<string[]> => {
  const names = await readdir(itemsDir).catch(() => []);
  const files = names.filter((name) => name.endsWith(".md"));

  return await Promise.all(
    files.map(
      async (name) => await readFile(path.join(itemsDir, name), "utf-8")
    )
  );
};

const waitForItem = async (
  stage: string,
  budget: number,
  matches: (item: string) => boolean
): Promise<string> => {
  const deadline = Date.now() + budget;

  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop
    const items = await savedItems();
    const found = items.find(matches);

    if (found !== undefined) {
      return found;
    }

    // oxlint-disable-next-line no-await-in-loop
    await sleep(POLL_MS);
  }

  throw new StageFailedError(stage, `no matching item within ${budget} ms`);
};

const reads = (): number =>
  session.toolCalls().filter((tool) => tool === "x_read_post").length;

const reports = (): number =>
  session.messages.filter((message) => message.text.startsWith(LABEL)).length;

await session.finish("save-link", async () => {
  await writeFile(linksFile, `${POST}\n\n${PAGE}\n`);
  await session.start();

  const post = await waitForItem("first check", FIRST_CHECK_MS, (item) =>
    item.includes(FULL_TEXT_ONLY)
  );

  const page = await waitForItem(
    "first check",
    FIRST_CHECK_MS,
    (item) =>
      item.includes("source: https://data-star.dev/") &&
      item.includes("kind: link")
  );

  if (reads() !== 1) {
    throw new StageFailedError(
      "first check",
      `expected one x_read_post, got: ${session.toolCalls().join(", ")}`
    );
  }

  const appendedAt = Date.now();
  const beforeAppend = session.messages.length;

  await appendFile(linksFile, `${LATER}\n`);

  const later = await waitForItem("next check", NEXT_CHECK_MS, (item) =>
    item.includes("source: https://mkdir.directory")
  );

  const laterSeconds = Math.round((Date.now() - appendedAt) / 1000);

  const laterReport = await session.waitFor(
    "next check",
    beforeAppend,
    REPLY_BUDGET_MS,
    (text) => text.startsWith(LABEL) && text.includes("mkdir")
  );

  const saved = await savedItems();
  const reported = reports();

  await session.stop();
  await session.start();
  await sleep(QUIET_MS);

  if (reads() !== 1 || reports() !== reported) {
    throw new StageFailedError(
      "restart",
      `the restart handled saved links again: ${session.toolCalls().join(", ")}`
    );
  }

  const afterRestart = await savedItems();

  if (afterRestart.length !== saved.length) {
    throw new StageFailedError("restart", "the restart saved another item");
  }

  return {
    laterItem: later,
    laterReport: laterReport.text,
    laterSeconds: String(laterSeconds),
    linksFile: await readFile(linksFile, "utf-8"),
    pageItem: page,
    postItem: post,
    tools: session.toolCalls(),
  };
});
