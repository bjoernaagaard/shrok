import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  approvalId,
  isReply,
  REPLY_BUDGET_MS,
  Session,
  StageFailedError,
} from "./shrok.ts";

const POST =
  "https://x.com/kr0der/status/2106429105671643587?s=46&t=kEBcxZxM8ciCA_idlEKETw";

const FULL_TEXT_ONLY = "Coordinator updates";
const POLL_MS = 5000;

const session = await Session.open("x-post");
const itemsDir = path.join(session.dataDir, "workspace", "items");

const reads = (): number =>
  session.toolCalls().filter((tool) => tool === "x_read_post").length;

const savedPost = async (): Promise<string | undefined> => {
  const saved = await readdir(itemsDir).catch(() => []);

  const items = await Promise.all(
    saved
      .filter((name) => name.endsWith(".md"))
      .map(async (name) => await readFile(path.join(itemsDir, name), "utf-8"))
  );

  return items.find((text) => text.includes(FULL_TEXT_ONLY));
};

/** Waits until a saved item holds the post's full text, which only a read from X has. */
const waitForPost = async (stage: string): Promise<string> => {
  const deadline = Date.now() + REPLY_BUDGET_MS;

  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop
    const item = await savedPost();

    if (item !== undefined) {
      return item;
    }

    // oxlint-disable-next-line no-await-in-loop
    await sleep(POLL_MS);
  }

  throw new StageFailedError(stage, "no saved item holds the post's full text");
};

await session.finish("x-post", async () => {
  await session.start();

  // A paid read waits for the owner's /yes, as he gives it on his phone.
  const shared = await session.share(POST);

  const request = await session.waitFor(
    "first share",
    shared,
    REPLY_BUDGET_MS,
    (text) => approvalId(text) !== undefined
  );

  await session.answer(
    "first share",
    approvalId(request.text) ?? "",
    "yes",
    REPLY_BUDGET_MS
  );

  const item = await waitForPost("first share");

  if (reads() !== 1) {
    throw new StageFailedError(
      "first share",
      `expected one x_read_post, got: ${session.toolCalls().join(", ")}`
    );
  }

  // A post saved before is answered from the item, so it neither asks nor reads from X again.
  const again = await session.share(POST);

  const second = await session.waitFor(
    "second share",
    again,
    REPLY_BUDGET_MS,
    isReply
  );

  const asked = session.messages
    .slice(again)
    .some((message) => approvalId(message.text) !== undefined);

  if (asked) {
    throw new StageFailedError(
      "second share",
      "sharing a saved post asked for a paid read"
    );
  }

  const secondAnswer = second.text;

  if (reads() !== 1) {
    throw new StageFailedError(
      "second share",
      `the post was read from X again: ${session.toolCalls().join(", ")}`
    );
  }

  return {
    firstAnswer: request.text,
    item,
    secondAnswer,
    tools: session.toolCalls(),
  };
});
