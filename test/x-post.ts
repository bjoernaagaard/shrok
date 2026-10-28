import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { REPLY_BUDGET_MS, Session, StageFailedError } from "./shrok.ts";

const POST =
  "https://x.com/kr0der/status/2106429105671643587?s=46&t=kEBcxZxM8ciCA_idlEKETw";

const FULL_TEXT_ONLY = "Coordinator updates";
const ASKS = "*Shrok wants to:*";

const session = await Session.open("x-post");
const itemsDir = path.join(session.dataDir, "workspace", "items");

const reads = (): number =>
  session.toolCalls().filter((tool) => tool === "x_read_post").length;

const share = async (stage: string): Promise<string> => {
  const shared = await session.share(POST);

  const answer = await session.waitFor(
    stage,
    shared,
    REPLY_BUDGET_MS,
    (text) => !text.startsWith(ASKS)
  );

  const asks = session.messages
    .slice(shared)
    .filter((message) => message.text.startsWith(ASKS));

  if (asks.length > 0) {
    throw new StageFailedError(
      stage,
      `reading the post asked for approval: ${asks[0]?.text ?? ""}`
    );
  }

  return answer.text;
};

await session.finish("x-post", async () => {
  await session.start();

  const firstAnswer = await share("first share");

  if (reads() !== 1) {
    throw new StageFailedError(
      "first share",
      `expected one x_read_post, got: ${session.toolCalls().join(", ")}`
    );
  }

  const saved = await readdir(itemsDir);
  const files = saved.filter((name) => name.endsWith(".md"));

  const items = await Promise.all(
    files.map(
      async (name) => await readFile(path.join(itemsDir, name), "utf-8")
    )
  );

  const item = items.find((text) => text.includes(FULL_TEXT_ONLY));

  if (item === undefined) {
    throw new StageFailedError(
      "first share",
      `no saved item holds the post's full text (${files.length} items saved)`
    );
  }

  const secondAnswer = await share("second share");

  if (reads() !== 1) {
    throw new StageFailedError(
      "second share",
      `the post was read from X again: ${session.toolCalls().join(", ")}`
    );
  }

  return {
    firstAnswer,
    item,
    secondAnswer,
    tools: session.toolCalls(),
  };
});
