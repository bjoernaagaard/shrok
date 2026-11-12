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

export interface Progress {
  readonly text: string;
  readonly activity: string | undefined;
  readonly steps: number;
}

export type ShowProgress = (progress: Progress) => void;

const blockTexts = (message: AssistantMessage): string[] =>
  message.content.map((block) => (block.type === "text" ? block.text : ""));

/** The words the phone shows for a tool call, such as "reading your calendar". */
export type PhraseOf = (tool: string, args: JsonObject) => string;

export class Partials {
  readonly #phraseOf: PhraseOf;
  readonly #listeners = new Map<SubmissionId, ShowProgress>();
  #running: readonly SubmissionId[] = [];
  #blocks: string[] = [];
  #activity: string | undefined;
  #steps = 0;
  #stream: AgentEventStream | undefined;

  constructor(phraseOf: PhraseOf) {
    this.#phraseOf = phraseOf;
  }

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
      this.#activity = this.#phraseOf(event.toolName, event.args);
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
