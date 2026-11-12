import type { Api, Model } from "@earendil-works/pi-ai";
import { defineExtension, section } from "@earendil-works/pi-durable";
import type { ToolRegistration } from "@earendil-works/pi-durable";

import type { Items } from "../items.ts";
import type { Layout } from "../layout.ts";
import { integrations } from "../settings.ts";
import type { Approvals } from "./approvals.ts";
import { BROWSER_PROMPT } from "./browser.ts";
import { createGoogleTools, GOOGLE_PROMPT } from "./google.ts";
import { createItemTools } from "./items.ts";
import { createListTools } from "./lists.ts";
import { createPlaceTools } from "./places.ts";
import type { ShrokTool } from "./policy.ts";
import { registrations } from "./policy.ts";
import { createProgramsTools } from "./programs.ts";
import type { PublicWeb } from "./public-web.ts";
import { createSandboxedBash } from "./sandbox.ts";
import type { SeenUrls } from "./seen-urls.ts";
import { createSendFileTool } from "./send.ts";
import type { SendFile } from "./send.ts";
import { BUNDLED_SKILLS, formatSkillsForPrompt, loadSkills } from "./skills.ts";
import { createTransformTool } from "./transform.ts";
import { createWebTools } from "./web.ts";
import { createWorkspaceFiles } from "./workspace.ts";
import { createXTools } from "./x.ts";

const PROMPT = `# Workspace and skills

Your tools work in your workspace folder. read, write and edit work only there and in the bundled skills;
write and edit enforce file and storage budgets. bash runs in a sandbox in the workspace: it can write there and
reach the public web, but not the home folder outside the workspace or the private network. The items, flows,
lists and skills folders change only through their own tools.

# Approvals

Some actions need the owner's consent: they ask him on his phone and return at once, saying the request is open.
Nothing has happened then; don't wait for it or ask again. He answers whenever he likes, and you then get a message
starting [Request N] that says how it went, with the action's result. Act on it: finish the task, or tell him why
not. With /always he allows that kind of action for good, and it then runs without asking.

Unsupported external effects are blocked, not judged by a model. MCP operations have no reviewed capability. Do not
try another tool or ask for a generic approval to bypass a block. Ask the owner to do that step himself.
Flows change only through save_flow. Running a flow does not authorize its child calls: each passes the same
controls.

# Shares and skills

A message that starts with [Shared link], [Shared file] or [Shared image] is something the user shared from his
phone. Save it with save_item, following the saving-shares skill, then answer in one short line. Saved items are
in the workspace's items folder; search them with search_items.

Skills are how-to notes in the workspace's skills folder: one folder per skill, holding a SKILL.md whose front
matter has a name and a description of when to use it. Skills describe procedures, not permissions.`;

export interface ToolsOptions {
  readonly approvals: Approvals;
  readonly layout: Layout;
  readonly items: Items;
  /** Searches the web, and writes for flows. */
  readonly smallModel: Model<Api>;
  readonly mcpTools: readonly ToolRegistration[];
  readonly browserTools: readonly ShrokTool[];
  readonly fileSender: Promise<SendFile>;
  readonly publicWeb: PublicWeb;
  readonly seenUrls: SeenUrls;
}

/** Shrok's own tools, the browser's and the local module's, with the prompt that explains them. */
export const createTools = (options: ToolsOptions) => {
  const { approvals, layout } = options;
  const files = createWorkspaceFiles(layout);

  const tools: ShrokTool[] = [
    ...files.tools,
    createSandboxedBash(layout.workspace),
    ...createProgramsTools(approvals),
    ...createItemTools(options.items),
    ...createListTools(layout),
    ...createPlaceTools(),
    createTransformTool(options.smallModel),
    createSendFileTool(layout.workspace, options.fileSender),
    ...(integrations.has("google") ? createGoogleTools(approvals, layout) : []),
    ...(integrations.has("x") ? createXTools(approvals) : []),
    ...createWebTools(options.smallModel, options.publicWeb, options.seenUrls),
    ...options.browserTools,
  ];

  const prompt = (): string =>
    [
      PROMPT,
      BROWSER_PROMPT,
      ...(integrations.has("google") ? [GOOGLE_PROMPT] : []),
      `Workspace: ${layout.workspace}${formatSkillsForPrompt(loadSkills([layout.skills, BUNDLED_SKILLS]).skills)}`,
    ].join("\n\n");

  const extension = defineExtension({
    name: "tools",
    sections: [section("workspace", prompt)],
    // MCP tools carry no Shrok policy, so the guard blocks them.
    tools: [...registrations(tools), ...options.mcpTools],
  });

  return { extension, problem: files.problem, tools };
};
