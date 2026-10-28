import { Type } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  section,
} from "@earendil-works/pi-durable";
import type { EntryId } from "@earendil-works/pi-durable";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { locale, timeZone } from "./settings.ts";
import { localTime } from "./time.ts";
import type { Approvals } from "./tools/approvals.ts";

export type Notify = (text: string, unlessSentSince: Date) => Promise<void>;

const CLOCK = /^(?<hour>[01]\d|2[0-3]):(?<minute>[0-5]\d)$/u;
const DAYS_IN_WEEK = 7;
const MAX_SCHEDULES = 64;
const MAX_WHAT_CHARS = 2000;

const WhenSchema = Type.Object({
  at: Type.String({ description: `Clock time, HH:MM, ${timeZone} time` }),
  date: Type.Optional(
    Type.String({ description: "YYYY-MM-DD: fire once, on this day" })
  ),
  days: Type.Optional(
    Type.Array(Type.Integer({ maximum: 7, minimum: 1 }), {
      description:
        "Repeat on these weekdays, 1 Monday to 7 Sunday. Leave out both date and days to repeat daily.",
    })
  ),
});

type When = Static<typeof WhenSchema>;

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

  if (when.date !== undefined && when.days !== undefined) {
    return "Give either a date (once) or days (weekly), not both.";
  }

  if (when.date !== undefined) {
    try {
      Temporal.PlainDate.from(when.date);
    } catch {
      return `"${when.date}" is not a date like 2026-10-31.`;
    }
  }

  return when.days?.length === 0 ? "days is empty." : undefined;
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

  const start = Temporal.Instant.fromEpochMilliseconds(after)
    .toZonedDateTimeISO(timeZone)
    .with({
      ...time,
      microsecond: 0,
      millisecond: 0,
      nanosecond: 0,
      second: 0,
    });

  for (let offset = 0; offset <= DAYS_IN_WEEK; offset += 1) {
    const candidate = start.add({ days: offset });

    if (
      candidate.epochMilliseconds > after &&
      (when.days?.includes(candidate.dayOfWeek) ?? true)
    ) {
      return candidate.epochMilliseconds;
    }
  }

  return undefined;
};

