import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type { Approvals } from "./tools/approvals.ts";
import type { createBrowserTools } from "./tools/browser.ts";

/** What an optional local tools module contributes: its tools, their progress phrases and their allowed names. */
export interface LocalTools {
  readonly tools: readonly ToolRegistration[];
  readonly phrases?: Readonly<Record<string, string>>;
  readonly allowed?: readonly string[];
}

/** The local module's shape, declared here so Shrok checks and runs the same without the file. */
interface LocalModule {
  readonly createLocalTools: (
    browser: ReturnType<typeof createBrowserTools>,
    approvals: Approvals<string, string>
  ) => LocalTools;
}

const Phrases = Type.Record(Type.String(), Type.String());
const Names = Type.Array(Type.String());

const isLocalModule = (value: unknown): value is LocalModule =>
  typeof value === "object" &&
  value !== null &&
  "createLocalTools" in value &&
  typeof value.createLocalTools === "function";

// Fixed inside the app's own install folder (this file's folder is src/). Never the data or workspace folder,
// so code the owner works on there cannot load itself into Shrok.
const LOCAL = path.join(import.meta.dirname, "tools", "local.ts");

/** Loads the optional local tools module by path, since public packages and the public repository leave it out. */
export const loadLocalTools = async (
  browser: ReturnType<typeof createBrowserTools>,
  approvals: Approvals
): Promise<LocalTools> => {
  if (!existsSync(LOCAL)) {
    return { tools: [] };
  }

  const loaded: unknown = await import(pathToFileURL(LOCAL).href);

  if (!isLocalModule(loaded)) {
    throw new Error(`${LOCAL} does not export createLocalTools.`);
  }

  const local = loaded.createLocalTools(browser, approvals);

  if (
    !Array.isArray(local.tools) ||
    (local.phrases !== undefined && !Value.Check(Phrases, local.phrases)) ||
    (local.allowed !== undefined && !Value.Check(Names, local.allowed))
  ) {
    throw new Error(
      `${LOCAL} must return tools, and phrases and allowed when it sets them.`
    );
  }

  return local;
};
