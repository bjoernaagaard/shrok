import type { Context } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { watchEvents } from "@earendil-works/pi-durable";
import type {
  AgentEvent,
  AgentEventStream,
  ConversationId,
  Harness,
  JsonObject,
  SubmissionId,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";

export interface Progress {
  readonly text: string;
  readonly activity: string | undefined;
  readonly steps: number;
}

export type ShowProgress = (progress: Progress) => void;

const blockTexts = (message: AssistantMessage): string[] =>
  message.content.map((block) => (block.type === "text" ? block.text : ""));

const MAX_QUERY_CHARS = 40;

const Words = Type.String({ pattern: "\\S" });

const stringArg = (args: JsonObject, key: string): string | undefined => {
  const value = args[key];

  return Value.Check(Words, value) ? value.trim() : undefined;
};

const siteOf = (url: string | undefined): string | undefined => {
  if (url === undefined || !URL.canParse(url)) {
    return undefined;
  }

  return new URL(url).hostname.replace(/^www\./u, "");
};

const quoted = (text: string): string =>
  text.length > MAX_QUERY_CHARS
    ? `"${text.slice(0, MAX_QUERY_CHARS)}…"`
    : `"${text}"`;

const PHRASES = new Map<string, string>([
  ["bash", "running a command"],
  ["browser_click", "clicking on the page"],
  ["browser_read", "reading the page"],
  ["browser_type", "typing on the page"],
  ["calendar_add", "adding to your calendar"],
  ["calendar_events", "reading your calendar"],
  ["cancel_schedule", "cancelling a schedule"],
  ["codemode", "running a script"],
  ["date", "remembering"],
  ["gmail_draft", "drafting an email"],
  ["gmail_read", "reading an email"],
  ["gmail_search", "searching your email"],
  ["gmail_send", "sending an email"],
  ["read", "reading a file"],
  ["save_flow", "saving a flow"],
  ["save_item", "saving it"],
  ["schedule", "setting a schedule"],
  ["schedules", "checking your schedules"],
  ["search_items", "searching your saved items"],
  ["send_file", "sending you a file"],
  ["tool_search", "looking for a tool"],
  ["transform_text", "writing"],
  ["write", "writing a file"],
  ["edit", "editing a file"],
  ["x_read_post", "reading a post on X"],
  ["x_read_post", "reading a post on X"],
  ["zoom", "remembering"],
]);

const activityOf = (
  phrases: ReadonlyMap<string, string>,
  tool: string,
  args: JsonObject
): string => {
  const query = stringArg(args, "query");
  const site = siteOf(stringArg(args, "url"));
  const program = stringArg(args, "program");
  const flow = stringArg(args, "name");

  if (tool === "web_search" && query !== undefined) {
    return `searching the web for ${quoted(query)}`;
  }

  if ((tool === "web_fetch" || tool === "browser_open") && site !== undefined) {
    return `reading ${site}`;
  }

  if (tool === "run_program" && program !== undefined) {
    return program === "xurl" ? "using X" : "using Google";
  }

  if (tool === "run_flow" && flow !== undefined) {
    return `running the flow ${flow}`;
  }

  return phrases.get(tool) ?? `using ${tool.replaceAll("_", " ")}`;
};

export class Partials {
  readonly #phrases: ReadonlyMap<string, string>;
  readonly #listeners = new Map<SubmissionId, ShowProgress>();

  constructor(extraPhrases: Readonly<Record<string, string>> = {}) {
    this.#phrases = new Map([...PHRASES, ...Object.entries(extraPhrases)]);
  }
  #running: readonly SubmissionId[] = [];
  #blocks: string[] = [];
  #activity: string | undefined;
  #steps = 0;
  #stream: AgentEventStream | undefined;

  async attach(
    harness: Harness,
    conversationId: ConversationId,
    context: Context
  ): Promise<void> {
    const stream = await watchEvents(harness, conversationId, context);

    stream.start(async (events) => {
      for (const event of events) {
        this.#apply(event);
      }
    });
    this.#stream = stream;
  }

  listen(submission: SubmissionId, show: ShowProgress): void {
    this.#listeners.set(submission, show);
  }

  forget(submission: SubmissionId): void {
    this.#listeners.delete(submission);
  }

  busy(): boolean {
    return this.#running.length > 0;
  }

  async close(): Promise<void> {
    await this.#stream?.stop();
  }

  #apply(event: AgentEvent): void {
    if (event.type === "snapshot") {
      this.#running = event.run?.inputs ?? [];
    } else if (event.type === "run_start") {
      this.#running = event.inputs;
      this.#blocks = [];
      this.#activity = undefined;
      this.#steps = 0;
    } else if (event.type === "run_end") {
      this.#running = [];
    } else if (event.type === "tool_execution_start") {
      this.#activity = activityOf(this.#phrases, event.toolName, event.args);
      this.#steps += 1;
      this.#show();
    } else if (
      event.type === "message_start" &&
      event.message.role === "assistant"
    ) {
      this.#blocks = blockTexts(event.message);
    } else if (event.type === "message_update") {
      for (const change of event.changes) {
        if (change.type === "message") {
          this.#blocks = blockTexts(change.message);
        } else if (change.type === "text_start" || change.type === "block") {
          this.#blocks[change.contentIndex] =
            change.block.type === "text" ? change.block.text : "";
        } else if (change.type === "text_delta") {
          this.#blocks[change.contentIndex] =
            `${this.#blocks[change.contentIndex] ?? ""}${change.delta}`;
        }
      }

      this.#show();
    }
  }

  #show(): void {
    const progress: Progress = {
      activity: this.#activity,
      steps: this.#steps,
      text: this.#blocks
        .filter((block) => block.trim() !== "")
        .join("\n\n")
        .trim(),
    };

    for (const input of this.#running) {
      this.#listeners.get(input)?.(progress);
    }
  }
}
