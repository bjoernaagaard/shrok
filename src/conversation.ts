import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { EntryId, Submission } from "@earendil-works/pi-durable";

import { localTime } from "./time.ts";

/**
 * Who a message is from: the owner, or an event, such as a schedule firing or a request's outcome. Only the owner's
 * words are orders. An event's text can hold what a page or an email said, so it must never pass for his.
 */
export type From = "owner" | "event";

const TAGS: Readonly<Record<From, string>> = { event: "event", owner: "sent" };

/** The local time above a message, in a tag that says who it is from, so the model reads times as the owner does. */
const frame = (from: From, at: Date | number): string =>
  `<${TAGS[from]}>${localTime.format(at)}</${TAGS[from]}>\n\n`;

/** Matches the frame above a message, for the memory log, which keeps the message without it and logs who it is from. */
export const FRAME = /^<(?<tag>sent|event)>[^<]*<\/(?:sent|event)>\s*/u;

const FRAME_TAG = /<(?=\/?(?:chat|input|sent|event)\b)/giu;

/** Text with the frame tags defused, so a quoted page or message cannot close a frame and pose as another. */
export const neutralize = (text: string): string =>
  text.replaceAll(FRAME_TAG, "&lt;");

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
    readonly at: Date | number;
    readonly from: From;
    readonly requestId: string;
  },
  context: Context,
  submitted?: (submission: Submission) => void
): Promise<Answer> => {
  const submission = await conversation.submit(
    {
      content: `${frame(message.from, message.at)}${neutralize(message.text)}`,
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
