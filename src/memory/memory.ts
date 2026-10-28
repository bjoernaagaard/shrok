import type {
  Api,
  AssistantMessage,
  Message,
  Model,
  Models,
  TextContent,
} from "@earendil-works/pi-ai";

import { report } from "../events.ts";
import { chatBlocks } from "./cache.ts";
import {
  compact,
  compressTask,
  LINE_BYTES,
  mergeTask,
  neutralize,
} from "./compactor.ts";
import { toLogMessages } from "./log.ts";
import type { MemoryStore } from "./store.ts";
import {
  firstMessage,
  lastMessage,
  lineSize,
  parentOf,
  shrink,
} from "./view.ts";
import type { Line } from "./view.ts";

export interface MemorySizes {
  readonly viewLowBytes: number;
  readonly viewHighBytes: number;
  readonly compactionLowBytes: number;
  readonly compactionHighBytes: number;
  readonly concurrency: number;
  readonly summaryWaitMs: number;
}

export const OPTCHAT_SIZES: MemorySizes = {
  compactionHighBytes: 32_000,
  compactionLowBytes: 16_000,
  concurrency: 8,
  summaryWaitMs: 120_000,
  viewHighBytes: 128_000,
  viewLowBytes: 64_000,
};

const NOT_SUMMARIZED = "(not summarized yet: zoom it)";
const LINE_BREAKS = /[\r\n\u2028\u2029\u0085]/gu;
const KEPT_TURN_VIEWS = 4;
const MAX_CACHED_NODES = 2048;
const MAX_BUILD_ATTEMPTS = 3;
const BUILD_RETRY_DELAY_MS = 60_000;

const UNAVAILABLE_SUMMARY =
  "Summary unavailable after repeated failures. Use zoom for retained source messages.";

const bytes = (text: string): number => Buffer.byteLength(text, "utf-8");

const lineName = (line: Line): string =>
  `${firstMessage(line)}+${lineSize(line)}`;

const isPowerOfTwo = (n: number): boolean =>
  n >= 1 && Number.isInteger(Math.log2(n));

interface TurnView {
  readonly blocks: TextContent[];
  readonly lines: Line[];
  readonly summarized: number;
}

interface Waiter {
  readonly until: number;
  readonly resolve: () => void;
}

export class Memory {
  readonly #store: MemoryStore;
  readonly #models: Models;
  readonly #model: Model<Api>;
  readonly #sizes: MemorySizes;
  readonly #texts = new Map<string, string>();
  readonly #queue: Line[] = [];
  readonly #queued = new Set<string>();
  readonly #retryAtNextMessage: Line[] = [];
  readonly #running = new Set<Promise<void>>();
  readonly #abort = new AbortController();
  readonly #waiters: Waiter[] = [];
  readonly #turnViews = new Map<number, TurnView>();
  #view: Line[];
  #compactionView: Line[];
  #inView: number;
  #viewShrinking = false;
  #compactionShrinking = false;
  #closed = false;

  constructor(
    store: MemoryStore,
    models: Models,
    model: Model<Api>,
    sizes: MemorySizes
  ) {
    this.#store = store;
    this.#models = models;
    this.#model = model;
    this.#sizes = sizes;
    this.#view = this.#cut(store.lines("view"), store.messageCount());
    this.#compactionView = this.#cut(
      store.lines("compactionView"),
      store.messageCount()
    );

    const last = this.#view.at(-1);

    this.#inView =
      last === undefined ? store.firstMessage() : lastMessage(last) + 1;

    for (let id = this.#inView; id < store.messageCount(); id += 1) {
      this.#enqueue({ index: id, level: 0 });
    }

    for (const parent of store.pendingMerges()) {
      this.#enqueue(parent);
    }

