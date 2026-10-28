#!/usr/bin/env node
import { once } from "node:events";
import { connect } from "node:net";
import process from "node:process";
import { createInterface } from "node:readline/promises";

import { Value } from "typebox/value";

import { controlSocket, PairReply } from "./control.ts";
import { dataDir } from "./data-dir.ts";

const USAGE = `Usage:
  shrok run              Start Shrok.
  shrok pair             Pair your phone with the running Shrok.
  shrok pair --replace   Pair a different phone. The current one stops being the owner.`;

const CONFIRM_WORD = "REPLACE";

const confirmReplace = async (): Promise<boolean> => {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      "shrok pair --replace must be run in a terminal, where you can confirm it.\n"
    );

    return false;
  }

  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const typed = await terminal.question(
    `The phone paired now will stop being Shrok's owner. Type ${CONFIRM_WORD} to go on: `
  );

  terminal.close();

  return typed.trim() === CONFIRM_WORD;
};

const pair = async (replace: boolean): Promise<number> => {
  if (replace && !(await confirmReplace())) {
    process.stderr.write("Nothing changed.\n");

    return 1;
  }

  const socket = connect(controlSocket(dataDir));

  try {
    await once(socket, "connect");
  } catch {
    process.stderr.write(
      `Shrok isn't running on ${dataDir}. Start it with shrok run, then try again.\n`
    );

    return 1;
  }

  socket.write(`${JSON.stringify({ replace, type: "pair" })}\n`);

  const lines = createInterface({ input: socket });

  for await (const line of lines) {
    const reply: unknown = JSON.parse(line);

    if (!Value.Check(PairReply, reply)) {
      continue;
    }

    if (reply.type === "invite") {
      process.stdout.write(
        `In SimpleX on your phone, tap + then "Connect via link" and paste this one-time link. It works for 15 minutes:\n\n${reply.link}\n\nWaiting for your phone. Press Ctrl-C to cancel.\n`
      );
    } else if (reply.type === "paired") {
      process.stdout.write("Paired. Send Shrok a message from your phone.\n");

      return 0;
    } else if (reply.type === "expired") {
      process.stderr.write(
        "The link expired unused and was deleted. Run shrok pair again.\n"
      );

      return 1;
    } else {
      process.stderr.write(`${reply.message}\n`);

      return 1;
    }
  }

  process.stderr.write("Shrok stopped before your phone paired.\n");

  return 1;
};

const [command, ...options] = process.argv.slice(2);

if (command === "run" && options.length === 0) {
  await import("./main.ts");
} else if (
  command === "pair" &&
  options.every((option) => option === "--replace")
) {
  process.exitCode = await pair(options.includes("--replace"));
  process.exit();
} else {
  process.stderr.write(`${USAGE}\n`);
  process.exitCode = 2;
}
