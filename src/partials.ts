import type { Context } from "@earendil-works/chord/context";
import { LiveDoc } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  DocumentWatch,
  Harness,
  JsonObject,
  LiveState,
  SubmissionId,
} from "@earendil-works/pi-durable";

import { report } from "./events.ts";

export interface Progress {
  readonly text: string;
  readonly activity: string | undefined;
  readonly steps: number;
}

export type ShowProgress = (progress: Progress) => void;

/** The words the phone shows for a tool call, such as "reading your calendar". */
export type PhraseOf = (tool: string, args: JsonObject) => string;

type StreamedMessage = NonNullable<
  NonNullable<LiveState["generation"]>["message"]
>;

/**
 * Follows the conversation's live state and tells each listening request how its answer is coming along: the text
 * so far, the tool running now, and how many tools ran.
 */
export class Partials {
  readonly #phraseOf: PhraseOf;
  readonly #listeners = new Map<SubmissionId, ShowProgress>();
  /** The arguments of the tool calls streamed in the current run, by call ID. */
  readonly #arguments = new Map<string, JsonObject>();
  /** The tool calls of the current run that already counted as a step. */
  readonly #started = new Set<string>();
  #run: SubmissionId | undefined;
  #running: readonly SubmissionId[] = [];
  #text = "";
  #activity: string | undefined;
  #watch: DocumentWatch<LiveState> | undefined;

  constructor(phraseOf: PhraseOf) {
    this.#phraseOf = phraseOf;
  }

  async attach(
    harness: Harness,
    conversationId: ConversationId,
    context: Context
  ): Promise<void> {
    const watch = await harness.watchDoc(LiveDoc, conversationId, context);

    if (watch === undefined) {
      throw new Error("The conversation has no live state to follow.");
    }

    this.#apply(watch.value);
    watch.start(async (call) => {
      if (call.kind === "value") {
        this.#apply(call.value);
      }
    });
    this.#watch = watch;
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
    await this.#watch?.stop();
  }

  #apply(live: Readonly<LiveState>): void {
    this.#running = live.run?.inputs ?? [];

    const [run] = this.#running;

    if (run !== this.#run) {
      this.#run = run;
      this.#arguments.clear();
      this.#started.clear();
      this.#text = "";
      this.#activity = undefined;
    }

    const message = live.generation?.message;

    if (message !== undefined) {
      this.#read(message);
    }

    for (const slot of live.tools ?? []) {
      if (slot.status !== "pending" && !this.#started.has(slot.callId)) {
        this.#started.add(slot.callId);
        this.#activity = this.#phraseOf(
          slot.name,
          this.#arguments.get(slot.callId) ?? {}
        );
      }
    }

    const progress: Progress = {
      activity: this.#activity,
      steps: this.#started.size,
      text: this.#text,
    };

    for (const input of this.#running) {
      try {
        this.#listeners.get(input)?.(progress);
      } catch (error) {
        report("phone", `Could not show progress: ${String(error)}`);
      }
    }
  }

  /** The streamed answer's text, and the arguments of the tool calls it makes. */
  #read(message: Readonly<StreamedMessage>): void {
    const texts: string[] = [];

    for (const block of message.content) {
      if (block.type === "text" && block.text.trim() !== "") {
        texts.push(block.text);
      } else if (block.type === "toolCall") {
        this.#arguments.set(block.id, block.arguments);
      }
    }

    this.#text = texts.join("\n\n").trim();
  }
}
