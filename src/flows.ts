import { randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import { Type } from "@earendil-works/pi-ai";
import type { ClassifierApi, ClassifierModel } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineExtension,
  defineTool,
  section,
} from "@earendil-works/pi-durable";
import { createCodemodeTool } from "@earendil-works/pi-durable/codemode";
import type { CodemodeToolOptions } from "@earendil-works/pi-durable/codemode";

import { isCalibrated } from "./classifier.ts";
import type { Layout } from "./layout.ts";
import { quoted, textOutcome } from "./tools/approvals.ts";
import type { Approvals } from "./tools/approvals.ts";
import { text } from "./tools/output.ts";
import type { ShrokTool, ToolCatalog } from "./tools/policy.ts";
import { registrations, wordsArg } from "./tools/policy.ts";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const LINE_BREAK = /[\n\r\u2028\u2029]/u;
const OPTIONS_LINE = /^\s*\/\/ @options:/mu;

const DESCRIPTION_LINE = /^\/\/ (?<text>.*)$/u;
const INPUT_LINE = /^\/\/ input: (?<text>.*)$/u;

interface Flow {
  readonly name: string;
  readonly description: string;
  readonly input: string;
}

const FlowRunDoc = defineDoc<{ code?: string }>({
  checkpointWhen: () => false,
  initial: () => ({}),
  kind: "shrok.flow.run",
  scope: "task",
  version: 1,
});

const fileOf = (dir: string, name: string): string =>
  path.join(dir, `${name}.js`);

const flowFile = (description: string, input: string, code: string): string =>
  `// ${description}\n// input: ${input}\n${code.trim()}\n`;

