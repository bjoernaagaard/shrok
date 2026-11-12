import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";

import type { Layout } from "../layout.ts";
import { text } from "./output.ts";
import type { ShrokTool } from "./policy.ts";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ENTRY = /^- (?<entry>.*)$/u;
const MAX_LISTS = 64;
const MAX_ENTRIES = 500;
const MAX_ENTRY_CHARS = 500;

const shown = (name: string, entries: readonly string[]): string =>
  entries.length === 0
    ? `The ${name} list is empty.`
    : `${name}:\n${entries.map((entry, index) => `${index + 1}. ${entry}`).join("\n")}`;

const ListName = Type.String({
  description:
    "Lowercase letters, digits and hyphens, such as shopping or gift-ideas",
});

/** Running lists the owner keeps, such as shopping or ideas: one Markdown file each, one "- " line per entry. */
export const createListTools = (layout: Layout): ShrokTool[] => {
  const fileOf = (name: string): string => {
    if (!NAME.test(name)) {
      throw new Error(
        `"${name}" is not a list name: use lowercase letters, digits and hyphens.`
      );
    }

    return path.join(layout.lists, `${name}.md`);
  };

  const read = (name: string): string[] => {
    const file = fileOf(name);

    return existsSync(file)
      ? readFileSync(file, "utf-8")
          .split("\n")
          .flatMap((line) => {
            const entry = ENTRY.exec(line)?.groups?.entry;

            return entry === undefined ? [] : [entry];
          })
      : [];
  };

  const write = (name: string, entries: readonly string[]): void => {
    mkdirSync(layout.lists, { recursive: true });

    if (entries.length === 0) {
      rmSync(fileOf(name), { force: true });

      return;
    }

    writeFileSync(
      fileOf(name),
      `# ${name}\n\n${entries.map((entry) => `- ${entry}`).join("\n")}\n`
    );
  };

  const names = (): string[] =>
    existsSync(layout.lists)
      ? readdirSync(layout.lists)
          .filter((file) => file.endsWith(".md"))
          .map((file) => file.slice(0, -".md".length))
          .toSorted()
      : [];

  return [
    {
      flow: true,
      phrase: "adding to a list",
      tool: defineTool({
        description:
          "Add entries to one of the owner's running lists, such as shopping or ideas. Makes the list if it is new.",
        execute: async (args) => {
          if (!names().includes(args.list) && names().length >= MAX_LISTS) {
            throw new Error(
              `There are already ${MAX_LISTS} lists. Remove one first.`
            );
          }

          const entries = [
            ...read(args.list),
            ...args.entries.map((entry) =>
              entry.replaceAll(/\s+/gu, " ").trim()
            ),
          ].filter((entry) => entry !== "");

          if (entries.length > MAX_ENTRIES) {
            throw new Error(`A list holds at most ${MAX_ENTRIES} entries.`);
          }

          write(args.list, entries);

          return text(shown(args.list, entries));
        },
        name: "list_add",
        parameters: Type.Object({
          entries: Type.Array(Type.String({ maxLength: MAX_ENTRY_CHARS }), {
            maxItems: 50,
            minItems: 1,
          }),
          list: ListName,
        }),
      }),
    },
    {
      flow: true,
      phrase: "reading a list",
      tool: defineTool({
        description:
          "Show one of the owner's lists, or without a name, the names of all of them.",
        execute: async (args) => {
          if (args.list !== undefined) {
            return text(shown(args.list, read(args.list)));
          }

          const all = names();

          return text(
            all.length === 0 ? "No lists yet." : `Lists: ${all.join(", ")}`
          );
        },
        name: "list_show",
        parameters: Type.Object({ list: Type.Optional(ListName) }),
        replay: "safe",
      }),
    },
    {
      flow: true,
      phrase: "crossing off a list",
      tool: defineTool({
        description:
          "Remove entries from a list by their numbers from list_show. Removing every entry deletes the list.",
        execute: async (args) => {
          const entries = read(args.list);
          const drop = new Set(args.numbers);

          write(
            args.list,
            entries.filter((_entry, index) => !drop.has(index + 1))
          );

          return text(shown(args.list, read(args.list)));
        },
        name: "list_remove",
        parameters: Type.Object({
          list: ListName,
          numbers: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1 }),
        }),
      }),
    },
  ];
};
