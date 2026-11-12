import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Approvals } from "./tools/approvals.ts";
import type { createBrowserTools } from "./tools/browser.ts";
import type { CallPolicy, ShrokTool } from "./tools/policy.ts";

/** What an optional local module contributes: its tools, and policies for tools another package registers, such as an MCP tool to allow. */
export interface LocalTools {
  readonly tools: readonly ShrokTool[];
  readonly policies?: readonly CallPolicy[];
}

/** What a local module gets to build its tools on. */
export interface LocalToolsBase {
  readonly browser: ReturnType<typeof createBrowserTools>;
  readonly approvals: Approvals;
}

const isLocalModule = (
  value: unknown
): value is { createLocalTools: (base: LocalToolsBase) => LocalTools } =>
  typeof value === "object" &&
  value !== null &&
  "createLocalTools" in value &&
  typeof value.createLocalTools === "function";

// Fixed inside the app's own install folder (this file's folder is src/). Never the data or workspace folder,
// so code the owner works on there cannot load itself into Shrok.
const LOCAL = path.join(import.meta.dirname, "tools", "local.ts");

/** Loads the optional local tools module by path, since public packages and the public repository leave it out. */
export const loadLocalTools = async (
  base: LocalToolsBase
): Promise<LocalTools> => {
  if (!existsSync(LOCAL)) {
    return { tools: [] };
  }

  const loaded: unknown = await import(pathToFileURL(LOCAL).href);

  if (!isLocalModule(loaded)) {
    throw new Error(`${LOCAL} does not export createLocalTools.`);
  }

  const local = loaded.createLocalTools(base);

  if (!Array.isArray(local.tools)) {
    throw new TypeError(`${LOCAL}'s createLocalTools must return { tools }.`);
  }

  return local;
};
