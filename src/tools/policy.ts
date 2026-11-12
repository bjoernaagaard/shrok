import type { JsonObject, ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";

/** A tool with what Shrok needs to know about it, declared where the tool is. */
export interface ShrokTool {
  readonly tool: ToolRegistration;
  /** Shown on the phone while the tool runs, such as "reading your calendar". */
  readonly phrase: string;
  /** Words from the call's arguments shown instead, such as the site it reads, when they fit. */
  readonly describe?: (args: JsonObject) => string | undefined;
  /** For tools that cost money per call: how many calls, and how many characters of text arguments, one owner request may spend. */
  readonly paid?: { readonly calls: number; readonly chars?: number };
  /** Whether its request acts on the page the browser has open, so the browser stays open while it waits. */
  readonly holdsPage?: boolean;
  /** Whether the flows prompt lists it as a tool flow scripts should call. Every call still passes the guard. */
  readonly flow?: boolean;
}

/** The policy of a tool another package registers, such as code mode, or of an internal call like `pi.codemode.models.classify`. */
export interface CallPolicy {
  readonly name: string;
  readonly phrase?: string;
  readonly paid?: ShrokTool["paid"];
}

const Words = Type.String({ pattern: "\\S" });

/** A call argument that holds words, trimmed. */
export const wordsArg = (args: JsonObject, key: string): string | undefined => {
  const value = args[key];

  return Value.Check(Words, value) ? value.trim() : undefined;
};

/** Every tool the model may use, with their policies. Any other registered tool, such as an MCP tool, is blocked. */
export class ToolCatalog {
  readonly #tools = new Map<string, ShrokTool | CallPolicy>();

  add(entries: readonly (ShrokTool | CallPolicy)[]): void {
    for (const entry of entries) {
      const name = "tool" in entry ? entry.tool.name : entry.name;

      if (this.#tools.has(name)) {
        throw new Error(`Duplicate tool registration: ${name}`);
      }

      this.#tools.set(name, entry);
    }
  }

  get(name: string): ShrokTool | CallPolicy | undefined {
    return this.#tools.get(name);
  }

  /** The words the phone shows for a call. */
  phrase(name: string, args: JsonObject): string {
    const entry = this.#tools.get(name);

    const described =
      entry !== undefined && "tool" in entry
        ? entry.describe?.(args)
        : undefined;

    return described ?? entry?.phrase ?? `using ${name.replaceAll("_", " ")}`;
  }

  /** The tools whose requests act on the browser's open page. */
  pageTools(): ReadonlySet<string> {
    return new Set(
      [...this.#tools.values()].flatMap((entry) =>
        "tool" in entry && entry.holdsPage === true ? [entry.tool.name] : []
      )
    );
  }

  /** The tools a flow may call, by name. */
  flowTools(): string[] {
    return [...this.#tools.values()].flatMap((entry) =>
      "tool" in entry && entry.flow === true ? [entry.tool.name] : []
    );
  }
}

/** Pulls the tool registrations out, for an extension's `tools`. */
export const registrations = (
  tools: readonly ShrokTool[]
): ToolRegistration[] => tools.map(({ tool }) => tool);
