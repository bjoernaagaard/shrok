import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import type { Line } from "./view.ts";

const LineSchema = Type.Object({
  index: Type.Integer(),
  level: Type.Integer(),
});

const LinesSchema = Type.Array(LineSchema);

const LogMessageSchema = Type.Object({
  date: Type.Number(),
  id: Type.Integer(),
  kind: Type.String(),
  source: Type.Integer(),
  text: Type.String(),
});

const CountSchema = Type.Object({ count: Type.Integer() });

const FailureSchema = Type.Object({
  attempts: Type.Integer(),
  retryAt: Type.Number(),
});

const MAX_RETAINED_MESSAGES = 4096;
const MAX_RETAINED_REQUESTS = 128;

const MaybeCountSchema = Type.Object({
  count: Type.Union([Type.Integer(), Type.Null()]),
});

const TextSchema = Type.Object({ text: Type.String() });
const ValueSchema = Type.Object({ value: Type.String() });

export type LogMessage = Static<typeof LogMessageSchema>;

export type NewLogMessage = Omit<LogMessage, "id">;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, date INTEGER NOT NULL, source INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS nodes (level INTEGER NOT NULL, idx INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY (level, idx));
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS requests (task INTEGER PRIMARY KEY, date INTEGER NOT NULL, start INTEGER NOT NULL, summarized INTEGER NOT NULL, lines TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS failures (level INTEGER NOT NULL, idx INTEGER NOT NULL, attempts INTEGER NOT NULL, retry_at INTEGER NOT NULL, PRIMARY KEY (level, idx));
`;

export class MemoryStore {
  readonly #db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.#db = new DatabaseSync(file);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.#db.exec(SCHEMA);

    const next = Value.Parse(
      CountSchema,
      this.#db
        .prepare("SELECT COALESCE(MAX(id) + 1, 0) AS count FROM messages")
        .get()
    ).count;

    this.saveNumber("nextMessage", Math.max(next, this.number("nextMessage")));
    this.prune();
    this.#db.exec("VACUUM");
  }

  messageCount(): number {
    return this.number("nextMessage");
  }

  firstMessage(): number {
    return Math.max(0, this.messageCount() - MAX_RETAINED_MESSAGES);
  }

  prune(): void {
    const first = this.firstMessage();

    this.#db.prepare("DELETE FROM messages WHERE id < ?").run(first);
    this.#db
      .prepare("DELETE FROM nodes WHERE idx * (1 << level) < ?")
      .run(first);
    this.#db
      .prepare("DELETE FROM failures WHERE idx * (1 << level) < ?")
      .run(first);
    this.#db
      .prepare(
        "DELETE FROM requests WHERE task <= (SELECT task FROM requests ORDER BY task DESC LIMIT 1 OFFSET ?)"
      )
      .run(MAX_RETAINED_REQUESTS);
  }

  failure(line: Line): { attempts: number; retryAt: number } {
    const row = this.#db
      .prepare(
        'SELECT attempts, retry_at AS "retryAt" FROM failures WHERE level = ? AND idx = ?'
      )
      .get(line.level, line.index);

    return row === undefined
      ? { attempts: 0, retryAt: 0 }
      : Value.Parse(FailureSchema, row);
  }

  saveFailure(line: Line, attempts: number, retryAt: number): void {
    this.#db
      .prepare(
        "INSERT OR REPLACE INTO failures (level, idx, attempts, retry_at) VALUES (?, ?, ?, ?)"
      )
      .run(line.level, line.index, attempts, retryAt);
  }

  appendMessage(message: NewLogMessage): number {
    const id = this.messageCount();

    this.#db
      .prepare(
        "INSERT INTO messages (id, kind, text, date, source) VALUES (?, ?, ?, ?, ?)"
      )
      .run(id, message.kind, message.text, message.date, message.source);

    this.saveNumber("nextMessage", id + 1);

    return id;
  }

  message(id: number): LogMessage | undefined {
    const row = this.#db
      .prepare("SELECT id, kind, text, date, source FROM messages WHERE id = ?")
      .get(id);

    return row === undefined ? undefined : Value.Parse(LogMessageSchema, row);
  }

  firstMessageFrom(source: number): number {
    const row = this.#db
      .prepare("SELECT MIN(id) AS count FROM messages WHERE source >= ?")
      .get(source);

    return Value.Parse(MaybeCountSchema, row).count ?? this.messageCount();
  }

  node(line: Line): string | undefined {
    const row = this.#db
      .prepare("SELECT text FROM nodes WHERE level = ? AND idx = ?")
      .get(line.level, line.index);

    return row === undefined ? undefined : Value.Parse(TextSchema, row).text;
  }

  saveNode(line: Line, text: string): void {
    this.#db
      .prepare(
        "INSERT OR IGNORE INTO nodes (level, idx, text) VALUES (?, ?, ?)"
      )
      .run(line.level, line.index, text);
  }

  pendingMerges(): Line[] {
    const rows = this.#db
      .prepare(
        `SELECT a.level + 1 AS level, a.idx / 2 AS "index" FROM nodes a
         JOIN nodes b ON b.level = a.level AND b.idx = a.idx + 1
         LEFT JOIN nodes p ON p.level = a.level + 1 AND p.idx = a.idx / 2
         WHERE a.idx % 2 = 0 AND p.idx IS NULL`
      )
      .all();

    return Value.Parse(LinesSchema, rows);
  }

  lines(key: string): Line[] {
    const row = this.#db
      .prepare("SELECT value FROM state WHERE key = ?")
      .get(key);

    return row === undefined
      ? []
      : Value.Parse(
          LinesSchema,
          JSON.parse(Value.Parse(ValueSchema, row).value)
        );
  }

  saveLines(key: string, lines: readonly Line[]): void {
    this.#db
      .prepare("INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)")
      .run(key, JSON.stringify(lines));
  }

  number(key: string): number {
    const row = this.#db
      .prepare("SELECT value FROM state WHERE key = ?")
      .get(key);

    return row === undefined ? 0 : Number(Value.Parse(ValueSchema, row).value);
  }

  saveNumber(key: string, value: number): void {
    this.#db
      .prepare("INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)")
      .run(key, String(value));
  }

  saveTurnView(
    task: number,
    start: number,
    summarized: number,
    lines: readonly Line[]
  ): void {
    this.#db
      .prepare(
        "INSERT OR REPLACE INTO requests (task, date, start, summarized, lines) VALUES (?, ?, ?, ?, ?)"
      )
      .run(task, Date.now(), start, summarized, JSON.stringify(lines));
    this.prune();
  }

  close(): void {
    this.#db.close();
  }
}
