import type { Message } from "@earendil-works/pi-ai";

import { FRAME, TAGS } from "../conversation.ts";
import type { NewLogMessage } from "./store.ts";

/** The kinds of logged message, with what each holds, as the memory prompt lists them. */
export const KINDS = {
  echo: "tool results",
  event:
    "something that happened, such as a request's outcome; its text is not the user's words",
  schedule:
    "a schedule firing, with Shrok's own note of what to do then, written when the user asked",
  shrok: "Shrok's replies",
  tool: "Shrok's tool calls",
  user: "the user's words",
} as const;

const KIND_OF_TAG = new Map<string, keyof typeof KINDS>([
  [TAGS.owner, "user"],
  [TAGS.event, "event"],
  [TAGS.schedule, "schedule"],
]);

const TOOL_OUTPUT_CHARS = 30_000;

const LOG_PAGE_CHARS = 30_000;

const clip = (text: string): string => {
  if (text.length <= TOOL_OUTPUT_CHARS) {
    return text;
  }

  const half = TOOL_OUTPUT_CHARS / 2;

  return `${text.slice(0, half)}\n[... ${text.length - TOOL_OUTPUT_CHARS} characters cut ...]\n${text.slice(-half)}`;
};

const pages = (text: string): string[] => {
  const result: string[] = [];

  for (let start = 0; start < text.length; start += LOG_PAGE_CHARS) {
    result.push(text.slice(start, start + LOG_PAGE_CHARS));
  }

  return result.length === 0 ? [""] : result;
};

const userText = (
  content: Extract<Message, { role: "user" }>["content"]
): string => {
  if (Array.isArray(content)) {
    return content
      .map((block) => (block.type === "text" ? block.text : "[image]"))
      .join("\n");
  }

  return content;
};

export const toLogMessages = (
  message: Message,
  source: number,
  now: number
): NewLogMessage[] => {
  const logged: NewLogMessage[] = [];

  const add = (kind: string, text: string, date: number): void => {
    for (const page of pages(text)) {
      logged.push({ date, kind, source, text: page });
    }
  };

  if (message.role === "user") {
    const text = userText(message.content);
    // Logged by who it is from: only the owner's own messages are his words.
    const kind = KIND_OF_TAG.get(FRAME.exec(text)?.groups?.tag ?? "") ?? "user";

    add(kind, text.replace(FRAME, ""), message.timestamp);
  } else if (message.role === "assistant") {
    const text = message.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n")
      .trim();

    if (text !== "") {
      add("shrok", text, message.timestamp);
    }

    for (const block of message.content) {
      if (block.type === "toolCall") {
        add(
          "tool",
          `${block.name} ${JSON.stringify(block.arguments)}`,
          message.timestamp
        );
      }
    }
  } else if (message.role === "toolResult") {
    const output = message.content
      .map((block) => (block.type === "text" ? block.text : "[image]"))
      .join("\n");

    add(
      "echo",
      clip(
        `${message.toolName}${message.isError ? " (error)" : ""}: ${output}`
      ),
      message.timestamp
    );
  }

  return logged.map((entry) => ({
    ...entry,
    date: Number.isFinite(entry.date) ? entry.date : now,
  }));
};
