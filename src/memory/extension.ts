import { Type } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  section,
} from "@earendil-works/pi-durable";

import { PROMPT } from "../prompt.ts";
import { localTime } from "../time.ts";
import type { Memory } from "./memory.ts";

const endsRun = (message: Message): boolean =>
  message.role === "assistant" &&
  !message.content.some((block) => block.type === "toolCall");

const turnStart = (messages: readonly Message[]): number => {
  for (let position = messages.length - 1; position >= 0; position -= 1) {
    const message = messages[position];

    if (message !== undefined && endsRun(message)) {
      return position + 1;
    }
  }

  return 0;
};

export const createMemoryExtension = (memory: Memory) =>
  defineExtension({
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async ({ messages }, api) => {
          memory.sync(messages);

          const start = turnStart(messages);
          const past = messages.slice(0, start);
          const turn = messages.slice(start);

          const turnBody = turn.findIndex(
            (message) => message.role !== "system"
          );

          const cacheStableSystemMessages = [
            ...past,
            ...turn.slice(0, Math.max(turnBody, 0)),
          ].filter((message) => message.role === "system");

          const firstOfTurn = memory.firstMessageFrom(
            past.filter((message) => message.role !== "system").length
          );

          const view = await memory.viewFor(api.taskId, firstOfTurn);

          return {
            messages: [
              ...cacheStableSystemMessages,
              { content: view, role: "user", timestamp: 0 },
              ...turn.slice(Math.max(turnBody, 0)),
            ],
          };
        },
        onYield: (answer) => {
          memory.logAnswer(answer);
        },
      }),
    ],
    name: "memory",
    sections: [section("prompt", () => PROMPT, { tag: false })],
    tools: [
      defineTool({
        description:
          "Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole. n is a power of 2, and id a multiple of n.",
        execute: async (args) => ({
          output: [{ text: memory.zoom(args.id, args.n), type: "text" }],
        }),
        name: "zoom",
        parameters: Type.Object({
          id: Type.Integer({ minimum: 0 }),
          n: Type.Integer({ minimum: 1 }),
        }),
        replay: "safe",
      }),
      defineTool({
        description: "The date and time of message id.",
        execute: async (args) => {
          const date = memory.date(args.id);

          return {
            output: [
              {
                text:
                  date === undefined
                    ? `No message ${args.id}.`
                    : localTime.format(date),
                type: "text",
              },
            ],
          };
        },
        name: "date",
        parameters: Type.Object({ id: Type.Integer({ minimum: 0 }) }),
        replay: "safe",
      }),
    ],
  });
