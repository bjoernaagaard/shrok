import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";

import {
  Asked,
  quoted,
  textOutcome,
  typedOutcome,
} from "./approvals/approvals.ts";
import type { Approvals } from "./approvals/approvals.ts";
import type { Layout } from "./layout.ts";
import { setting } from "./settings.ts";
import { clickElement, settle } from "./tools/browser.ts";
import type { createBrowserTools } from "./tools/browser.ts";
import type { CallPolicy, ShrokTool } from "./tools/policy.ts";
import { programJson } from "./tools/programs.ts";
import { publicUrl } from "./tools/public-web.ts";

/**
 * What Shrok gives a plugin to build its tools on. A plugin imports nothing from Shrok at runtime: it gets all of
 * this as the argument of its createPlugin, so it works the same with a checkout, Homebrew, the .deb or Docker.
 * Type its file with `import type { CreatePlugin } from "<shrok>/src/plugin-api.ts"`.
 */
export interface PluginApi {
  /** The plugin's name: its folder's name in the data folder's plugins folder. */
  readonly name: string;
  readonly layout: Layout;
  /** pi-durable's defineTool and TypeBox's Type, to declare tools. */
  readonly defineTool: typeof defineTool;
  readonly Type: typeof Type;
  /** The owner's consent: ask with request, and return what it gives with textOutcome or typedOutcome. */
  readonly approvals: Pick<Approvals, "request">;
  readonly quoted: typeof quoted;
  readonly textOutcome: typeof textOutcome;
  readonly typedOutcome: typeof typedOutcome;
  readonly Asked: typeof Asked;
  /** The browser Shrok's own browser tools use, and how they click and wait for a page. */
  readonly browser: Pick<
    ReturnType<typeof createBrowserTools>,
    "page" | "save"
  >;
  readonly clickElement: typeof clickElement;
  readonly settle: typeof settle;
  /** Runs gws or xurl with the owner's login and parses its JSON. */
  readonly programJson: typeof programJson;
  /** Checks that an address is a public http or https page. */
  readonly publicUrl: typeof publicUrl;
  /** A setting from the environment or secrets.env, such as one the plugin documents. */
  readonly setting: typeof setting;
  /** Records an event in Shrok's event log, under the plugin's name. */
  readonly report: (text: string) => void;
}

/** What a plugin adds: its tools, and policies for tools another package registers, such as an MCP tool to allow. */
export interface Plugin {
  readonly tools: readonly ShrokTool[];
  readonly policies?: readonly CallPolicy[];
}

export type CreatePlugin = (api: PluginApi) => Plugin | Promise<Plugin>;

/** The part of the API that is the same for every plugin. */
export const pluginApi = (base: {
  readonly layout: Layout;
  readonly approvals: Approvals;
  readonly browser: PluginApi["browser"];
}): Omit<PluginApi, "name" | "report"> => ({
  Asked,
  Type,
  approvals: base.approvals,
  browser: base.browser,
  clickElement,
  defineTool,
  layout: base.layout,
  programJson,
  publicUrl,
  quoted,
  setting,
  settle,
  textOutcome,
  typedOutcome,
});
