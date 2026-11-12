import {
  AssistantEntry,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  section,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { ask, TAGS } from "./conversation.ts";
import { locale, timeZone } from "./settings.ts";
import { localTime } from "./time.ts";
import { text } from "./tools/output.ts";
import type { ShrokTool } from "./tools/policy.ts";
import { registrations } from "./tools/policy.ts";

/** Sends text to the owner, unless the same text was already sent at or after `unlessSentSince`. */
export type Notify = (text: string, unlessSentSince: Date) => Promise<void>;

const CLOCK = /^(?<hour>[01]\d|2[0-3]):(?<minute>[0-5]\d)$/u;
const DAYS_IN_WEEK = 7;
const MAX_SCHEDULES = 64;
const MAX_WHAT_CHARS = 2000;
const MAX_MONTHS_AHEAD = 13;

const WhenSchema = Type.Object({
  at: Type.String({ description: `Clock time, HH:MM, ${timeZone} time` }),
  date: Type.Optional(
    Type.String({ description: "YYYY-MM-DD: fire once, on this day" })
  ),
  days: Type.Optional(
    Type.Array(Type.Integer({ maximum: 7, minimum: 1 }), {
      description:
        "Repeat on these weekdays, 1 Monday to 7 Sunday. Leave out date, days and month_days to repeat daily.",
    })
  ),
  every_weeks: Type.Optional(
    Type.Integer({
      description:
        "With days: repeat only every this many weeks, counting from this week. 2 means every other week.",
      maximum: 52,
      minimum: 2,
    })
  ),
  month_days: Type.Optional(
    Type.Array(Type.Integer({ maximum: 31, minimum: 1 }), {
      description:
        "Repeat monthly on these days of the month. A month without the day skips it.",
    })
  ),
});

/** A schedule's times, with the week every_weeks counts from, which Shrok sets when the schedule is made. */
type When = Static<typeof WhenSchema> & { readonly from?: string };

interface ScheduleInput {
  readonly what: string;
  readonly when: When;
}

type ScheduleState =
  | { readonly phase: "wait" }
  | { readonly phase: "fire"; readonly due: number }
  | { readonly phase: "deliver"; readonly due: number; readonly text: string };

const Schedules = defineDoc<{
  items: { id: number; what: string; when: When }[];
}>({
  checkpointWhen: () => false,
  fork: "initial",
  history: "latest",
  initial: () => ({ items: [] }),
  kind: "shrok.schedules",
  scope: "conversation",
  version: 1,
});

const problemWith = (when: When): string | undefined => {
  if (!CLOCK.test(when.at)) {
    return `"${when.at}" is not a clock time like 08:00.`;
  }

  const kinds = [when.date, when.days, when.month_days].filter(
    (kind) => kind !== undefined
  );

  if (kinds.length > 1) {
    return "Give one of date (once), days (weekly) or month_days (monthly).";
  }

  if (when.every_weeks !== undefined && when.days === undefined) {
    return "every_weeks needs days.";
  }

  if (when.date !== undefined) {
    try {
      Temporal.PlainDate.from(when.date);
    } catch {
      return `"${when.date}" is not a date like 2026-10-31.`;
    }
  }

  return when.days?.length === 0 || when.month_days?.length === 0
    ? "days and month_days may not be empty."
    : undefined;
};

const monday = (date: Temporal.PlainDate): Temporal.PlainDate =>
  date.subtract({ days: date.dayOfWeek - 1 });

/** "every", "every other" or "every 3 weeks on", for a weekly schedule. */
const everyWeeks = (weeks: number | undefined): string => {
  if (weeks === undefined) {
    return "every";
  }

  return weeks === 2 ? "every other" : `every ${weeks} weeks on`;
};

/** Whether a day matches the schedule's repeat pattern. */
const repeatsOn = (when: When, day: Temporal.ZonedDateTime): boolean => {
  if (when.month_days !== undefined) {
    return when.month_days.includes(day.day);
  }

  if (when.days === undefined) {
    return true;
  }

  if (!when.days.includes(day.dayOfWeek)) {
    return false;
  }

  if (when.every_weeks === undefined || when.from === undefined) {
    return true;
  }

  const weeks =
    monday(Temporal.PlainDate.from(when.from)).until(monday(day.toPlainDate()))
      .days / DAYS_IN_WEEK;

  return weeks % when.every_weeks === 0;
};

const nextRun = (when: When, after: number): number | undefined => {
  const { hour = "0", minute = "0" } = CLOCK.exec(when.at)?.groups ?? {};
  const time = { hour: Number(hour), minute: Number(minute) };

  if (when.date !== undefined) {
    const due = Temporal.PlainDate.from(when.date).toZonedDateTime({
      plainTime: Temporal.PlainTime.from(time),
      timeZone,
    }).epochMilliseconds;

    return due > after ? due : undefined;
  }

  const plainTime = Temporal.PlainTime.from(time);

  const first = Temporal.Instant.fromEpochMilliseconds(after)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate();

  const last = first.add({ months: MAX_MONTHS_AHEAD });

  // Each day's time is built in the zone on its own, so a summer-time gap moves only the day it falls on.
  for (
    let day = first;
    Temporal.PlainDate.compare(day, last) < 0;
    day = day.add({ days: 1 })
  ) {
    const candidate = day.toZonedDateTime({ plainTime, timeZone });

    if (candidate.epochMilliseconds > after && repeatsOn(when, candidate)) {
      return candidate.epochMilliseconds;
    }
  }

  return undefined;
};

const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

const list = new Intl.ListFormat(locale, { type: "conjunction" });

/** How the owner reads when a schedule fires, such as "every other Tuesday at 08:00". */
const describeWhen = (when: When): string => {
  if (when.date !== undefined) {
    const day = Temporal.PlainDate.from(when.date).toLocaleString(locale, {
      day: "numeric",
      month: "long",
      weekday: "long",
    });

    return `on ${day} at ${when.at}`;
  }

  if (when.month_days !== undefined) {
    return `every month on day ${list.format([...new Set(when.month_days)].toSorted((a, b) => a - b).map(String))} at ${when.at}`;
  }

  if (when.days === undefined) {
    return `every day at ${when.at}`;
  }

  const names = [...new Set(when.days)]
    .toSorted((a, b) => a - b)
    .map((day) => WEEKDAYS[day - 1] ?? String(day));

  const every = everyWeeks(when.every_weeks);

  return `${every} ${list.format(names)} at ${when.at}`;
};

const PROMPT = `# Schedules

schedule makes Shrok act at a time: a reminder, or a task to do then. It fires on ${timeZone} time, once on a
date, weekly on some days (optionally every few weeks), monthly on days of the month, or daily, and survives
restarts. When it fires you get what you wrote, framed by <${TAGS.schedule}>: do it, and write
what the user should read, since your answer is sent to his phone. A line saying when the schedule fired, starting
with ⏰, is put above your answer, so don't repeat the time or add an alarm emoji.

Set schedules when he asks, and also on your own when it clearly helps him, such as a follow-up you promised or a
reminder before something he mentioned. Tell him each time you set one. Use schedules to list them and
cancel_schedule to stop one.`;

export const createSchedules = () => {
  const sender = Promise.withResolvers<Notify>();

  const Schedule = defineTask<ScheduleInput, ScheduleState, null>({
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({ outcome: { status: "aborted" }, status: "terminal" }),
        context
      );
    },
    initial: () => ({ phase: "wait" }),
    name: "shrok.schedule",
    phases: {
      deliver: async (task, runtime, context) => {
        const { due, text: message } = task.state.checkpoint;
        const notify = await sender.promise;

        await notify(message, new Date(due));
        const next = nextRun(task.input.when, due);

        await runtime.commit(async (tx) => {
          if (next !== undefined) {
            return {
              checkpoint: { due: next, phase: "fire" },
              status: "sleeping",
              until: next,
            };
          }

          const listed = await tx.doc(Schedules, runtime.conversationId);

          listed.items = listed.items.filter((item) => item.id !== task.id);

          return {
            outcome: { result: null, status: "completed" },
            status: "terminal",
          };
        }, context);
      },
      fire: async (task, runtime, context) => {
        const { due } = task.state.checkpoint;

        const listed = await runtime.snapshot(
          Schedules,
          runtime.conversationId,
          context
        );

        if (!(listed?.items ?? []).some((item) => item.id === task.id)) {
          await runtime.commit(
            () => ({
              outcome: { result: null, status: "completed" },
              status: "terminal",
            }),
            context
          );

          return;
        }

        const conversation = await runtime.conversation(
          runtime.conversationId,
          context
        );

        if (conversation === undefined) {
          throw new Error("The schedule's conversation is gone.");
        }

        const answer = await ask(
          {
            answerOf: async (id) => {
              const entry = await runtime.entry(AssistantEntry, id, context);

              return entry?.model;
            },
            submit: async (draft, submitContext) =>
              await conversation.submit(draft, submitContext),
          },
          {
            at: due,
            from: "schedule",
            requestId: `schedule:${task.id}:${due}`,
            text: task.input.what,
          },
          context
        );

        const done = answer.answered
          ? answer.text || "Done."
          : `I couldn't do this scheduled task: ${task.input.what}\n\nAsk me to do it now if you still want it.`;

        await runtime.commit(
          () => ({
            checkpoint: {
              due,
              phase: "deliver",
              text: `⏰ _${describeWhen(task.input.when).replace(/^./u, (first) => first.toUpperCase())}_\n\n${done}`,
            },
            status: "running",
          }),
          context
        );
      },
      wait: async (task, runtime, context) => {
        const due = nextRun(task.input.when, runtime.now());

        if (due === undefined) {
          await runtime.commit(
            () => ({
              outcome: { result: null, status: "completed" },
              status: "terminal",
            }),
            context
          );

          return;
        }

        await runtime.sleepUntil(due, { due, phase: "fire" }, context);
      },
    },
    version: 1,
  });

  const tools: ShrokTool[] = [
    {
      phrase: "setting a schedule",
      tool: defineTool({
        description: `Make Shrok act at a time: a reminder, or something to do then. It fires on ${timeZone} time and survives restarts.`,
        execute: async (args, api, context) => {
          const today = Temporal.Instant.fromEpochMilliseconds(api.now())
            .toZonedDateTimeISO(timeZone)
            .toPlainDate()
            .toString();

          const when: When = {
            ...Value.Parse(WhenSchema, args.when),
            from: today,
          };

          const problem = problemWith(when);

          if (problem !== undefined) {
            return text(problem);
          }

          const due = nextRun(when, api.now());

          if (due === undefined) {
            return text("That time has already passed, or never comes.");
          }

          const id = await api.commit(async (tx) => {
            const listed = await tx.doc(Schedules, api.conversationId);

            if (listed.items.length >= MAX_SCHEDULES) {
              return null;
            }

            const created = await tx.createTask(
              Schedule,
              { what: args.what, when },
              { background: true, ownership: { kind: "conversation" } }
            );

            listed.items.push({ id: created, what: args.what, when });

            return created;
          }, context);

          return text(
            id === null
              ? `${MAX_SCHEDULES} schedules are set already. Cancel one before setting another.`
              : `Scheduled ${id}, ${describeWhen(when)}. First time: ${localTime.format(due)}.`
          );
        },
        name: "schedule",
        parameters: Type.Object({
          what: Type.String({
            description:
              "What to do when it fires, written to yourself, for example: Remind him to call the dentist.",
            maxLength: MAX_WHAT_CHARS,
          }),
          when: WhenSchema,
        }),
      }),
    },
    {
      phrase: "checking your schedules",
      tool: defineTool({
        description: "List the schedules that are set, with their next time.",
        execute: async (_args, api, context) => {
          const listed = await api.snapshot(
            Schedules,
            api.conversationId,
            context
          );

          const lines = (listed?.items ?? []).map((item) => {
            const next = nextRun(item.when, api.now());

            return `- ${item.id}: ${item.what} (${describeWhen(item.when)}; next ${next === undefined ? "never" : localTime.format(next)})`;
          });

          return text(lines.length === 0 ? "No schedules." : lines.join("\n"));
        },
        name: "schedules",
        parameters: Type.Object({}),
        replay: "safe",
      }),
    },
    {
      phrase: "cancelling a schedule",
      tool: defineTool({
        description: "Stop a schedule, by the id schedules lists.",
        execute: async (args, api, context) => {
          const removed = await api.commit(async (tx) => {
            const listed = await tx.doc(Schedules, api.conversationId);
            const before = listed.items.length;

            listed.items = listed.items.filter((item) => item.id !== args.id);

            return listed.items.length < before;
          }, context);

          return text(
            removed ? `Cancelled ${args.id}.` : `No schedule ${args.id}.`
          );
        },
        name: "cancel_schedule",
        parameters: Type.Object({ id: Type.Integer() }),
        replay: "safe",
      }),
    },
  ];

  return {
    attach: (notify: Notify): void => {
      sender.resolve(notify);
    },
    extension: defineExtension({
      name: "schedules",
      sections: [section("schedules", () => PROMPT)],
      tasks: [Schedule],
      tools: registrations(tools),
    }),
    tools,
  };
};
