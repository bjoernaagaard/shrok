import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { Document, parseDocument } from "yaml";

import { report } from "./events.ts";

export const ITEMS_FOLDER = "items";
export const SEARCH_QUERY_MAX_CHARS = 1024;
const SEARCH_QUERY_MAX_TERMS = 32;
const MAX_ITEMS = 4096;

export const FILES_FOLDER = path.join(ITEMS_FOLDER, "files");

export const ITEM_KINDS = [
  "post",
  "link",
  "document",
  "image",
  "note",
] as const;

const ItemFieldsSchema = Type.Object({
  created: Type.String(),
  file: Type.Optional(Type.String()),
  id: Type.String(),
  kind: Type.Enum(ITEM_KINDS),
  source: Type.Optional(Type.String()),
  tags: Type.Array(Type.String()),
  title: Type.String(),
  updated: Type.String(),
});

type ItemFields = Static<typeof ItemFieldsSchema>;

export interface Item extends ItemFields {
  readonly body: string;
}

export type NewItem = Omit<Item, "id" | "created" | "updated"> & {
  readonly id?: string;
};

export interface SavedItem {
  readonly id: string;
  readonly workspacePath: string;
}

export interface Hit {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly created: string;
  readonly updated: string;
  readonly source: string;
  readonly workspacePath: string;
  readonly snippet: string;
}

const FRONTMATTER =
  /^---\r?\n(?<yaml>[\s\S]*?)\r?\n---(?<body>\r?\n[\s\S]*|)$/u;

const NOT_SLUG = /[^a-z0-9]+/gu;
const EDGE_HYPHENS = /^-+|-+$/gu;
const WORDS = /[\p{L}\p{N}]+/gu;
const SLUG_CHARS = 60;
const SNIPPET_WORDS = 24;

const slug = (text: string): string =>
  text
    .normalize("NFKD")
    .toLowerCase()
    .replaceAll(NOT_SLUG, "-")
    .replaceAll(EDGE_HYPHENS, "")
    .slice(0, SLUG_CHARS)
    .replaceAll(EDGE_HYPHENS, "") || "item";

const toMarkdown = (
  { body, ...fields }: Item,
  document: Document = new Document()
): string => {
  for (const [key, value] of Object.entries(fields)) {
    document.set(key, value);
  }

  for (const key of ["file", "source"] as const) {
    if (fields[key] === undefined) {
      document.delete(key);
    }
  }

  return `---\n${document.toString()}---\n\n${body.trim()}\n`;
};

const fromMarkdown = (id: string, text: string) => {
  const match = FRONTMATTER.exec(text);

  if (match?.groups === undefined) {
    throw new Error(`${id}.md has no front matter`);
  }

  const document = parseDocument(match.groups.yaml ?? "");

  if (document.errors.length > 0) {
    throw new Error(`${id}.md has invalid YAML: ${document.errors.join(", ")}`);
  }

  const legacy = !document.has("id") && document.has("saved");

  if (legacy) {
    // The old saved date is the only recorded timestamp, not a known first-save date.
    const saved = document.get("saved");

    document.set("id", id);
    document.set("created", saved);
    document.set("updated", saved);
    document.delete("saved");
  }

  const fields = Value.Parse(ItemFieldsSchema, document.toJS());

  const body = match.groups.body ?? "";

  return {
    document,
    item: { ...fields, body: body.trim() },
    upgraded: legacy ? `---\n${document.toString()}---${body}` : undefined,
  };
};

const ftsQuery = (query: string): string => {
  if (query.length > SEARCH_QUERY_MAX_CHARS) {
    throw new Error(
      `Search queries may contain at most ${SEARCH_QUERY_MAX_CHARS} characters.`
    );
  }

  const words = query.match(WORDS) ?? [];

  if (words.length > SEARCH_QUERY_MAX_TERMS) {
    throw new Error(
      `Search queries may contain at most ${SEARCH_QUERY_MAX_TERMS} words.`
    );
  }

  return words.map((word) => `"${word}"*`).join(" OR ");
};

export class Items {
  readonly #dir: string;
  readonly #workspace: string;
  readonly #filenames = new Map<string, string>();
  readonly #db = new DatabaseSync(":memory:");

