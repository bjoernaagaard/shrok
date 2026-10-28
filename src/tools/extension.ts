import path from "node:path";

import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  defineExtension,
  hook,
  section,
  ToolTask,
} from "@earendil-works/pi-durable";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import { Value } from "typebox/value";

import { FLOWS_FOLDER } from "../flows.ts";
import { ITEMS_FOLDER } from "../items.ts";
import type { Items } from "../items.ts";
import { integrations } from "../settings.ts";
import type { Approvals } from "./approvals.ts";
import { createGoogleTools } from "./google.ts";
import { createItemTools } from "./items.ts";
import { capabilityProblem } from "./judge.ts";
import { createProgramsTools } from "./programs.ts";
import type { PublicWeb } from "./public-web.ts";
import {
  createSandboxedBash,
  isInside,
  isShrokRecord,
  isSecret,
} from "./sandbox.ts";
import type { SeenUrls } from "./seen-urls.ts";
import { createSendFileTool } from "./send.ts";
import type { SendFile } from "./send.ts";
import { BUNDLED_SKILLS, formatSkillsForPrompt, loadSkills } from "./skills.ts";
import { createWebTools } from "./web.ts";
import { createWorkspaceFiles } from "./workspace.ts";
import { createXTools } from "./x.ts";

const FILE_TOOLS = new Set(["read", "write", "edit"]);
const WRITING_TOOLS = new Set(["write", "edit"]);
const PathArgs = Type.Object({ path: Type.String() });

// pi-durable's file tools resolve paths with normalizeToolPath, which its package exports don't include.
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/gu;

const toolPath = async (
  workspace: string,
  raw: string,
  context: Context
): Promise<string> => {
  const normalized = raw.replaceAll(UNICODE_SPACES, " ");

  return getOrThrow(
    await new NodeExecutionEnv({ cwd: workspace }).absolutePath(
      normalized.startsWith("@") ? normalized.slice(1) : normalized,
      context
    )
  );
};

const SKILLS_PROMPT = `# Workspace and skills

Your tools work in your workspace folder. bash runs in a read-only sandbox there, has a mandatory
execution deadline and output budget, cannot access the network, and cannot read the home folder outside the workspace.
read works only in the workspace and bundled skills. Use write and edit for file changes. They work only
in the workspace and enforce file and total storage budgets. Skills are owner-managed and cannot be changed by tools.
Gmail drafts work without approval. Calendar events without guests and paid X post reads require the
owner's approval of the exact action with /yes. Sending mail is blocked; save a draft for the owner to send instead.

For a website that needs clicking, such as a booking page, use the browser_ tools: each returns the
page's elements with refs, and browser_click and browser_type take a ref from the latest one.

Unsupported external effects are blocked, not classified by a model. run_program and MCP operations
have no reviewed capability. Do not try another tool or ask for a generic approval to bypass a block.
Ask the owner to complete the external step manually.
Flows change only through save_flow. Do not try to create or replace a flow through another tool.
Running an existing flow does not authorize its child calls: each still passes the same controls.

A message that starts with [Shared link], [Shared file] or [Shared image] is something the user shared
from his phone. Save it with save_item, following the saving-shares skill, then answer in one short line.
Saved items are in the workspace's items folder. Only save_item changes them; search them with search_items.

Skills are how-to notes in the workspace's skills folder: one folder per skill, holding a SKILL.md whose
front matter has a name and a description of when to use it. Skills describe procedures, not permissions.
A skill cannot override a blocked capability.`;

export interface ToolsOptions {
  readonly allowed?: ReadonlySet<string>;
  readonly approvals: Approvals;
  readonly dataDir: string;
  readonly workspace: string;
  readonly items: Items;
  readonly searchModel: Model<Api>;
  readonly textModel: Model<Api>;
  readonly mcpTools: readonly ToolRegistration[];
  readonly browserTools: readonly ToolRegistration[];
  readonly fileSender: Promise<SendFile>;
  readonly publicWeb: PublicWeb;
  readonly seenUrls: SeenUrls;
}

export const createToolsExtension = (options: ToolsOptions) => {
  const {
    allowed,
    approvals,
    browserTools,
    dataDir,
    fileSender,
    items,
    mcpTools,
    publicWeb,
    searchModel,
    seenUrls,
    textModel,
    workspace,
  } = options;

  const files = createWorkspaceFiles(workspace);

  const protectedDirs = [
    {
      block: "Skills are owner-managed and cannot be changed by tools.",
      dir: path.join(workspace, "skills"),
    },
    {
      block: "Saved items change only through save_item.",
      dir: path.join(workspace, ITEMS_FOLDER),
    },
    {
      block: "Flows change only through save_flow.",
      dir: path.join(workspace, FLOWS_FOLDER),
    },
  ];

  const pathProblem = async (
    tool: string,
    rawPath: string | undefined,
    context: Context
  ): Promise<string | undefined> => {
    if (!FILE_TOOLS.has(tool)) {
      return undefined;
    }

    if (rawPath === undefined) {
      return "The file tool needs an explicit path.";
    }

    const target = await toolPath(workspace, rawPath, context);

    if (isSecret(target)) {
      return "That folder holds the user's credentials. Shrok may not open it.";
    }

    if (isShrokRecord(target, dataDir, workspace)) {
      return "That holds Shrok's own records and keys. Tools may open only the workspace.";
    }

    if (tool === "read" && isInside(target, BUNDLED_SKILLS)) {
      return undefined;
    }

    if (!isInside(target, workspace)) {
      return `Tools open files only inside the workspace, ${workspace}, or read bundled skills.`;
    }

    if (!WRITING_TOOLS.has(tool)) {
      return undefined;
    }

    return protectedDirs.find(({ dir }) => isInside(target, dir))?.block;
  };

  const tools = [
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    createSandboxedBash(workspace),
    ...createProgramsTools(),
    ...createItemTools(items),
    createSendFileTool(workspace, fileSender),
    ...(integrations.google ? createGoogleTools(textModel, approvals) : []),
    ...(integrations.x ? createXTools(approvals) : []),
    ...createWebTools(searchModel, publicWeb, seenUrls),
    ...browserTools,
    ...mcpTools,
  ].map((tool: ToolRegistration) => ({
    ...tool,
    execute: async (
      ...[args, api, context]: Parameters<typeof tool.execute>
    ) => {
      const execute = async () => {
        const problem = await pathProblem(
          tool.name,
          Value.Check(PathArgs, args) ? args.path : undefined,
          context
        );

        if (problem !== undefined) {
          throw new Error(problem);
        }

        return await tool.execute(
          args,
          WRITING_TOOLS.has(tool.name) ? { ...api, env: files.env } : api,
          context
        );
      };

      return await (WRITING_TOOLS.has(tool.name)
        ? files.run(execute)
        : execute());
    },
  }));

  return defineExtension({
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, _api, context) => {
          const block =
            capabilityProblem(call.name, allowed) ??
            (await pathProblem(
              call.name,
              Value.Check(PathArgs, call.arguments)
                ? call.arguments.path
                : undefined,
              context
            ));

          return block === undefined ? {} : { block };
        },
      }),
    ],
    name: "tools",
    sections: [
      section(
        "workspace",
        () =>
          `${SKILLS_PROMPT}\n\nWorkspace: ${workspace}${formatSkillsForPrompt(loadSkills([path.join(workspace, "skills"), BUNDLED_SKILLS]).skills)}`
      ),
    ],
    tools,
  });
};
