import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { report } from "./events.ts";
import type { Layout } from "./layout.ts";
import type { CreatePlugin, Plugin, PluginApi } from "./plugin-api.ts";

const PLUGIN_FILE = "plugin.ts";
const SKILLS_FOLDER = "skills";

/** Everything the installed plugins add. */
export interface Plugins {
  readonly tools: Plugin["tools"];
  readonly policies: NonNullable<Plugin["policies"]>;
  /** Each plugin's skills folder, read like the bundled skills. */
  readonly skillDirs: readonly string[];
}

const isPluginModule = (
  value: unknown
): value is { createPlugin: CreatePlugin } =>
  typeof value === "object" &&
  value !== null &&
  "createPlugin" in value &&
  typeof value.createPlugin === "function";

const loadPlugin = async (
  dir: string,
  api: PluginApi
): Promise<Plugin & { skillDirs: string[] }> => {
  const file = path.join(dir, PLUGIN_FILE);

  if (!existsSync(file)) {
    throw new Error(`it has no ${PLUGIN_FILE}`);
  }

  const loaded: unknown = await import(pathToFileURL(realpathSync(file)).href);

  if (!isPluginModule(loaded)) {
    throw new Error(`its ${PLUGIN_FILE} does not export createPlugin`);
  }

  const plugin = await loaded.createPlugin(api);

  if (!Array.isArray(plugin.tools)) {
    throw new TypeError("its createPlugin must return { tools }");
  }

  const skills = path.join(dir, SKILLS_FOLDER);

  return {
    ...plugin,
    skillDirs: existsSync(skills) ? [realpathSync(skills)] : [],
  };
};

/**
 * Loads every plugin in the data folder's plugins folder, in name order. Only the owner puts plugins there: tools
 * and bash cannot write in the data folder outside the workspace. A plugin that fails to load is reported and
 * left out, so the rest of Shrok keeps working.
 */
export const loadPlugins = async (
  layout: Layout,
  api: Omit<PluginApi, "name" | "report">
): Promise<Plugins> => {
  const tools: Plugin["tools"][number][] = [];
  const policies: NonNullable<Plugin["policies"]>[number][] = [];
  const skillDirs: string[] = [];

  const names = existsSync(layout.plugins)
    ? readdirSync(layout.plugins)
        .filter(
          (name) =>
            !name.startsWith(".") &&
            statSync(path.join(layout.plugins, name)).isDirectory()
        )
        .toSorted()
    : [];

  for (const name of names) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- plugins load in name order, so their tools register in order
      const plugin = await loadPlugin(path.join(layout.plugins, name), {
        ...api,
        name,
        report: (text) => {
          report(`plugin ${name}`, text);
        },
      });

      tools.push(...plugin.tools);
      policies.push(...(plugin.policies ?? []));
      skillDirs.push(...plugin.skillDirs);
    } catch (error) {
      report("plugins", `Shrok left out the plugin ${name}: ${String(error)}`);
    }
  }

  return { policies, skillDirs, tools };
};
