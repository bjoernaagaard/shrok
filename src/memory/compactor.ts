import type {
  Api,
  Context,
  Model,
  Models,
  TextContent,
} from "@earendil-works/pi-ai";

import { PROMPT } from "../prompt.ts";
import { markViewCache } from "./cache.ts";

export const LINE_BYTES = 512;

const ATTEMPTS = 5;
const RULER = "-".repeat(LINE_BYTES);
const LINE_HEAD = /^\d+\+\d+\|/u;

const bytes = (text: string): number => Buffer.byteLength(text, "utf-8");

const FRAME_TAG = /<(?=\/?(?:chat|input|sent)\b)/giu;

/** Stored text with its frame tags defused, so a message cannot close <chat> or <input> and pose as another. */
export const neutralize = (text: string): string =>
  text.replaceAll(FRAME_TAG, "&lt;");

const toLine = (text: string): string =>
  text
    .replaceAll(/\s*\n\s*/gu, " ")
    .trim()
    .replace(LINE_HEAD, "");

export const compressTask = (id: number, kind: string, text: string): string =>
  `Compaction: compress message ${id} into one line of at most ${LINE_BYTES} bytes
(about 70 words), the length of this ruler:
${RULER}
<input>
${neutralize(kind)}: ${neutralize(text)}
</input>`;

export const mergeTask = (
  names: readonly [string, string],
  range: readonly [number, number],
  lines: readonly [string, string]
): string =>
  `Compaction: merge lines ${names[0]} and ${names[1]}, adjacent, into one line of at most
${LINE_BYTES} bytes (about 70 words), the length of this ruler:
${RULER}
<chat> may hold their messages, ${range[0]} to ${range[1]}, in more detail: take details
of them from there too.
<input>
${neutralize(lines[0])}
${neutralize(lines[1])}
</input>`;

const tooLong = (line: string): string =>
  `Too long: your line is ${bytes(line)} bytes, over the ${LINE_BYTES}-byte limit. Write
the whole line again for the same <input>, cutting just enough of the
least valuable items to fit before this cut:
${Buffer.from(line, "utf-8").subarray(0, LINE_BYTES).toString("utf-8")}| ← LIMIT`;

const shorter = (a: string | undefined, b: string): string =>
  a !== undefined && bytes(a) <= bytes(b) ? a : b;

const attempt = async (
  models: Models,
  model: Model<Api>,
  context: Context,
  tries: number,
  signal: AbortSignal,
  shortest?: string
): Promise<string> => {
  const reply = await models.completeSimple(model, context, {
    onPayload: markViewCache,
    reasoning: "high",
    signal,
  });

  if (reply.stopReason === "error" || reply.stopReason === "aborted") {
    throw new Error(
      `Compaction failed: ${reply.errorMessage ?? reply.stopReason}`
    );
  }

  const line = toLine(
    reply.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join(" ")
  );

  const best = shorter(shortest, line);

  if (bytes(line) <= LINE_BYTES || tries <= 1) {
    return Buffer.from(best, "utf-8")
      .subarray(0, LINE_BYTES)
      .toString("utf-8")
      .replace(/\uFFFD$/u, "");
  }

  const retry: Context = {
    ...context,
    messages: [
      ...context.messages,
      reply,
      { content: tooLong(line), role: "user", timestamp: Date.now() },
    ],
  };

  return await attempt(models, model, retry, tries - 1, signal, best);
};

export const compact = async (
  models: Models,
  model: Model<Api>,
  chat: TextContent[],
  task: string,
  signal: AbortSignal
): Promise<string> =>
  await attempt(
    models,
    model,
    {
      messages: [
        {
          content: [...chat, { text: task, type: "text" }],
          role: "user",
          timestamp: Date.now(),
        },
      ],
      systemPrompt: PROMPT,
    },
    ATTEMPTS,
    signal
  );
