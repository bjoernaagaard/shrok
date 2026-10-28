import { mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  date INTEGER NOT NULL,
  source TEXT NOT NULL,
  text TEXT NOT NULL
)`;

const MAX_EVENTS = 2000;
const MAX_EVENT_TEXT_CHARACTERS = 2048;
const MAX_EVENT_SOURCE_CHARACTERS = 128;
const MAX_EVENTS_PER_WINDOW = 60;
const EVENT_WINDOW_MS = 60_000;

let windowStarted = performance.now();
let windowEvents = 0;
let events: DatabaseSync | undefined;

const prune = (): void => {
  events
    ?.prepare(
      "DELETE FROM events WHERE id <= (SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ?)"
    )
    .run(MAX_EVENTS);
};

export const openEvents = (file: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  events = new DatabaseSync(file);
  events.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  events.exec(SCHEMA);
  prune();
  events.exec("VACUUM");
};

export const closeEvents = (): void => {
  events?.close();
  events = undefined;
};

export const record = (source: string, text: string): boolean => {
  const now = performance.now();

  if (now - windowStarted >= EVENT_WINDOW_MS) {
    windowStarted = now;
    windowEvents = 0;
  }

  if (windowEvents >= MAX_EVENTS_PER_WINDOW) {
    return false;
  }

  windowEvents += 1;
  events
    ?.prepare("INSERT INTO events (date, source, text) VALUES (?, ?, ?)")
    .run(
      Date.now(),
      source.slice(0, MAX_EVENT_SOURCE_CHARACTERS),
      text.slice(0, MAX_EVENT_TEXT_CHARACTERS)
    );
  prune();

  return true;
};

export const report = (source: string, text: string): void => {
  if (record(source, text)) {
    process.stderr.write(`${text.slice(0, MAX_EVENT_TEXT_CHARACTERS)}\n`);
  }
};
