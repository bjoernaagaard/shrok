import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { Type } from "typebox";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";

import { REPLY_BUDGET_MS, Session, StageFailedError } from "./shrok.ts";

const WRITE_BUDGET_MS = 300_000;
const FLOW = "inbox-note";
const ASKS = "*Shrok wants to:*";
const APPROVAL = /\/'yes (?<id>\d+)'/u;
const STILL_ARRIVING = "That request is still arriving";
const YES_ATTEMPTS = 10;
const YES_RETRY_MS = 3000;

const ANSWERED = /^\*Request \d+: /u;

const session = await Session.open("flow");
const subject = `FLOW-${randomInt(1000, 9999)}`;
const flowFile = path.join(session.dataDir, "workspace", "flows", `${FLOW}.js`);

const Profile = Type.Object({ emailAddress: Type.String() });

/** The address of the Gmail account gws is logged in to, which the draft goes to. */
const OWNER = Value.Parse(
  Profile,
  JSON.parse(
    execFileSync(
      "gws",
      [
        "gmail",
        "users",
        "getProfile",
        "--params",
        JSON.stringify({ userId: "me" }),
      ],
      { encoding: "utf-8" }
    )
  )
).emailAddress;

const DraftList = Type.Object({
  drafts: Type.Optional(Type.Array(Type.Object({ id: Type.String() }))),
});

const Draft = Type.Object({
  message: Type.Object({ snippet: Type.String() }),
});

const drafts = <T extends TSchema>(
  schema: T,
  method: string,
  params: Record<string, string>
) => {
  const stdout = execFileSync(
    "gws",
    [
      "gmail",
      "users",
      "drafts",
      method,
      "--params",
      JSON.stringify({ ...params, userId: "me" }),
    ],
    { encoding: "utf-8" }
  );

  return Value.Parse(schema, method === "delete" ? {} : JSON.parse(stdout));
};

await session.finish("flow", async () => {
  await session.start();

  const asked = await session.send(
    `Make a flow named ${FLOW}. Its input is { subject }. It finds my newest unread email and reads it, counts my calendar events in the next 7 days, and saves a Gmail draft to me (${OWNER}) with that subject, whose body names the email's sender and subject and the number of events. Draft it and save it, but don't run it yet.`
  );

  const request = await session.waitFor(
    "draft",
    asked,
    WRITE_BUDGET_MS,
    (text) => APPROVAL.test(text) && text.includes(FLOW)
  );

  const approvalId = APPROVAL.exec(request.text)?.groups?.id ?? "";

  const sayYes = async (): Promise<string> => {
    const approved = await session.send(`/yes ${approvalId}`);

    const answer = await session.waitFor(
      "approve",
      approved,
      REPLY_BUDGET_MS,
      (text) => !ANSWERED.test(text) && !text.startsWith(ASKS)
    );

    return answer.text;
  };

  let reply = await sayYes();

  for (let attempt = 1; attempt < YES_ATTEMPTS; attempt += 1) {
    if (!reply.startsWith(STILL_ARRIVING)) {
      break;
    }

    // oxlint-disable-next-line no-await-in-loop
    reply = await sleep(YES_RETRY_MS).then(sayYes);
  }

  if (reply.startsWith(STILL_ARRIVING)) {
    throw new StageFailedError(
      "approve",
      `the request never finished arriving after ${YES_ATTEMPTS} tries`
    );
  }

  if (!existsSync(flowFile)) {
    throw new StageFailedError("approve", `${flowFile} was not written`);
  }

  await session.stop();
  await session.start();

  const ran = await session.send(
    `Can you put a note about my newest unread mail and how busy my week is in a draft to me? Call it ${subject}.`
  );

  const answer = await session.waitFor(
    "run",
    ran,
    WRITE_BUDGET_MS,
    (text) => !text.startsWith(ASKS)
  );

  const asksDuringRun = session.messages
    .slice(ran)
    .filter((m) => m.text.startsWith(ASKS));

  if (asksDuringRun.length > 0) {
    throw new StageFailedError(
      "run",
      `running the flow asked for approval: ${asksDuringRun[0]?.text ?? ""}`
    );
  }

  const tools = session.toolCalls();

  if (!tools.includes("run_flow")) {
    throw new StageFailedError(
      "run",
      `the model never called run_flow: ${tools.join(", ")}`
    );
  }

  const byHand = tools.filter(
    (tool) => tool === "run_program" || tool.startsWith("gmail_")
  );

  if (byHand.length > 0) {
    throw new StageFailedError(
      "run",
      `the model reached Gmail itself instead of through the flow: ${byHand.join(", ")}`
    );
  }

  const listed = drafts(DraftList, "list", {
    q: `subject:${subject}`,
  });

  const found = listed.drafts ?? [];

  if (found.length !== 1) {
    throw new StageFailedError(
      "check",
      `expected one draft with subject ${subject}, found ${found.length}`
    );
  }

  const id = found[0]?.id ?? "";
  const draft = drafts(Draft, "get", { format: "full", id });

  drafts(Type.Object({}), "delete", { id });

  return {
    answer: answer.text,
    draftSnippet: draft.message.snippet,
    flow: await readFile(flowFile, "utf-8"),
    subject,
    tools,
  };
});
