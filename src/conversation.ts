import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { EntryId, Submission } from "@earendil-works/pi-durable";

import { localTime } from "./time.ts";

/** The local time a message was sent, put above it so the model reads times as the owner does. */
const sentFrame = (sentAt: Date | number): string =>
  `<sent>${localTime.format(sentAt)}</sent>\n\n`;

/** Matches the frame `framed` puts above a message, for the memory log, which keeps the message without it. */
export const SENT_FRAME = /^<sent>[^<]*<\/sent>\s*/u;

/** The text of every assistant message in an answer entry's model messages. */
const answerText = (model: readonly { role: string }[] | undefined): string =>
  (model ?? [])
    .filter(
      (message): message is AssistantMessage => message.role === "assistant"
    )
    .flatMap((message) => message.content)
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n\n")
    .trim();

export type Answer =
  | { readonly answered: true; readonly text: string }
  | { readonly answered: false; readonly reason: string };

interface Asking {
  readonly submit: (
    draft: { content: string; requestId: string; type: "input" },
    context: Context
  ) => Promise<Submission>;
  /** Reads an answer entry's model messages. */
  readonly answerOf: (
    id: EntryId
  ) => Promise<readonly { role: string }[] | undefined>;
}

/**
 * Asks the conversation once per `requestId` and waits for its answer: asking again with the same ID returns the
 * stored answer. `submitted` sees the submission before the wait, such as to show its progress.
 */
export const ask = async (
  conversation: Asking,
  message: {
    readonly text: string;
    readonly sentAt: Date | number;
    readonly requestId: string;
  },
  context: Context,
  submitted?: (submission: Submission) => void
): Promise<Answer> => {
  const submission = await conversation.submit(
    {
      content: `${sentFrame(message.sentAt)}${message.text}`,
      requestId: message.requestId,
      type: "input",
    },
    context
  );

  submitted?.(submission);

  const settled = await submission.wait(context);

  if (settled.status !== "done" || settled.type !== "input") {
    return {
      answered: false,
      reason: settled.status === "unanswered" ? settled.reason : settled.status,
    };
  }

  return {
    answered: true,
    text: answerText(await conversation.answerOf(settled.answer)),
  };
};