    this.#advanceView();
  }

  sync(transcript: readonly Message[]): void {
    const messages = transcript.filter((message) => message.role !== "system");

    for (
      let source = this.#store.number("consumed");
      source < messages.length;
      source += 1
    ) {
      const message = messages[source];

      if (message !== undefined) {
        this.#log(message, source);
      }
    }
  }

  logAnswer(answer: AssistantMessage): void {
    this.#log(answer, this.#store.number("consumed"));
  }

  firstMessageFrom(source: number): number {
    return this.#store.firstMessageFrom(source);
  }

  async viewFor(task: number, start: number): Promise<TextContent[]> {
    const view = this.#turnViews.get(start) ?? (await this.#buildView(start));

    this.#store.saveTurnView(task, start, view.summarized, view.lines);

    return view.blocks;
  }

  zoom(id: number, n: number): string {
    const total = this.#store.messageCount();

    if (
      !isPowerOfTwo(n) ||
      id < this.#store.firstMessage() ||
      id % n !== 0 ||
      id + n > total
    ) {
      throw new Error(
        `No line ${id}+${n}: n must be a power of 2, id a multiple of n within retained history starting at ${this.#store.firstMessage()}, and id+n at most ${total}.`
      );
    }

    if (n === 1) {
      const message = this.#store.message(id);

      return message === undefined
        ? `${id}+1|(missing)`
        : `${id}+1|${message.kind}: ${message.text}`;
    }

    const level = Math.log2(n) - 1;
    const left = { index: (id / n) * 2, level };

    return [left, { index: left.index + 1, level }]
      .map((line) => this.#render(line))
      .join("\n");
  }

  date(id: number): number | undefined {
    return this.#store.message(id)?.date;
  }

  async idle(): Promise<void> {
    if (this.#running.size > 0) {
      await Promise.allSettled(this.#running);
      await this.idle();
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#abort.abort();
    await Promise.allSettled(this.#running);
    this.#store.close();
  }

  async #buildView(start: number): Promise<TurnView> {
    await this.#summarized(start);

    const lines = this.#cut(this.#view, start);
    const summarized = Math.min(this.#inView, start);
    const rendered = lines.map((line) => this.#render(line));

    if (this.#store.firstMessage() > 0) {
      rendered.unshift(
        `(History before message ${this.#store.firstMessage()} has expired.)`
      );
    }

    for (
      let id = Math.max(summarized, this.#store.firstMessage());
      id < start;
      id += 1
    ) {
      rendered.push(`${id}+1|${NOT_SUMMARIZED}`);
    }

    const view = { blocks: chatBlocks(rendered), lines, summarized };

    this.#turnViews.set(start, view);

    for (const key of [...this.#turnViews.keys()].slice(0, -KEPT_TURN_VIEWS)) {
      this.#turnViews.delete(key);
    }

    return view;
  }

  #log(message: Message, source: number): void {
    for (const entry of toLogMessages(message, source, Date.now())) {
      this.#enqueue({ index: this.#store.appendMessage(entry), level: 0 });
    }

    this.#store.saveNumber("consumed", source + 1);
    this.#store.prune();
    const first = this.#store.firstMessage();

    if (first > 0) {
      this.#view = this.#cut(this.#view, this.#store.messageCount());
      this.#compactionView = this.#cut(
        this.#compactionView,
        this.#store.messageCount()
      );
      this.#inView = Math.max(this.#inView, first);
      this.#turnViews.clear();

      for (let index = this.#queue.length - 1; index >= 0; index -= 1) {
        const queued = this.#queue[index];

        if (queued !== undefined && firstMessage(queued) < first) {
          this.#queue.splice(index, 1);
          this.#queued.delete(lineName(queued));
        }
      }

      this.#advanceView();
    }

    for (const line of this.#retryAtNextMessage.splice(0)) {
      this.#enqueue(line);
    }
  }

  #text(line: Line): string | undefined {
    const key = lineName(line);
    const known = this.#texts.get(key);

    if (known !== undefined) {
      return known;
    }

    const stored = this.#store.node(line);

    if (stored !== undefined) {
      this.#cache(key, stored);
    }

    return stored;
  }

  #cache(key: string, text: string): void {
    this.#texts.set(key, text);

    if (this.#texts.size > MAX_CACHED_NODES) {
      const oldest = this.#texts.keys().next().value;

      if (oldest !== undefined) {
        this.#texts.delete(oldest);
      }
    }
  }

  readonly #built = (line: Line): boolean => this.#text(line) !== undefined;

  #render(line: Line): string {
    return `${lineName(line)}|${neutralize(this.#text(line) ?? NOT_SUMMARIZED).replaceAll(LINE_BREAKS, " ")}`;
  }

  #bytes(view: readonly Line[]): number {
    return view.reduce((sum, line) => sum + bytes(this.#render(line)) + 1, 0);
  }

  #cut(view: readonly Line[], start: number): Line[] {
    const result: Line[] = [];

    for (const line of view) {
      if (
        lastMessage(line) < this.#store.firstMessage() ||
        firstMessage(line) >= start
      ) {
        continue;
      }

      if (
        firstMessage(line) >= this.#store.firstMessage() &&
        lastMessage(line) < start
      ) {
        result.push(line);
      } else if (line.level > 0) {
        const left = { index: line.index * 2, level: line.level - 1 };

        result.push(
          ...this.#cut(
            [left, { index: left.index + 1, level: left.level }],
            start
          )
        );
      }
    }

    return result;
  }

  async #summarized(start: number): Promise<void> {
    if (this.#inView >= start) {
      return;
    }

    const { promise, resolve } = Promise.withResolvers<undefined>();
    const timer = setTimeout(resolve, this.#sizes.summaryWaitMs);

    const waiter = {
      resolve: () => {
        resolve(undefined);
      },
      until: start,
    };

    this.#waiters.push(waiter);
    await promise;
    clearTimeout(timer);
    const index = this.#waiters.indexOf(waiter);

    if (index !== -1) {
      this.#waiters.splice(index, 1);
    }
  }

  #enqueue(line: Line): void {
    const key = lineName(line);

    if (
      firstMessage(line) < this.#store.firstMessage() ||
      this.#queued.has(key) ||
      this.#built(line)
    ) {
      return;
    }

    this.#queued.add(key);
    this.#queue.push(line);
    this.#pump();
  }

  #pump(): void {
    while (!this.#closed && this.#running.size < this.#sizes.concurrency) {
      const line = this.#queue.shift();

      if (line === undefined) {
        return;
      }

      const run = this.#build(line).finally(() => {
        this.#running.delete(run);
        this.#queued.delete(lineName(line));
        this.#pump();
      });

      this.#running.add(run);
    }
  }

  async #build(line: Line): Promise<void> {
    if (firstMessage(line) < this.#store.firstMessage()) {
      return;
    }

    const failure = this.#store.failure(line);

    if (failure.retryAt > Date.now()) {
      this.#retryAtNextMessage.push(line);

      return;
    }

    let text: string;

    try {
      text =
        failure.attempts >= MAX_BUILD_ATTEMPTS
          ? UNAVAILABLE_SUMMARY
          : await this.#buildText(line);
    } catch (error) {
      if (this.#closed) {
        return;
      }

      if (firstMessage(line) < this.#store.firstMessage()) {
        return;
      }

      const attempts = failure.attempts + 1;

      this.#store.saveFailure(
        line,
        attempts,
        Date.now() + BUILD_RETRY_DELAY_MS * 2 ** (attempts - 1)
      );
      report(
        "memory",
        `Memory could not build ${lineName(line)}: ${String(error)}`
      );

      if (attempts < MAX_BUILD_ATTEMPTS) {
        this.#retryAtNextMessage.push(line);

        return;
      }

      text = UNAVAILABLE_SUMMARY;
    }

    if (firstMessage(line) < this.#store.firstMessage()) {
      return;
    }

    this.#store.saveNode(line, text);
    this.#cache(lineName(line), text);

    if (line.level === 0) {
      this.#advanceView();
    }

    const sibling = {
      index: line.index % 2 === 0 ? line.index + 1 : line.index - 1,
      level: line.level,
    };

    if (this.#built(sibling)) {
      this.#enqueue(parentOf(line));
    }
  }

  async #buildText(line: Line): Promise<string> {
    return line.level === 0
      ? await this.#compress(line.index)
      : await this.#merge(line);
  }

  async #compress(id: number): Promise<string> {
    const message = this.#store.message(id);

    if (message === undefined) {
      throw new Error(`Message ${id} is not in the log.`);
    }

    const whole = `${message.kind}: ${message.text}`;

    if (bytes(whole) <= LINE_BYTES) {
      return whole;
    }

    return await compact(
      this.#models,
      this.#model,
      this.#compactionChat(id),
      compressTask(id, message.kind, message.text),
      this.#abort.signal
    );
  }

  async #merge(parent: Line): Promise<string> {
    const left = { index: parent.index * 2, level: parent.level - 1 };
    const right = { index: left.index + 1, level: left.level };
    const leftText = this.#text(left);
    const rightText = this.#text(right);

    if (leftText === undefined || rightText === undefined) {
      throw new Error(
        `Both halves of ${lineName(parent)} must be built first.`
      );
    }

    const joined = `${leftText}\n${rightText}`;

    if (bytes(joined) <= LINE_BYTES) {
      return joined;
    }

    const task = mergeTask(
      [lineName(left), lineName(right)],
      [firstMessage(parent), lastMessage(parent)],
      [leftText.replaceAll("\n", " "), rightText.replaceAll("\n", " ")]
    );

    return await compact(
      this.#models,
      this.#model,
      this.#compactionChat(lastMessage(parent) + 1),
      task,
      this.#abort.signal
    );
  }

  #compactionChat(end: number): TextContent[] {
    return chatBlocks(
      this.#compactionView
        .filter((line) => lastMessage(line) < end)
        .map((line) => this.#render(line))
    );
  }

  #advanceView(): void {
    const before = this.#inView;

    while (this.#built({ index: this.#inView, level: 0 })) {
      const line = { index: this.#inView, level: 0 };

      this.#view.push(line);
      this.#compactionView.push(line);
      this.#inView += 1;
    }

    if (this.#inView === before) {
      return;
    }

    const total = this.#inView;
    const viewBefore = this.#view.length;

    if (this.#bytes(this.#view) > this.#sizes.viewHighBytes) {
      this.#viewShrinking = true;
    }

    if (this.#viewShrinking) {
      this.#view = shrink(
        this.#view,
        total,
        this.#built,
        (view) => this.#bytes(view) > this.#sizes.viewLowBytes
      );
      this.#viewShrinking = this.#bytes(this.#view) > this.#sizes.viewLowBytes;
    }

    const viewMerged = this.#view.length !== viewBefore;

    if (
      viewMerged ||
      this.#bytes(this.#compactionView) > this.#sizes.compactionHighBytes
    ) {
      this.#compactionShrinking = true;
    }

    if (this.#compactionShrinking) {
      const source = viewMerged ? this.#view : this.#compactionView;

      this.#compactionView = shrink(
        source,
        total,
        this.#built,
        (view) => this.#bytes(view) > this.#sizes.compactionLowBytes
      );
      this.#compactionShrinking =
        this.#bytes(this.#compactionView) > this.#sizes.compactionLowBytes;
    }

    this.#store.saveLines("view", this.#view);
    this.#store.saveLines("compactionView", this.#compactionView);

    for (const waiter of this.#waiters.filter(
      ({ until }) => until <= this.#inView
    )) {
      this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  }
}
