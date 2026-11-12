import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

/** A tool result the model reads as text. */
export const text = (value: string) => ({
  output: [{ text: value, type: "text" as const }],
});

/** A tool result with structured output, which code mode scripts and flows read as parsed JSON. */
export const typed = <T extends TSchema>(schema: T, value: Static<T>) => ({
  output: [{ text: JSON.stringify(value, null, 2), type: "text" as const }],
  structuredOutput: Value.Parse(schema, value),
});