const describeWhen = (when: When): string => {
  if (when.date !== undefined) {
    return `once on ${when.date} at ${when.at}`;
  }

  return when.days === undefined
    ? `every day at ${when.at}`
    : `on weekdays ${when.days.join(", ")} (1 is Monday) at ${when.at}`;
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

const dayList = new Intl.ListFormat(locale, { type: "conjunction" });

const dayFormat = new Intl.DateTimeFormat(locale, {
  day: "numeric",
  month: "long",
  timeZone,
  weekday: "long",
});

const scheduleLabel = (when: When): string => {
  if (when.date !== undefined) {
    const day = dayFormat.format(
      new Date(`${Temporal.PlainDate.from(when.date).toString()}T12:00:00Z`)
    );

    return `⏰ _Scheduled for ${day} at ${when.at}_`;
  }

  if (when.days === undefined) {
    return `⏰ _Every day at ${when.at}_`;
  }

  const names = [...new Set(when.days)]
    .toSorted((a, b) => a - b)
    .map((day) => WEEKDAYS[day - 1] ?? String(day));

  return `⏰ _Every ${dayList.format(names)} at ${when.at}_`;
};

export const answerText = (
  model: readonly { role: string }[] | undefined
): string =>
  (model ?? [])
    .filter(
      (message): message is AssistantMessage => message.role === "assistant"
    )
    .flatMap((message) => message.content)
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n\n")
    .trim();

const reply = (value: string) => ({
  output: [{ text: value, type: "text" as const }],
});

const PROMPT = `# Schedules

schedule makes Shrok act at a time the user asks for: a reminder, or a task to do then. It fires on
${timeZone} time, once on a date, weekly on some days, or daily, and survives restarts. When it fires you
get a message that starts with [Scheduled], followed by what you wrote: do it, and write what the user
should read, since your answer is sent to his phone. A line saying when the schedule fired, starting with
⏰, is put above your answer, so don't repeat the time or add an alarm emoji. Set only schedules the user
asks for: each waits for his /yes to its exact text and time. Use schedules to list them and cancel_schedule
to stop one.`;

export const createSchedulesExtension = (approvals: Approvals) => {
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
        const { due, text } = task.state.checkpoint;
        const notify = await sender.promise;

        await notify(text, new Date(due));
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

        const cancelled = !(listed?.items ?? []).some(
          (item) => item.id === task.id
        );

        if (cancelled) {
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

        const submission = await conversation.submit(
          {
            content: `<sent>${localTime.format(due)}</sent>\n\n[Scheduled] ${task.input.what}`,
            requestId: `schedule:${task.id}:${due}`,
            type: "input",
          },
          context
        );

        const settled = await submission.wait(context);

        const answerOf = async (id: EntryId) => {
          const entry = await runtime.entry(AssistantEntry, id, context);

          return entry?.model;
        };

        const answered =
          settled.status === "done" && settled.type === "input"
            ? answerText(await answerOf(settled.answer))
            : "";

        const done =
          answered === ""
            ? `I couldn't do this scheduled task: ${task.input.what}\n\nAsk me to do it now if you still want it.`
            : answered;

        const text = `${scheduleLabel(task.input.when)}\n\n${done}`;

        await runtime.commit(
          () => ({
            checkpoint: { due, phase: "deliver", text },
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

  const extension = defineExtension({
    name: "schedules",
    sections: [section("schedules", () => PROMPT)],
    tasks: [Schedule],
    tools: [
      defineTool({
        description: `Make Shrok act at a time: a reminder, or something to do then. It fires on ${timeZone} time and survives restarts. Waits for his /yes.`,
        execute: async (args, api, context) => {
          const when: When = Value.Parse(WhenSchema, args.when);
          const problem = problemWith(when);

          if (problem !== undefined) {
            return reply(problem);
          }

          const due = nextRun(when, api.now());

          if (due === undefined) {
            return reply("That time has already passed.");
          }

          const set = await api.snapshot(
            Schedules,
            api.conversationId,
            context
          );

          if ((set?.items.length ?? 0) >= MAX_SCHEDULES) {
            return reply(
              `${MAX_SCHEDULES} schedules are set already. Cancel one before setting another.`
            );
          }

          let id = 0;

          // A fired schedule runs as the owner's message, so only the owner may set its text and time.
          await approvals.execute(
            api,
            () => ({
              adapter: "schedule-create-v1" as const,
              arguments: args,
              expectedState: {},
              identity: {},
              payload: { what: args.what, when },
              resource: {},
              summary: `schedule ${describeWhen(when)}, first ${localTime.format(due)}: ${args.what}`,
              tool: "schedule" as const,
            }),
            async (action) => {
              id = await api.commit(async (tx) => {
                const created = await tx.createTask(Schedule, action.payload, {
                  background: true,
                  ownership: { kind: "conversation" },
                });

                const listed = await tx.doc(Schedules, api.conversationId);

                listed.items.push({ id: created, ...action.payload });

                return created;
              }, context);
            },
            context.abortSignal
          );

          return reply(
            `Scheduled ${id}, ${describeWhen(when)}. First time: ${localTime.format(due)}.`
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
      defineTool({
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

          return await Promise.resolve(
            reply(lines.length === 0 ? "No schedules." : lines.join("\n"))
          );
        },
        name: "schedules",
        parameters: Type.Object({}),
        replay: "safe",
      }),
      defineTool({
        description: "Stop a schedule, by the id schedules lists.",
        execute: async (args, api, context) => {
          const removed = await api.commit(async (tx) => {
            const listed = await tx.doc(Schedules, api.conversationId);
            const before = listed.items.length;

            listed.items = listed.items.filter((item) => item.id !== args.id);

            return listed.items.length < before;
          }, context);

          return reply(
            removed ? `Cancelled ${args.id}.` : `No schedule ${args.id}.`
          );
        },
        name: "cancel_schedule",
        parameters: Type.Object({ id: Type.Integer() }),
        replay: "safe",
      }),
    ],
  });

  return {
    attach: (notify: Notify): void => {
      sender.resolve(notify);
    },
    extension,
  };
};
