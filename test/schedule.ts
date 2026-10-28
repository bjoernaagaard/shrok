import { randomInt } from "node:crypto";

import {
  approvalId,
  isReply,
  REPLY_BUDGET_MS,
  Session,
  StageFailedError,
} from "./shrok.ts";

const LEAD_MS = 100_000;
const LATE_MS = 90_000;
const ZONE = "Europe/Copenhagen";

const session = await Session.open("schedule");
const code = `WATER-${randomInt(1000, 9999)}`;

const due = Temporal.Now.zonedDateTimeISO(ZONE)
  .add({ milliseconds: LEAD_MS })
  .round({ roundingMode: "ceil", smallestUnit: "minute" });

const clock = due.toPlainTime().toString({ smallestUnit: "minute" });

await session.finish("schedule", async () => {
  await session.start();

  const asked = await session.send(
    `On ${due.toPlainDate().toString()} at ${clock}, remind me to drink water. Put the code ${code} in the reminder.`
  );

  // A schedule waits for the owner's /yes to its exact text and time.
  const request = await session.waitFor(
    "ask",
    asked,
    REPLY_BUDGET_MS,
    (text) => approvalId(text) !== undefined || isReply(text)
  );

  const id = approvalId(request.text);

  if (id === undefined || !request.text.includes(code)) {
    throw new StageFailedError(
      "ask",
      `Shrok did not ask to approve a schedule with ${code}: ${request.text}`
    );
  }

  const confirmed = await session.answer("set", id, "yes", REPLY_BUDGET_MS);

  if (confirmed.text.includes(code) && !confirmed.text.includes(clock)) {
    throw new StageFailedError(
      "set",
      "Shrok reminded at once instead of scheduling"
    );
  }

  await session.stop();

  const restarted = session.messages.length;

  await session.start();

  const fired = await session.waitFor(
    "fired",
    restarted,
    due.epochMilliseconds - Date.now() + LATE_MS,
    (text) => text.includes(code)
  );

  if (Date.parse(fired.at) < due.epochMilliseconds) {
    throw new StageFailedError(
      "fired",
      `the reminder came at ${fired.at}, before ${due.toString()}`
    );
  }

  return { code, due: due.toString() };
});
