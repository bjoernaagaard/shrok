import type { StreamOptions, TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

const LINES_PER_BLOCK = 4;

const OPEN = "<chat>\n";
const CLOSE = "</chat>";

export const chatBlocks = (lines: readonly string[]): TextContent[] => {
  const blocks: TextContent[] = [];

  for (let start = 0; start < lines.length; start += LINES_PER_BLOCK) {
    const text = lines
      .slice(start, start + LINES_PER_BLOCK)
      .map((line) => `${line}\n`)
      .join("");

    blocks.push({ text: start === 0 ? `${OPEN}${text}` : text, type: "text" });
  }

  if (blocks.length === 0) {
    blocks.push({ text: OPEN, type: "text" });
  }

  blocks.push({ text: CLOSE, type: "text" });

  return blocks;
};

const BlockSchema = Type.Object({
  cache_control: Type.Optional(Type.Object({ type: Type.String() })),
  text: Type.Optional(Type.String()),
  type: Type.String(),
});

const PayloadSchema = Type.Object({
  messages: Type.Array(
    Type.Object({
      content: Type.Union([Type.String(), Type.Array(BlockSchema)]),
    })
  ),
});

type Block = Static<typeof BlockSchema>;

const lineCount = (block: Block): number =>
  (block.text ?? "").replace(OPEN, "").split("\n").length - 1;

/**
 * Adds one Anthropic cache mark on the view's last whole block. The provider marks the request's end
 * itself; Anthropic then finds this mark from the next call, whose view only grew at its end.
 */
export const markViewCache: NonNullable<StreamOptions["onPayload"]> = (
  payload
) => {
  if (!Value.Check(PayloadSchema, payload)) {
    return payload;
  }

  for (const { content } of payload.messages) {
    const close = Array.isArray(content)
      ? content.findIndex((block) => block.text === CLOSE)
      : -1;

    if (Array.isArray(content) && close > 0) {
      const last = content[close - 1];

      const whole =
        last !== undefined && lineCount(last) === LINES_PER_BLOCK
          ? last
          : content[close - 2];

      if (whole !== undefined) {
        whole.cache_control = { type: "ephemeral" };
      }

      return payload;
    }
  }

  return payload;
};
