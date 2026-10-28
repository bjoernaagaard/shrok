import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

import { ITEM_KINDS, SEARCH_QUERY_MAX_CHARS } from "../items.ts";
import type { Items } from "../items.ts";

const SEARCH_LIMIT = 10;
const MAX_BODY_CHARS = 256 * 1024;
const MAX_FIELD_CHARS = 2048;
const MAX_TAG_CHARS = 64;
const MAX_TAGS = 32;

const text = (value: string) => ({
  output: [{ text: value, type: "text" as const }],
});

export const createItemTools = (items: Items) => [
  defineTool({
    description:
      "Save something the user shared, or asked you to keep, as portable Markdown with YAML facts. Search for related items first. To update an item, read it first and pass its id, keeping existing content and links unless the user asks to replace them. Saving with the same source (or the same title without a source) also updates the existing item. Its id, filename and created date stay fixed; updated changes.",
    execute: async (args) => {
      const saved = items.save({ ...args, tags: args.tags ?? [] }, new Date());

      return await Promise.resolve(text(`Saved as ${saved.workspacePath}`));
    },
    name: "save_item",
    parameters: Type.Object({
      body: Type.String({
        description:
          "Markdown body only: a short summary, then the full text worth searching. Finish with a ## Related items section when meaningful connections exist. Use standard Markdown links to verified existing filenames, relative to this document (filename.md, not items/filename.md), and explain each connection. No wikilinks, invented targets or empty section.",
        maxLength: MAX_BODY_CHARS,
      }),
      file: Type.Optional(
        Type.String({
          description: "The shared file, relative to the workspace",
        })
      ),
      id: Type.Optional(
        Type.String({
          description:
            "The existing item identifier when updating, including changing its title or source. Omit for a new item.",
        })
      ),
      kind: StringEnum(ITEM_KINDS),
      source: Type.Optional(
        Type.String({
          description: "The link it came from",
          maxLength: MAX_FIELD_CHARS,
        })
      ),
      tags: Type.Optional(
        Type.Array(Type.String({ maxLength: MAX_TAG_CHARS }), {
          maxItems: MAX_TAGS,
        })
      ),
      title: Type.String({ maxLength: MAX_FIELD_CHARS }),
    }),
    replay: "safe",
  }),
  defineTool({
    description:
      "Search the user's saved items by words. Returns the best matches with a snippet and the item's path; read the path for the whole item.",
    execute: async (args) => {
      const hits = items.search(args.query, SEARCH_LIMIT);

      return await Promise.resolve(
        text(
          hits.length === 0
            ? "No saved item matches."
            : hits
                .map(
                  (hit) =>
                    `- ${hit.title} (${hit.kind}, id: ${hit.id}, created ${hit.created.slice(0, 10)}, updated ${hit.updated.slice(0, 10)}) ${hit.workspacePath}${hit.source === "" ? "" : ` ${hit.source}`}\n  ${hit.snippet}`
                )
                .join("\n")
        )
      );
    },
    name: "search_items",
    parameters: Type.Object({
      query: Type.String({
        description: "Words to look for",
        maxLength: SEARCH_QUERY_MAX_CHARS,
      }),
    }),
    replay: "safe",
  }),
];
