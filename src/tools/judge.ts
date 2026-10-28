import type { ToolRegistration } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";

import { admitPaidTool, TRANSFORM_TEXT_PARAMETERS } from "./budget.ts";
import { explain } from "./explain.ts";

const ALLOWED = new Set([
  "bash",
  "browser_click",
  "browser_open",
  "browser_read",
  "browser_type",
  "calendar_add",
  "calendar_events",
  "cancel_schedule",
  "codemode",
  "date",
  "edit",
  "gmail_draft",
  "gmail_read",
  "gmail_search",
  "pi.codemode.models.classify",
  "read",
  "run_flow",
  "save_flow",
  "save_item",
  "schedule",
  "schedules",
  "search_items",
  "send_file",
  "tool_search",
  "transform_text",
  "web_fetch",
  "web_search",
  "write",
  "x_read_post",
  "zoom",
]);

export const capabilityProblem = (
  name: string,
  allowed?: ReadonlySet<string>
): string | undefined =>
  ALLOWED.has(name) || (allowed?.has(name) ?? false)
    ? undefined
    : explain(name);

/**
 * Guard the executor as well as ToolTask.beforeTool. A replay-safe tool can resume
 * directly in its execute phase after a restart, without rerunning beforeTool.
 */
export const restrictTools = (
  tools: readonly ToolRegistration[],
  allowed?: ReadonlySet<string>
): ToolRegistration[] =>
  tools.map((tool) => ({
    ...tool,
    description: capabilityProblem(tool.name, allowed) ?? tool.description,
    execute: async (args, api, context) => {
      const problem = capabilityProblem(tool.name, allowed);

      if (problem !== undefined) {
        throw new Error(problem);
      }

      let transformChars = 0;

      if (tool.name === "transform_text") {
        // Replay can enter execute without the Harness validating the schema again.
        if (!Value.Check(TRANSFORM_TEXT_PARAMETERS, args)) {
          throw new Error("transform_text input exceeds its allowed size.");
        }

        transformChars = args.instructions.length + args.text.length;
      }

      await admitPaidTool(tool.name, transformChars, api, context);

      return await tool.execute(args, api, context);
    },
  }));
