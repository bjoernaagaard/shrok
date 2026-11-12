import type { Api, Model } from "@earendil-works/pi-ai";
import { defineExtension, section } from "@earendil-works/pi-durable";
import type { ToolRegistration } from "@earendil-works/pi-durable";

import { APPROVALS_PROMPT } from "../approvals/approvals.ts";
import type { Approvals } from "../approvals/approvals.ts";
import type { Items } from "../items.ts";
import { managedNames } from "../layout.ts";
import type { Layout } from "../layout.ts";
import { integrations } from "../settings.ts";
import { SHARES_PROMPT } from "../shares.ts";
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

const workspacePrompt = (layout: Layout): string => `# Workspace and skills

Your tools work in your workspace folder. read, write and edit work only there and in the bundled skills;
write and edit enforce file and storage budgets. bash runs in a sandbox in the workspace: it can write there and
reach the public web, but not the home folder outside the workspace or the private network. The ${managedNames(layout)}
folders change only through their own tools.

Running a flow does not authorize its child calls: each passes the same controls.

Skills are how-to notes in the workspace's skills folder: one folder per skill, holding a SKILL.md whose front
matter has a name and a description of when to use it. Skills describe procedures, not permissions.`;

export interface ToolsOptions {
  readonly approvals: Approvals;
  readonly layout: Layout;
  readonly items: Items;
  /** Searches the web, and writes for flows. */
  readonly smallModel: Model<Api>;
  readonly mcpTools: readonly ToolRegistration[];
  /** The browser's tools and the local module's. */
  readonly moreTools: readonly ShrokTool[];
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
    createSandboxedBash(layout),
    ...createProgramsTools(approvals),
    ...createItemTools(options.items),
    ...createListTools(layout),
    ...createPlaceTools(),
    createTransformTool(options.smallModel),
    createSendFileTool(layout.workspace, options.fileSender),
    ...(integrations.has("google")
      ? createGoogleTools(approvals, layout, files.writeFile)
      : []),
    ...(integrations.has("x") ? createXTools(approvals) : []),
    ...createWebTools(options.smallModel, options.publicWeb, options.seenUrls),
    ...options.moreTools,
  ];

  const prompt = (): string =>
    [
      workspacePrompt(layout),
      APPROVALS_PROMPT,
      SHARES_PROMPT,
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

  return { extension, tools };
};
