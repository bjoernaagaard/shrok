import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";

import { isInside, isSecret } from "../paths.ts";
import { text as reply } from "./output.ts";
import type { ShrokTool } from "./policy.ts";

export type SendFile = (file: string, caption: string) => Promise<void>;

export const createSendFileTool = (
  workspace: string,
  sender: Promise<SendFile>
): ShrokTool => ({
  phrase: "sending you a file",
  tool: defineTool({
    description:
      "Send a file from the workspace to the user's phone, such as a PDF, an image, a screenshot or a spreadsheet. Images show as pictures. Use it when the user asks for a file, or when a file says more than text would.",
    execute: async (args) => {
      const file = path.resolve(workspace, args.path);

      if (!isInside(file, workspace) || isSecret(file)) {
        return reply(
          `Only files inside the workspace, ${workspace}, can be sent.`
        );
      }

      if (!existsSync(file) || !statSync(file).isFile()) {
        return reply(`There is no file at ${args.path}.`);
      }

      const send = await sender;

      await send(file, args.caption ?? "");

      return reply(`Sent ${path.basename(file)} to his phone.`);
    },
    name: "send_file",
    parameters: Type.Object({
      caption: Type.Optional(
        Type.String({ description: "A short line shown under the file" })
      ),
      path: Type.String({ description: "The file, relative to the workspace" }),
    }),
  }),
});