const folderIdentity = (dir: string) => {
  const stat = lstatSync(dir);

  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${dir} is not a plain folder. Flows cannot be saved.`);
  }

  return { dev: stat.dev, dir: realpathSync(dir), ino: stat.ino };
};

const fileState = (
  file: string
):
  | { readonly exists: false }
  | {
      readonly exists: true;
      readonly ino: number;
      readonly mtimeMs: number;
      readonly size: number;
      readonly symlink: boolean;
    } => {
  try {
    const stat = lstatSync(file);

    return {
      exists: true,
      ino: stat.ino,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      symlink: stat.isSymbolicLink(),
    };
  } catch {
    return { exists: false };
  }
};

const writeFlow = (
  identity: {
    readonly dev: number;
    readonly dir: string;
    readonly ino: number;
  },
  name: string,
  content: string
): void => {
  const now = folderIdentity(identity.dir);

  if (
    now.dev !== identity.dev ||
    now.ino !== identity.ino ||
    now.dir !== identity.dir
  ) {
    throw new Error("The flows folder changed after approval.");
  }

  const temp = path.join(identity.dir, `.${name}.${randomUUID()}.tmp`);
  const target = fileOf(identity.dir, name);

  // "wx" creates the file and fails if anything, a link included, is already at that path.
  const fd = openSync(temp, "wx", 0o644);

  try {
    writeSync(fd, content);
    const written = fstatSync(fd);

    renameSync(temp, target);
    const landed = lstatSync(target);

    if (landed.dev !== written.dev || landed.ino !== written.ino) {
      throw new Error(`${target} is not the file Shrok wrote.`);
    }
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  } finally {
    closeSync(fd);
  }
};

const listFlows = (dir: string): Flow[] =>
  readdirSync(dir)
    .filter((file) => file.endsWith(".js"))
    .map((file) => {
      const [first = "", second = ""] = readFileSync(
        path.join(dir, file),
        "utf-8"
      ).split("\n");

      return {
        description: DESCRIPTION_LINE.exec(first)?.groups?.text ?? "",
        input: INPUT_LINE.exec(second)?.groups?.text ?? "",
        name: file.slice(0, -".js".length),
      };
    })
    .toSorted((a, b) => a.name.localeCompare(b.name));

const prompt = (
  classifier: ClassifierModel<ClassifierApi>,
  flowTools: readonly string[]
): string => `# Flows

A flow is a saved code mode script for a task the user repeats, such as checking his mail or booking a
haircut. It does the same steps the same way every time, so prefer run_flow over doing the task by hand
whenever a flow below fits. Pass its input as a JSON object; the script reads it as \`input\`.

When the user asks for a flow, or a task he repeats has no flow, write one and save it with save_flow, which
waits for his /yes unless he allowed saving flows for good. A flow script is a code mode script with these rules:
- Call the supported typed tools (${flowTools.join(", ")}). They return parsed JSON. A flow cannot run another flow or bypass a blocked operation.
  Every child call passes the same capability checks as your own.
- A flow has no model of its own: for a step that needs judgment or writing, call transform_text, or
  models.classify for a choice, a score or a yes or no. Classify with
  models.getModelOfType("classifier", "${classifier.provider}", "${classifier.id}").${
    isCalibrated(classifier)
      ? ""
      : " Its probabilities are\n  always 0 or 1, not calibrated, so use the answer and ignore the number."
  }
- Check what each step returns and throw an Error with a plain reason when the flow can't go on.
- End with \`return\` of what the user should read.
- No \`// @options\` line.

You may try a script once with codemode before you save it, unless it sends, books or pays.`;

export const createFlows = (
  layout: Layout,
  codemode: CodemodeToolOptions,
  approvals: Approvals,
  classifier: ClassifierModel<ClassifierApi>,
  catalog: ToolCatalog
) => {
  const dir = layout.flows;
  const runner = createCodemodeTool(codemode);

  mkdirSync(dir, { recursive: true });

  const tools: ShrokTool[] = [
    {
      phrase: "saving a flow",
      tool: defineTool({
        callers: ["model"],
        description:
          "Save a flow, a code mode script for a task the user repeats. Saving with an existing name replaces it. Waits for his /yes unless he allowed saving flows for good.",
        execute: async (args, api) => {
          if (!NAME.test(args.name)) {
            return text(
              `"${args.name}" is not a flow name: use lowercase letters, digits and hyphens.`
            );
          }

          if (
            LINE_BREAK.test(args.description) ||
            LINE_BREAK.test(args.input)
          ) {
            return text(
              "Write the description and the input on one line each."
            );
          }

          if (OPTIONS_LINE.test(args.code)) {
            return text("Take out the // @options line and save again.");
          }

          const content = flowFile(args.description, args.input, args.code);

          return textOutcome(
            await approvals.request(api, () => {
              const identity = folderIdentity(dir);
              const existing = fileState(fileOf(identity.dir, args.name));

              return {
                arguments: { ...args },
                grants: ["saving flows"],
                run: async () => {
                  writeFlow(identity, args.name, content);

                  return `Saved the flow ${args.name}. Run it with run_flow.`;
                },
                state: { existing, identity },
                summary: `${existing.exists ? "replace" : "save"} the flow \`${args.name}\`: ${quoted(args.description)}`,
                tool: "save_flow",
              };
            })
          );
        },
        name: "save_flow",
        parameters: Type.Object(
          {
            code: Type.String({
              description:
                "The script: a code mode script body that reads `input` and ends with return",
            }),
            description: Type.String({
              description:
                "One sentence: what the flow does and when to use it",
            }),
            input: Type.String({
              description:
                "The input object's fields, such as { subject: string }, or {} for none",
            }),
            name: Type.String({
              description: "Lowercase letters, digits and hyphens",
            }),
          },
          { additionalProperties: false }
        ),
        replay: "unsafe",
      }),
    },
    {
      describe: (args) => {
        const name = wordsArg(args, "name");

        return name === undefined ? undefined : `running the flow ${name}`;
      },
      phrase: "running a flow",
      tool: defineTool({
        callers: ["model"],
        description:
          "Run a saved flow by name. Its tool calls run as the flow says; what it returns is its result.",
        execute: async (args, api, context) => {
          if (!NAME.test(args.name)) {
            throw new Error(`No flow is named "${args.name}".`);
          }

          const code = await api.commit(async (tx) => {
            const run = await tx.doc(FlowRunDoc, api.taskId);

            run.code ??= readFileSync(fileOf(dir, args.name), "utf-8");

            return run.code;
          }, context);

          return await runner.execute(
            {
              code: `const input = ${JSON.stringify(args.input ?? {})};\n${code}`,
            },
            api,
            context
          );
        },
        name: "run_flow",
        parameters: Type.Object({
          input: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description: "The flow's input as a JSON object",
            })
          ),
          name: Type.String(),
        }),
        replay: "safe",
      }),
    },
  ];

  const extension = defineExtension({
    name: "flows",
    sections: [
      section("flows", () => {
        const flows = listFlows(dir);

        return `${prompt(classifier, catalog.flowTools())}\n\n${
          flows.length === 0
            ? "No flows saved yet."
            : `Saved flows:\n${flows.map((flow) => `- ${flow.name}: ${flow.description} Input: ${flow.input}`).join("\n")}`
        }`;
      }),
    ],
    tools: registrations(tools),
  });

  return { extension, tools };
};
