import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { defineTool } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Type } from "typebox";
import type { Static } from "typebox";

import type { Layout } from "../layout.ts";
import { timeZone } from "../settings.ts";
import { Asked, quoted, typedOutcome } from "./approvals.ts";
import type { Approvals } from "./approvals.ts";
import { typed } from "./output.ts";
import type { ShrokTool } from "./policy.ts";
import { programJson } from "./programs.ts";
import { MAX_FILE_BYTES } from "./workspace.ts";
import type { WriteFile } from "./workspace.ts";

const DEFAULT_MAX = 10;
const MAX_SEARCH_RESULTS = 50;
const BODY_CHARS = 20_000;
const DRIVE_TEXT_CHARS = 40_000;
const EMAIL = /[^\s<>,;"']+@[^\s<>,;"']+/gu;

/** The email addresses in a header or a list, lowercase. */
const addresses = (value: string): string[] =>
  [...value.matchAll(EMAIL)].map(([address]) => address.toLowerCase());

const params = (value: Record<string, JsonValue>): string[] => [
  "--params",
  JSON.stringify(value),
];

/** `--name=value`, so a value that starts with "-", such as a "-- " signature, isn't read as a flag. */
const flag = (name: string, value: string): string => `--${name}=${value}`;

const Address = Type.Object({
  email: Type.String(),
  name: Type.Union([Type.String(), Type.Null()]),
});

const show = ({ email, name }: Static<typeof Address>): string =>
  name === null || name === "" ? email : `${name} <${email}>`;

const MessageSummary = Type.Object({
  date: Type.String(),
  from: Type.String(),
  id: Type.String(),
  subject: Type.String(),
});

const SearchOutput = Type.Object({
  messages: Type.Array(MessageSummary, { maxItems: MAX_SEARCH_RESULTS }),
});

const TriageResponse = Type.Object({
  messages: Type.Optional(
    Type.Array(MessageSummary, { maxItems: MAX_SEARCH_RESULTS })
  ),
});

const ReadResponse = Type.Object({
  body_text: Type.String(),
  date: Type.String(),
  from: Address,
  reply_to: Type.Optional(Type.Union([Type.Array(Address), Type.Null()])),
  subject: Type.String(),
  thread_id: Type.String(),
  to: Type.Array(Address),
});

const MessageOutput = Type.Object({
  body: Type.String(),
  date: Type.String(),
  from: Type.String(),
  id: Type.String(),
  replyTo: Type.Array(Type.String()),
  subject: Type.String(),
  threadId: Type.String(),
  to: Type.Array(Type.String()),
});

const ComposeParameters = Type.Object({
  body: Type.String({ description: "Plain text" }),
  reply_to: Type.Optional(
    Type.String({
      description:
        "The id of a message to answer: threads it as a reply and fills in its sender and subject",
    })
  ),
  subject: Type.Optional(
    Type.String({ description: "Needed unless reply_to is given" })
  ),
  to: Type.Optional(
    Type.String({
      description:
        "Addresses, comma-separated. Needed unless reply_to is given; with it, adds recipients",
    })
  ),
});

type Compose = Static<typeof ComposeParameters>;

const ProfileResponse = Type.Object({ emailAddress: Type.String() });

const DraftResponse = Type.Object({
  id: Type.String(),
  message: Type.Object({ id: Type.String(), threadId: Type.String() }),
});

const DraftOutput = Type.Object({
  draftId: Type.String(),
  messageId: Type.String(),
  threadId: Type.String(),
});

const SentResponse = Type.Object({
  id: Type.String(),
  threadId: Type.String(),
});

const SentOutput = Type.Object({
  messageId: Type.String(),
  threadId: Type.String(),
});

const ModifyResponse = Type.Object({
  id: Type.String(),
  labelIds: Type.Optional(Type.Array(Type.String())),
});

const ModifyOutput = Type.Object({
  labels: Type.Array(Type.String()),
  messageId: Type.String(),
});

const EventTime = Type.Object({
  date: Type.Optional(Type.String()),
  dateTime: Type.Optional(Type.String()),
});

const EventResponse = Type.Object({
  attendees: Type.Optional(
    Type.Union([Type.Array(Type.Object({ email: Type.String() })), Type.Null()])
  ),
  description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  end: EventTime,
  htmlLink: Type.String(),
  id: Type.String(),
  location: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  start: EventTime,
  summary: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const EventsResponse = Type.Object({
  items: Type.Optional(Type.Array(EventResponse)),
});

const Event = Type.Object({
  description: Type.String(),
  end: Type.String(),
  guests: Type.Array(Type.String()),
  id: Type.String(),
  link: Type.String(),
  location: Type.String(),
  start: Type.String(),
  summary: Type.String(),
});

const EventsOutput = Type.Object({ events: Type.Array(Event) });

const DeletedOutput = Type.Object({ deleted: Type.String() });

const DriveFile = Type.Object({
  id: Type.String(),
  mimeType: Type.String(),
  modifiedTime: Type.Optional(Type.String()),
  name: Type.String(),
  size: Type.Optional(Type.String()),
  webViewLink: Type.Optional(Type.String()),
});

const DriveList = Type.Object({ files: Type.Optional(Type.Array(DriveFile)) });

const DriveSearchOutput = Type.Object({ files: Type.Array(DriveFile) });

const DriveReadOutput = Type.Object({
  name: Type.String(),
  text: Type.Optional(Type.String()),
  workspacePath: Type.Optional(Type.String()),
});

const EmptyResponse = Type.Object({});

/** Labels that delete or hide mail, which gmail_modify refuses, as it runs without the owner's /yes. */
const DESTRUCTIVE_LABELS = new Set(["SPAM", "TRASH"]);

/** Google's own formats, exported as text the model can read, and anything else downloaded as it is. */
const EXPORTS = new Map([
  ["application/vnd.google-apps.document", "text/plain"],
  ["application/vnd.google-apps.presentation", "text/plain"],
  ["application/vnd.google-apps.spreadsheet", "text/csv"],
]);

const eventOf = (
  event: Static<typeof EventResponse>
): Static<typeof Event> => ({
  description: event.description ?? "",
  end: event.end.dateTime ?? event.end.date ?? "",
  guests: (event.attendees ?? []).map(({ email }) => email),
  id: event.id,
  link: event.htmlLink,
  location: event.location ?? "",
  start: event.start.dateTime ?? event.start.date ?? "",
  summary: event.summary ?? "",
});

const readMessage = async (
  env: ExecutionEnv | undefined,
  id: string,
  context: Context
): Promise<Static<typeof MessageOutput>> => {
  const message = await programJson(
    "gws",
    ReadResponse,
    env,
    ["gmail", "+read", flag("id", id), "--headers", "--format", "json"],
    context
  );

  const replyTo = message.reply_to ?? [];

  return {
    body: message.body_text.slice(0, BODY_CHARS),
    date: message.date,
    from: show(message.from),
    id,
    replyTo: (replyTo.length > 0 ? replyTo : [message.from]).map(show),
    subject: message.subject,
    threadId: message.thread_id,
    to: message.to.map(show),
  };
};

const readEvent = async (
  env: ExecutionEnv | undefined,
  id: string,
  context: Context
): Promise<Static<typeof Event>> =>
  eventOf(
    await programJson(
      "gws",
      EventResponse,
      env,
      [
        "calendar",
        "events",
        "get",
        ...params({ calendarId: "primary", eventId: id }),
      ],
      context
    )
  );

const composeArgs = (args: Compose, draft: boolean): string[] => {
  const mode = draft ? ["--draft"] : [];

  if (args.reply_to !== undefined) {
    return [
      "gmail",
      "+reply",
      flag("message-id", args.reply_to),
      flag("body", args.body),
      ...(args.to === undefined ? [] : [flag("to", args.to)]),
      ...mode,
    ];
  }

  if (args.to === undefined || args.subject === undefined) {
    throw new Error("A new email needs to and subject, or give reply_to.");
  }

  return [
    "gmail",
    "+send",
    flag("to", args.to),
    flag("subject", args.subject),
    flag("body", args.body),
    ...mode,
  ];
};

const EventChanges = {
  description: Type.Optional(Type.String()),
  end: Type.Optional(Type.String({ description: "RFC 3339, like start" })),
  location: Type.Optional(Type.String()),
  start: Type.Optional(
    Type.String({
      description: `RFC 3339 with the UTC offset ${timeZone} has on that day, such as 2026-10-27T10:00:00+01:00`,
    })
  ),
  summary: Type.Optional(Type.String({ description: "The event's title" })),
};

/** An event's fields as the owner reads them in a request. */
const eventText = (event: {
  readonly summary?: string;
  readonly start?: string;
  readonly end?: string;
  readonly location?: string;
  readonly description?: string;
}): string =>
  [
    event.summary === undefined ? "" : `titled ${quoted(event.summary)}`,
    event.start === undefined ? "" : `from ${event.start}`,
    event.end === undefined ? "" : `to ${event.end}`,
    event.location === undefined ? "" : `at ${quoted(event.location)}`,
    event.description === undefined
      ? ""
      : `with the description ${quoted(event.description)}`,
  ]
    .filter((part) => part !== "")
    .join(", ");

export const createGoogleTools = (
  approvals: Approvals,
  layout: Layout,
  writeFile: WriteFile
): ShrokTool[] => [
  {
    flow: true,
    phrase: "searching your email",
    tool: defineTool({
      description:
        "Find emails with a Gmail search, newest first. Read one with gmail_read.",
      execute: async (args, api, context) => {
        const found = await programJson(
          "gws",
          TriageResponse,
          api.env,
          [
            "gmail",
            "+triage",
            flag("query", args.query),
            "--max",
            String(Math.min(args.max ?? DEFAULT_MAX, MAX_SEARCH_RESULTS)),
            "--format",
            "json",
          ],
          context
        );

        return typed(SearchOutput, { messages: found.messages ?? [] });
      },
      name: "gmail_search",
      parameters: Type.Object({
        max: Type.Optional(
          Type.Integer({ maximum: MAX_SEARCH_RESULTS, minimum: 1 })
        ),
        query: Type.String({
          description:
            "Gmail search, such as is:unread, from:anna, newer_than:7d, subject:invoice",
        }),
      }),
      replay: "safe",
      structuredOutputSchema: SearchOutput,
    }),
  },
  {
    flow: true,
    phrase: "reading an email",
    tool: defineTool({
      description: "Read one email: its sender, recipients, subject and text.",
      execute: async (args, api, context) =>
        typed(MessageOutput, await readMessage(api.env, args.id, context)),
      name: "gmail_read",
      parameters: Type.Object({ id: Type.String() }),
      replay: "safe",
      structuredOutputSchema: MessageOutput,
    }),
  },
  {
    flow: true,
    phrase: "tidying your email",
    tool: defineTool({
      description:
        "Archive an email, mark it read or unread, or add and remove labels. Label ids come from Gmail, such as STARRED, IMPORTANT or a user label's id.",
      execute: async (args, api, context) => {
        const refused = (args.labels_to_add ?? []).filter((label) =>
          DESTRUCTIVE_LABELS.has(label.toUpperCase())
        );

        if (refused.length > 0) {
          throw new Error(
            `gmail_modify does not move mail to ${refused.join(" or ")}. Ask the owner to do it in Gmail.`
          );
        }

        const add = [
          ...(args.labels_to_add ?? []),
          ...(args.action === "mark_unread" ? ["UNREAD"] : []),
        ];

        const remove = [
          ...(args.labels_to_remove ?? []),
          ...(args.action === "archive" ? ["INBOX"] : []),
          ...(args.action === "mark_read" ? ["UNREAD"] : []),
        ];

        const changed = await programJson(
          "gws",
          ModifyResponse,
          api.env,
          [
            "gmail",
            "users",
            "messages",
            "modify",
            ...params({ id: args.id, userId: "me" }),
            "--json",
            JSON.stringify({ addLabelIds: add, removeLabelIds: remove }),
          ],
          context
        );

        return typed(ModifyOutput, {
          labels: changed.labelIds ?? [],
          messageId: changed.id,
        });
      },
      name: "gmail_modify",
      parameters: Type.Object({
        action: Type.Optional(
          Type.Enum(["archive", "mark_read", "mark_unread"])
        ),
        id: Type.String({ description: "The message id" }),
        labels_to_add: Type.Optional(Type.Array(Type.String())),
        labels_to_remove: Type.Optional(Type.Array(Type.String())),
      }),
      replay: "safe",
      structuredOutputSchema: ModifyOutput,
    }),
  },
  {
    flow: true,
    phrase: "drafting an email",
    tool: defineTool({
      description:
        "Save an email or a reply as a Gmail draft. Nothing is sent. The owner can edit and send it from Gmail.",
      execute: async (args, api, context) => {
        const draft = await programJson(
          "gws",
          DraftResponse,
          api.env,
          composeArgs(args, true),
          context
        );

        return typed(DraftOutput, {
          draftId: draft.id,
          messageId: draft.message.id,
          threadId: draft.message.threadId,
        });
      },
      name: "gmail_draft",
      parameters: ComposeParameters,
      structuredOutputSchema: DraftOutput,
    }),
  },
  {
    flow: true,
    phrase: "sending an email",
    tool: defineTool({
      description:
        "Send an email or a reply. Only when the user asked to send. Unless he allowed these recipients for good, it waits for his /yes on the exact email and the account it sends from.",
      execute: async (args, api, toolContext) =>
        typedOutcome(
          SentOutput,
          await approvals.request(
            api,
            toolContext,
            async ({ context, env }) => {
              // Read again at /yes: a different login or a changed thread fails the comparison, so the email
              // that goes out is the one the owner approved.
              const { emailAddress: account } = await programJson(
                "gws",
                ProfileResponse,
                env,
                ["gmail", "users", "getProfile", ...params({ userId: "me" })],
                context
              );

              const original =
                args.reply_to === undefined
                  ? undefined
                  : await readMessage(env, args.reply_to, context);

              const to = [
                ...(original?.replyTo ?? []),
                ...(args.to === undefined ? [] : [args.to]),
              ].join(", ");

              const what =
                original === undefined
                  ? `an email with the subject ${quoted(args.subject ?? "")}`
                  : `a reply in the thread ${quoted(original.subject)}, quoting its last message,`;

              return {
                arguments: { ...args },
                grants: [...new Set(addresses(to))].map(
                  (address) => `emails from ${account} to ${address}`
                ),
                run: async (where) => {
                  const sent = await programJson(
                    "gws",
                    SentResponse,
                    where.env,
                    composeArgs(args, false),
                    where.context
                  );

                  return { messageId: sent.id, threadId: sent.threadId };
                },
                state: {
                  account,
                  original:
                    original === undefined
                      ? null
                      : {
                          from: original.from,
                          replyTo: original.replyTo,
                          subject: original.subject,
                          threadId: original.threadId,
                        },
                },
                summary: `send ${what} from ${account} to ${quoted(to)}, saying ${quoted(args.body)}`,
                tool: "gmail_send",
              };
            }
          )
        ),
      name: "gmail_send",
      parameters: ComposeParameters,
      structuredOutputSchema: Type.Union([SentOutput, Asked]),
    }),
  },
  {
    flow: true,
    phrase: "reading your calendar",
    tool: defineTool({
      description: `The user's calendar events from today through the next days, on ${timeZone} time, with their ids for calendar_update and calendar_delete.`,
      execute: async (args, api, context) => {
        const today = Temporal.Now.zonedDateTimeISO(timeZone).startOfDay();

        const found = await programJson(
          "gws",
          EventsResponse,
          api.env,
          [
            "calendar",
            "events",
            "list",
            ...params({
              calendarId: "primary",
              maxResults: 250,
              orderBy: "startTime",
              singleEvents: true,
              timeMax: today.add({ days: args.days }).toInstant().toString(),
              timeMin: today.toInstant().toString(),
              timeZone,
            }),
          ],
          context
        );

        return typed(EventsOutput, {
          events: (found.items ?? []).map(eventOf),
        });
      },
      name: "calendar_events",
      parameters: Type.Object({
        days: Type.Integer({ maximum: 90, minimum: 1 }),
      }),
      replay: "safe",
      structuredOutputSchema: EventsOutput,
    }),
  },
  {
    flow: true,
    phrase: "adding to your calendar",
    tool: defineTool({
      description:
        "Add an event to the user's own calendar, with no guests. Unless he allowed this for good, it waits for his /yes on the exact event. Add guests afterwards with calendar_update.",
      execute: async (args, api, toolContext) =>
        typedOutcome(
          Event,
          await approvals.request(api, toolContext, () => ({
            arguments: { ...args },
            grants: ["adding events without guests to your calendar"],
            run: async ({ context, env }) =>
              eventOf(
                await programJson(
                  "gws",
                  EventResponse,
                  env,
                  [
                    "calendar",
                    "events",
                    "insert",
                    ...params({ calendarId: "primary" }),
                    "--json",
                    JSON.stringify({
                      description: args.description,
                      end: { dateTime: args.end, timeZone },
                      location: args.location,
                      start: { dateTime: args.start, timeZone },
                      summary: args.summary,
                    }),
                  ],
                  context
                )
              ),
            state: {},
            summary: `add an event to your calendar, ${eventText(args)}, with no guests`,
            tool: "calendar_add",
          }))
        ),
      name: "calendar_add",
      parameters: Type.Object({
        ...EventChanges,
        end: Type.String({ description: "RFC 3339, like start" }),
        start: Type.String({
          description: `RFC 3339 with the UTC offset ${timeZone} has on that day, such as 2026-10-27T10:00:00+01:00`,
        }),
        summary: Type.String({ description: "The event's title" }),
      }),
      structuredOutputSchema: Type.Union([Event, Asked]),
    }),
  },
  {
    flow: true,
    phrase: "changing your calendar",
    tool: defineTool({
      description:
        "Change an event on the user's calendar by its id from calendar_events: move it, rename it, or set its guests, who then get an invitation. Unless he allowed it for good, it waits for his /yes on the exact change.",
      execute: async (args, api, toolContext) =>
        typedOutcome(
          Event,
          await approvals.request(
            api,
            toolContext,
            async ({ context, env }) => {
              const before = await readEvent(env, args.id, context);
              const guests = args.guests?.map((guest) => guest.toLowerCase());

              const { guests: _guests, id: _id, ...fields } = args;
              const patch: Record<string, JsonValue> = {};

              if (guests !== undefined) {
                patch.attendees = guests.map((email) => ({ email }));
              }

              if (fields.description !== undefined) {
                patch.description = fields.description;
              }

              if (fields.end !== undefined) {
                patch.end = { dateTime: fields.end, timeZone };
              }

              if (fields.location !== undefined) {
                patch.location = fields.location;
              }

              if (fields.start !== undefined) {
                patch.start = { dateTime: fields.start, timeZone };
              }

              if (fields.summary !== undefined) {
                patch.summary = fields.summary;
              }

              const changesFields = Object.keys(patch).some(
                (key) => key !== "attendees"
              );

              // Setting guests emails every guest on the new list, and every guest it removes.
              const emailed =
                guests === undefined
                  ? []
                  : [
                      ...new Set([
                        ...before.guests.map((guest) => guest.toLowerCase()),
                        ...guests,
                      ]),
                    ];

              return {
                arguments: { ...args },
                grants: [
                  ...(changesFields
                    ? ["changing events on your calendar"]
                    : []),
                  ...emailed.map((guest) => `calendar emails to ${guest}`),
                ],
                run: async (where) =>
                  eventOf(
                    await programJson(
                      "gws",
                      EventResponse,
                      where.env,
                      [
                        "calendar",
                        "events",
                        "patch",
                        ...params({
                          calendarId: "primary",
                          eventId: args.id,
                          sendUpdates: guests === undefined ? "none" : "all",
                        }),
                        "--json",
                        JSON.stringify(patch),
                      ],
                      where.context
                    )
                  ),
                state: { before },
                summary: `change the event ${quoted(before.summary)} on ${before.start}: ${eventText(fields) || "no field changes"}${guests === undefined ? "" : `, with the guests ${quoted(guests.join(", "))}, who get an email`}`,
                tool: "calendar_update",
              };
            }
          )
        ),
      name: "calendar_update",
      parameters: Type.Object({
        ...EventChanges,
        guests: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "The full guest list by email, replacing the current one",
          })
        ),
        id: Type.String({ description: "The event id from calendar_events" }),
      }),
      structuredOutputSchema: Type.Union([Event, Asked]),
    }),
  },
  {
    flow: true,
    phrase: "removing a calendar event",
    tool: defineTool({
      description:
        "Delete an event from the user's calendar by its id. Guests get a cancellation. Unless he allowed it for good, it waits for his /yes.",
      execute: async (args, api, toolContext) =>
        typedOutcome(
          DeletedOutput,
          await approvals.request(
            api,
            toolContext,
            async ({ context, env }) => {
              const event = await readEvent(env, args.id, context);

              return {
                arguments: { ...args },
                grants:
                  event.guests.length === 0
                    ? ["deleting events without guests from your calendar"]
                    : [],
                run: async (where) => {
                  await programJson(
                    "gws",
                    EmptyResponse,
                    where.env,
                    [
                      "calendar",
                      "events",
                      "delete",
                      ...params({
                        calendarId: "primary",
                        eventId: args.id,
                        sendUpdates: "all",
                      }),
                    ],
                    where.context
                  );

                  return { deleted: args.id };
                },
                state: { event },
                summary: `delete the event ${quoted(event.summary)} on ${event.start}${event.guests.length === 0 ? "" : `, emailing a cancellation to ${quoted(event.guests.join(", "))}`}`,
                tool: "calendar_delete",
              };
            }
          )
        ),
      name: "calendar_delete",
      parameters: Type.Object({
        id: Type.String({ description: "The event id from calendar_events" }),
      }),
      structuredOutputSchema: Type.Union([DeletedOutput, Asked]),
    }),
  },
  {
    flow: true,
    phrase: "searching your Drive",
    tool: defineTool({
      description:
        "Find files in the user's Google Drive by words in their name or text. Read one with drive_read.",
      execute: async (args, api, context) => {
        const words = args.query
          .replaceAll("\\", "\\\\")
          .replaceAll("'", "\\'");

        const found = await programJson(
          "gws",
          DriveList,
          api.env,
          [
            "drive",
            "files",
            "list",
            ...params({
              fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
              orderBy: "modifiedTime desc",
              pageSize: Math.min(args.max ?? DEFAULT_MAX, MAX_SEARCH_RESULTS),
              q: `(name contains '${words}' or fullText contains '${words}') and trashed = false`,
            }),
          ],
          context
        );

        return typed(DriveSearchOutput, { files: found.files ?? [] });
      },
      name: "drive_search",
      parameters: Type.Object({
        max: Type.Optional(
          Type.Integer({ maximum: MAX_SEARCH_RESULTS, minimum: 1 })
        ),
        query: Type.String(),
      }),
      replay: "safe",
      structuredOutputSchema: DriveSearchOutput,
    }),
  },
  {
    flow: true,
    phrase: "reading a file from your Drive",
    tool: defineTool({
      description:
        "Read a Google Drive file by its id from drive_search or a Drive link. Docs and slides come back as text and sheets as CSV; other files, such as PDFs and images, are saved in the workspace's drive folder for read, bash or send_file.",
      execute: async (args, api, context) => {
        const id =
          /\/d\/(?<id>[\w-]+)/u.exec(args.file)?.groups?.id ?? args.file;

        const file = await programJson(
          "gws",
          DriveFile,
          api.env,
          [
            "drive",
            "files",
            "get",
            ...params({ fields: "id,name,mimeType,size", fileId: id }),
          ],
          context
        );

        const exportAs = EXPORTS.get(file.mimeType);

        if (exportAs === undefined && Number(file.size ?? 0) > MAX_FILE_BYTES) {
          throw new Error(
            `${file.name} is ${Math.round(Number(file.size) / (1024 * 1024))} MB, more than the ${MAX_FILE_BYTES / (1024 * 1024)} MB a workspace file may be. Ask the owner to open it in Drive.`
          );
        }

        const name = `${file.id}-${file.name.replaceAll(/[^\w.-]+/gu, "_")}${exportAs === undefined ? "" : ".txt"}`;
        const download = path.join(layout.downloads, randomUUID());

        mkdirSync(layout.downloads, { recursive: true });

        // gws writes only below its working folder, the data folder, which no tool can change. The file then
        // goes into the workspace through the same checks as the write tool, so a link there cannot redirect it.
        const target = path.relative(layout.dataDir, download);

        try {
          await programJson(
            "gws",
            EmptyResponse,
            api.env,
            exportAs === undefined
              ? [
                  "drive",
                  "files",
                  "get",
                  ...params({ alt: "media", fileId: id }),
                  "-o",
                  target,
                ]
              : [
                  "drive",
                  "files",
                  "export",
                  ...params({ fileId: id, mimeType: exportAs }),
                  "-o",
                  target,
                ],
            context
          );

          const content = readFileSync(download);
          const saved = path.join(layout.drive, name);

          await writeFile(saved, content, context);

          const workspacePath = path.relative(layout.workspace, saved);

          if (exportAs === undefined) {
            return typed(DriveReadOutput, { name: file.name, workspacePath });
          }

          const words = content.toString("utf-8");

          return typed(DriveReadOutput, {
            name: file.name,
            text:
              words.length > DRIVE_TEXT_CHARS
                ? `${words.slice(0, DRIVE_TEXT_CHARS)}\n[cut at ${DRIVE_TEXT_CHARS} characters; the whole text is in the workspace path]`
                : words,
            workspacePath,
          });
        } finally {
          rmSync(download, { force: true });
        }
      },
      name: "drive_read",
      parameters: Type.Object({
        file: Type.String({ description: "The file's id or its Drive link" }),
      }),
      replay: "safe",
      structuredOutputSchema: DriveReadOutput,
    }),
  },
];

/** What the tools prompt says about Google, when Google is set up. */
export const GOOGLE_PROMPT = `Google: gmail_draft and gmail_modify work at once. gmail_send, calendar_add, calendar_update and
calendar_delete wait for the owner's /yes on the exact action, unless he allowed that kind for good with /always.
Draft first when he may want to edit the wording himself.`;
