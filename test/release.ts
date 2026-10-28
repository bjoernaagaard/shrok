import { cp, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { REPLY_BUDGET_MS, Session, StageFailedError } from "./shrok.ts";

/**
 * Drives one installed artifact the way an owner would: pair it with shrok pair, send a message, use the
 * browser, restart it, then stop it, back up its data folder, restore the backup and talk to it again.
 *   SHROK_COMMAND=/opt/shrok/bin/shrok RELEASE_ARTIFACT=deb-arm64 node test/release.ts
 */
const ARTIFACT = process.env.RELEASE_ARTIFACT ?? "checkout";
const WORD = "pineapple";

const session = await Session.open(`release-${ARTIFACT}`);

const ask = async (
  stage: string,
  text: string,
  expected: string
): Promise<string> => {
  const since = await session.send(text);

  const reply = await session.waitFor(stage, since, REPLY_BUDGET_MS, (answer) =>
    answer.toLowerCase().includes(expected.toLowerCase())
  );

  return reply.text;
};

await session.finish(`release-${ARTIFACT}`, async () => {
  await session.start();

  const message = await ask(
    "message",
    `Reply with exactly one word: ${WORD}`,
    WORD
  );

  const browser = await ask(
    "browser",
    "Open https://example.com with browser_open and tell me the page title.",
    "Example Domain"
  );

  if (!session.toolCalls().includes("browser_open")) {
    throw new StageFailedError(
      "browser",
      "Shrok answered without using browser_open"
    );
  }

  await session.stop();
  await session.start();

  const restarted = await ask(
    "restart",
    `After the restart, reply with exactly one word: ${WORD}`,
    WORD
  );

  await session.stop();

  const backup = `${session.dataDir}-backup`;

  await cp(session.dataDir, backup, { recursive: true });
  await rm(session.dataDir, { force: true, recursive: true });
  await cp(backup, session.dataDir, { recursive: true });
  await rm(backup, { force: true, recursive: true });
  await session.start();

  const restored = await ask(
    "restore",
    `From the restored backup, reply with exactly one word: ${WORD}`,
    WORD
  );

  return {
    artifact: ARTIFACT,
    browser,
    command: process.env.SHROK_COMMAND ?? path.join("src", "cli.ts"),
    message,
    restarted,
    restored,
  };
});