  constructor(workspace: string) {
    this.#workspace = workspace;
    this.#dir = path.join(workspace, ITEMS_FOLDER);
    mkdirSync(path.join(workspace, FILES_FOLDER), { recursive: true });
    this.#db.exec(
      "CREATE VIRTUAL TABLE items USING fts5(id UNINDEXED, kind UNINDEXED, created UNINDEXED, updated UNINDEXED, source, title, tags, body, tokenize = 'unicode61 remove_diacritics 2')"
    );

    for (const name of readdirSync(this.#dir)) {
      if (name.endsWith(".md")) {
        const id = name.slice(0, -".md".length);

        try {
          const file = path.join(this.#dir, name);

          const { item, upgraded } = fromMarkdown(
            id,
            readFileSync(file, "utf-8")
          );

          if (this.#filenames.has(item.id)) {
            throw new Error(`Duplicate item identifier ${item.id}`);
          }

          if (upgraded !== undefined) {
            writeFileSync(file, upgraded);
          }

          this.#index(item, name);
        } catch (error) {
          report("items", `Shrok skipped item ${name}: ${String(error)}`);
        }
      }
    }
  }

  save(item: NewItem, now: Date): SavedItem {
    const id = this.#idFor(item);

    // Shrok reads every item at startup, so their number is bounded. An update replaces one in place.
    if (!this.#filenames.has(id) && this.#filenames.size >= MAX_ITEMS) {
      throw new Error(
        `There are already ${MAX_ITEMS} saved items. Ask the owner which to remove first.`
      );
    }

    const filename = this.#filenames.get(id) ?? `${id}.md`;
    const file = path.join(this.#dir, filename);

    const previous = existsSync(file)
      ? fromMarkdown(id, readFileSync(file, "utf-8"))
      : undefined;

    const saved: Item = {
      body: item.body,
      created: previous?.item.created ?? now.toISOString(),
      file: item.file,
      id,
      kind: item.kind,
      source: item.source,
      tags: item.tags,
      title: item.title,
      updated: now.toISOString(),
    };

    writeFileSync(file, toMarkdown(saved, previous?.document));
    this.#index(saved, filename);

    return { id, workspacePath: this.#relative(id) };
  }

  search(query: string, limit: number): Hit[] {
    const match = ftsQuery(query);

    if (match === "") {
      return [];
    }

    const rows = this.#db
      .prepare(
        `SELECT id, kind, title, created, updated, source, snippet(items, 7, '', '', '…', ${SNIPPET_WORDS}) AS snippet
         FROM items WHERE items MATCH ? ORDER BY bm25(items, 0, 0, 0, 0, 2, 5, 3, 1) LIMIT ?`
      )
      .all(match, limit);

    return rows.map((row) => ({
      created: String(row.created),
      id: String(row.id),
      kind: String(row.kind),
      snippet: String(row.snippet),
      source: String(row.source),
      title: String(row.title),
      updated: String(row.updated),
      workspacePath: this.#relative(String(row.id)),
    }));
  }

  close(): void {
    this.#db.close();
  }

  #relative(id: string): string {
    return path.relative(
      this.#workspace,
      path.join(this.#dir, this.#filenames.get(id) ?? `${id}.md`)
    );
  }

  #idFor(item: NewItem): string {
    if (item.id !== undefined) {
      const known = this.#db
        .prepare("SELECT id FROM items WHERE id = ?")
        .get(item.id);

      if (known === undefined) {
        throw new Error(`No saved item has identifier ${item.id}`);
      }

      return String(known.id);
    }

    const existing =
      item.source === undefined
        ? this.#db
            .prepare(
              "SELECT id FROM items WHERE source = '' AND title = ? LIMIT 1"
            )
            .get(item.title)
        : this.#db
            .prepare("SELECT id FROM items WHERE source = ? LIMIT 1")
            .get(item.source);

    if (existing !== undefined) {
      return String(existing.id);
    }

    const base = slug(item.title);
    let id = base;

    for (
      let n = 2;
      this.#filenames.has(id) || existsSync(path.join(this.#dir, `${id}.md`));
      n += 1
    ) {
      id = `${base}-${n}`;
    }

    return id;
  }

  #index(item: Item, filename: string): void {
    this.#filenames.set(item.id, filename);
    this.#db.prepare("DELETE FROM items WHERE id = ?").run(item.id);
    this.#db
      .prepare(
        "INSERT INTO items (id, kind, created, updated, source, title, tags, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        item.id,
        item.kind,
        item.created,
        item.updated,
        item.source ?? "",
        item.title,
        item.tags.join(" "),
        item.body
      );
  }
}
