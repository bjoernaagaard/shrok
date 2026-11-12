import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

import { report as recordEvent } from "../events.ts";
import { text, typed } from "../tools/output.ts";

export interface ApprovalOwner {
  readonly userId: number;
  readonly contactId: number;
}

export interface ApprovalMessage {
  readonly itemId: number;
  readonly fileId: number;
}

export interface ApprovalDelivery extends ApprovalMessage {
  readonly uploadedAt: number;
  readonly deliveredAt: number;
}

/** A request as the owner sees it. The phone writes it out, with the commands that answer it. */
export interface ApprovalRequest {
  readonly id: number;
  readonly summary: string;
  /** What /always allows from now on; empty when the request can only be answered once. */
  readonly grants: readonly string[];
}

/** How a request ended. The phone picks the words the owner reads for each. */
export type RequestState =
  | "done"
  | "failed"
  | "declined"
  | "revoked"
  | "changed"
  | "stopped";

export interface ApprovalPhone {
  owner: () => Promise<ApprovalOwner>;
  deliver: (
    owner: ApprovalOwner,
    file: string,
    request: ApprovalRequest,
    signal: AbortSignal,
    sent: (message: ApprovalMessage) => void
  ) => Promise<ApprovalDelivery>;
  /** Shows on the request's own message how it ended. */
  showOutcome: (
    owner: ApprovalOwner,
    itemId: number,
    request: ApprovalRequest,
    state: RequestState
  ) => Promise<void>;
}

/** Tells the conversation how a request ended, as an event the model answers. */
export type ReportOutcome = (text: string, requestId: string) => Promise<void>;

/** Where an action prepares and runs. */
interface RunContext {
  readonly env: ExecutionEnv;
  readonly context: Context;
}

/** Something only the owner may allow, prepared from current state, so it can be prepared again and compared. */
export interface Action {
  readonly tool: string;
  /** What the owner reads. Quote anything a page, an email or the model wrote, with `quoted`. */
  readonly summary: string;
  readonly arguments: JsonObject;
  /** What must still hold when he answers, read again then: any change cancels the request. */
  readonly state: JsonObject;
  /** What /always allows from now on. The action runs without asking once every one is allowed. Empty: always ask. */
  readonly grants: readonly string[];
  /** Whether it acts on the page the browser has open, which must then stay open until the owner answers. */
  readonly holdsPage?: boolean;
  /** Does the approved action and returns what the model should learn from it. */
  readonly run: (where: RunContext) => Promise<JsonValue>;
}

export type Prepare = (where: RunContext) => Action | Promise<Action>;

/** The tool call an approval binds to. */
export interface Call {
  readonly taskId: number;
  readonly conversationId: number;
  readonly callId: string;
}

/** `ran` when a standing permission covered the action, else the request now waiting for the owner. */
export type Outcome =
  | { readonly ran: true; readonly result: JsonValue }
  | { readonly ran: false; readonly id: number };

export type Verdict = "yes" | "no" | "always";

/** `decidedOnce`: an /always on a request with nothing to allow for good, done once like a /yes. */
export type Decision =
  | "decided"
  | "decidedOnce"
  | "beforeDelivery"
  | "unavailable";

interface Waiting {
  readonly holdsPage: boolean;
  readonly owner: ApprovalOwner;
  readonly request: ApprovalRequest;
  readonly createdAt: number;
  readonly controller: AbortController;
  readonly prepare: Prepare;
  /** The action as first prepared, without its run function, to compare a fresh preparation with. */
  readonly bound: string;
  message?: ApprovalMessage;
  deliveredAt?: number;
}

const POLICY = "capabilities-v2";
const MAX_RETAINED_APPROVALS = 1024;
const MAX_PENDING_APPROVALS = 16;
const MAX_APPROVAL_BYTES = 256 * 1024;
const MAX_RESULT_CHARS = 40_000;
const MAX_QUOTED_CHARS = 600;
const OPEN_STATES = "('delivering', 'pending', 'approved', 'executing')";
const DETAILS_FILE = /^approval-\d+-[\da-f-]+\.txt$/u;

const CountSchema = Type.Object({ count: Type.Integer() });
const IdSchema = Type.Object({ id: Type.Integer() });
const RetiredTaskSchema = Type.Object({ task: Type.Integer() });

const ExistingSchema = Type.Object({
  id: Type.Integer(),
  state: Type.String(),
});

const RetiredApprovalSchema = Type.Array(
  Type.Object({ call_id: Type.String(), id: Type.Integer() })
);

const GrantsSchema = Type.Array(
  Type.Object({ id: Type.Integer(), key: Type.String() })
);

const SCHEMA = `CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL,
  approved INTEGER,
  created_at INTEGER,
  asked_at INTEGER,
  answered_at INTEGER,
  summary TEXT,
  item_id INTEGER,
  file_id INTEGER,
  owner_user INTEGER,
  owner_contact INTEGER,
  binding TEXT,
  state TEXT NOT NULL,
  uploaded_at INTEGER,
  delivered_at INTEGER
);
CREATE TABLE IF NOT EXISTS approval_retirement (id INTEGER PRIMARY KEY CHECK (id = 1), task INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS grants (id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);`;

/** Text from a page, an email or the model, quoted so it cannot pose as more of the sentence, and cut to fit a caption. */
export const quoted = (value: string, max = MAX_QUOTED_CHARS): string =>
  `${JSON.stringify(value.slice(0, max))}${value.length > max ? " (cut here; the rest is in the attached details)" : ""}`;

const Text = Type.String();

const resultText = (result: JsonValue): string => {
  const shown = Value.Check(Text, result)
    ? result
    : JSON.stringify(result, null, 2);

  return shown.length > MAX_RESULT_CHARS
    ? `${shown.slice(0, MAX_RESULT_CHARS)}\n[cut at ${MAX_RESULT_CHARS} characters]`
    : shown;
};

/** What an approval tool returns while the owner has not answered yet. */
export const Asked = Type.Object({
  askedOwner: Type.Integer({
    description:
      "The open request's number. Its outcome arrives later, as an event starting [Request N].",
  }),
});

const askedText = (id: number): string =>
  `Asked the owner to approve request ${id}. Nothing has happened yet. When he answers, an event starting [Request ${id}] tells you how it went.`;

/** A typed tool result: the action's own output when it ran, else the open request. Declare `Type.Union([schema, Asked])`. */
export const typedOutcome = <T extends TSchema>(schema: T, outcome: Outcome) =>
  outcome.ran
    ? typed(schema, Value.Parse(schema, outcome.result))
    : {
        ...text(askedText(outcome.id)),
        structuredOutput: { askedOwner: outcome.id } satisfies Static<
          typeof Asked
        >,
      };

/** A text tool result: the action's text when it ran, else the open request. */
export const textOutcome = (outcome: Outcome) =>
  text(outcome.ran ? resultText(outcome.result) : askedText(outcome.id));

/** How approvals work, for the system prompt. */
export const APPROVALS_PROMPT = `# Approvals

Some actions need the owner's consent: they ask him on his phone and return at once, saying the request is open.
Nothing has happened then; don't wait for it or ask again. He answers whenever he likes, and you then get an event
starting [Request N] that says how it went, with the action's result. Act on it: finish the task, or tell him why
not. With /always he allows that kind of action for good, and it then runs without asking.

Unsupported external effects are blocked, not judged by a model. MCP operations have no reviewed capability. Do not
try another tool or ask for a generic approval to bypass a block. Ask the owner to do that step himself.`;

/**
 * The owner's consent to actions outside his machine. A request waits, open, until he answers on his phone; the
 * asking tool returns at once. On yes the action is prepared again, run if nothing changed, and its outcome reported
 * to the conversation. Standing permissions he grants with /always let matching actions run without asking.
 */
export class Approvals {
  readonly #db: DatabaseSync;
  readonly #details: string;
  readonly #env: ExecutionEnv;
  readonly #waiting = new Map<number, Waiting>();
  /** Approved actions running now, so /stop can abort them and close can wait for them. */
  readonly #running = new Map<AbortController, Promise<unknown>>();
  #closing = false;
  readonly #captions = new Set<Promise<void>>();
  readonly #phone = Promise.withResolvers<ApprovalPhone>();
  readonly #report = Promise.withResolvers<ReportOutcome>();

  constructor(file: string, env: ExecutionEnv) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.#env = env;
    this.#details = path.join(path.dirname(file), "approval-details");
    mkdirSync(this.#details, { mode: 0o700, recursive: true });
    this.#db = new DatabaseSync(file);
    this.#db.exec(SCHEMA);
    // The prepared actions of a stopped Shrok are gone with it, so its open requests can never run.
    this.#db.exec(`
      UPDATE approvals SET state = 'outcome_unknown' WHERE state = 'executing';
      UPDATE approvals SET state = 'revoked' WHERE state IN ('delivering', 'pending', 'approved');
    `);

    for (const detail of readdirSync(this.#details)) {
      if (DETAILS_FILE.test(detail)) {
        rmSync(path.join(this.#details, detail), { force: true });
      }
    }

    this.#prune();
    this.#db.exec("VACUUM");
  }

  attach(phone: ApprovalPhone, report: ReportOutcome): void {
    this.#phone.resolve(phone);
    this.#report.resolve(report);
  }

  /**
   * Runs the action now when standing permissions cover it, else asks the owner and returns the open request.
   * `context` is the asking tool's: it bounds the preparation, and an action a standing permission covers.
   */
  async request(
    call: Call,
    context: Context,
    prepare: Prepare
  ): Promise<Outcome> {
    if (this.#closing) {
      throw new Error(
        "Shrok is shutting down, so it cannot ask for approval now."
      );
    }

    this.#prune();
    const phone = await this.#phone.promise;
    const owner = await phone.owner();
    const where = { context, env: this.#env };
    const action = await prepare(where);

    // Shutdown may have started while the action prepared, and the database closes with it.
    if (this.#closing) {
      throw new Error(
        "Shrok is shutting down, so it cannot ask for approval now."
      );
    }

    const boundAction = Approvals.#boundOf(action);
    const bound = JSON.stringify(boundAction);

    const bindingObject: JsonObject = {
      action: boundAction,
      call: { ...call },
      owner: { ...owner },
      policy: POLICY,
    };

    const binding = JSON.stringify(bindingObject);

    if (Buffer.byteLength(binding, "utf-8") > MAX_APPROVAL_BYTES) {
      throw new Error(
        `Approval details exceed ${MAX_APPROVAL_BYTES} bytes. Prepare a smaller action.`
      );
    }

    const callKey = `${call.conversationId}:${call.taskId}:${call.callId}`;

    const existing = this.#db
      .prepare("SELECT id, state FROM approvals WHERE call_id = ?")
      .get(callKey);

    // A replayed tool call finds the request it already made.
    if (existing !== undefined) {
      const { id, state } = Value.Parse(ExistingSchema, existing);

      if (state === "delivering" || state === "pending") {
        return { id, ran: false };
      }

      throw new Error(
        "This invocation already used its approval request. Check the previous outcome before asking again."
      );
    }

    this.#checkRetired(call);

    const granted = this.#granted(action.grants);

    if (!granted && this.#openCount() >= MAX_PENDING_APPROVALS) {
      throw new Error(
        `${MAX_PENDING_APPROVALS} approval requests are open. Ask the owner to answer them before asking again.`
      );
    }

    const createdAt = Date.now();

    const id = Number(
      this.#db
        .prepare(`
      INSERT INTO approvals (call_id, action, summary, created_at, binding, owner_user, owner_contact, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
        .run(
          callKey,
          bound,
          action.summary,
          createdAt,
          binding,
          owner.userId,
          owner.contactId,
          granted ? "executing" : "delivering"
        ).lastInsertRowid
    );

    if (granted) {
      // Tracked like an approved action, so /stop and shutdown reach it and the database outlives it.
      const controller = new AbortController();

      const signal =
        context.abortSignal === undefined
          ? controller.signal
          : AbortSignal.any([controller.signal, context.abortSignal]);

      const running = (async () => {
        try {
          const result = await action.run({
            context: withAbortSignal(signal, context),
            env: this.#env,
          });

          this.#setState(id, "completed");

          return result;
        } catch (error) {
          this.#setState(id, "outcome_unknown");
          throw error;
        } finally {
          this.#prune();
        }
      })();

      // Its failure goes to the asking tool; close only needs it settled.
      this.#running.set(controller, Promise.allSettled([running]));

      try {
        return { ran: true, result: await running };
      } finally {
        this.#running.delete(controller);
      }
    }

    const waiting: Waiting = {
      bound,
      controller: new AbortController(),
      createdAt,
      holdsPage: action.holdsPage === true,
      owner,
      prepare,
      request: { grants: action.grants, id, summary: action.summary },
    };

    this.#waiting.set(id, waiting);
    void this.#deliver(waiting, bindingObject, phone);

    return { id, ran: false };
  }

  /** The owner's answer. A yes or always runs the action in the background and reports how it went. */
  decide(
    id: number,
    verdict: Verdict,
    owner: ApprovalOwner,
    receivedAt: number
  ): Decision {
    const waiting = this.#waiting.get(id);

    if (
      waiting === undefined ||
      waiting.owner.userId !== owner.userId ||
      waiting.owner.contactId !== owner.contactId
    ) {
      return "unavailable";
    }

    if (verdict === "no") {
      if (!this.#close(id, "declined")) {
        return "unavailable";
      }

      void this.#tell(
        `[Request ${id} declined] ${waiting.request.summary}`,
        `approval:${id}:declined`
      );

      return "decided";
    }

    if (waiting.deliveredAt === undefined) {
      return "beforeDelivery";
    }

    if (!Number.isFinite(receivedAt) || receivedAt > Date.now()) {
      return "unavailable";
    }

    // Shrok's own clock decides, so an answer sent before the whole request arrived cannot count.
    if (receivedAt <= waiting.deliveredAt) {
      return "beforeDelivery";
    }

    const result = this.#db
      .prepare(`
      UPDATE approvals SET state = 'approved', approved = 1, answered_at = ?
      WHERE id = ? AND state = 'pending' AND owner_user = ? AND owner_contact = ?
    `)
      .run(Date.now(), id, owner.userId, owner.contactId);

    if (result.changes !== 1) {
      return "unavailable";
    }

    if (verdict === "always") {
      for (const key of waiting.request.grants) {
        this.#db
          .prepare(
            "INSERT OR IGNORE INTO grants (key, created_at) VALUES (?, ?)"
          )
          .run(key, Date.now());
      }
    }

    const controller = new AbortController();

    const running = this.#carryOut(waiting, controller.signal).finally(() => {
      this.#running.delete(controller);
    });

    this.#running.set(controller, running);

    return verdict === "always" && waiting.request.grants.length === 0
      ? "decidedOnce"
      : "decided";
  }

  /** The requests waiting for this owner's answer. */
  asked(owner: ApprovalOwner): number[] {
    return [...this.#waiting].flatMap(([id, waiting]) =>
      waiting.owner.userId === owner.userId &&
      waiting.owner.contactId === owner.contactId &&
      waiting.deliveredAt !== undefined
        ? [id]
        : []
    );
  }

  requestIn(itemId: number, owner: ApprovalOwner): number | undefined {
    const row = this.#db
      .prepare(`
      SELECT id FROM approvals WHERE item_id = ? AND owner_user = ? AND owner_contact = ?
      ORDER BY id DESC LIMIT 1
    `)
      .get(itemId, owner.userId, owner.contactId);

    return row === undefined ? undefined : Value.Parse(IdSchema, row).id;
  }

  /** The standing permissions, numbered for /revoke. */
  grants(): { readonly id: number; readonly key: string }[] {
    return Value.Parse(
      GrantsSchema,
      this.#db.prepare("SELECT id, key FROM grants ORDER BY id").all()
    );
  }

  revoke(id: number): boolean {
    return (
      this.#db.prepare("DELETE FROM grants WHERE id = ?").run(id).changes === 1
    );
  }

  /** Whether a request about the browser's open page waits for the owner, so the browser must stay open. */
  holdsPage(): boolean {
    return [...this.#waiting.values()].some(({ holdsPage }) => holdsPage);
  }

  /** Aborts the approved actions running now; false when none was. */
  stop(): boolean {
    for (const controller of this.#running.keys()) {
      controller.abort();
    }

    return this.#running.size > 0;
  }

  /** Forgets every standing permission and revokes every open request, as when a new phone becomes the owner. */
  reset(): void {
    for (const id of this.#waiting.keys()) {
      this.#close(id, "revoked");
    }

    this.#db.exec("DELETE FROM grants");
  }

  /**
   * Revokes the open requests and shows it on their messages, so no stale /yes stays on the phone, and waits for
   * the stopped actions to settle before the database closes.
   */
  async close(): Promise<void> {
    this.#closing = true;
    this.stop();

    for (const id of this.#waiting.keys()) {
      this.#close(id, "revoked");
    }

    await Promise.allSettled(this.#running.values());
    await Promise.allSettled(this.#captions);
    this.#prune();
    this.#db.close();
  }

  static #boundOf(action: Action): JsonObject {
    return {
      arguments: action.arguments,
      grants: [...action.grants],
      state: action.state,
      summary: action.summary,
      tool: action.tool,
    };
  }

  #granted(keys: readonly string[]): boolean {
    return (
      keys.length > 0 &&
      keys.every(
        (key) =>
          this.#db.prepare("SELECT 1 FROM grants WHERE key = ?").get(key) !==
          undefined
      )
    );
  }

  #openCount(): number {
    return Value.Parse(
      CountSchema,
      this.#db
        .prepare(
          `SELECT COUNT(*) AS count FROM approvals WHERE state IN ${OPEN_STATES}`
        )
        .get()
    ).count;
  }

  #checkRetired(call: Call): void {
    const retired = this.#db
      .prepare("SELECT task FROM approval_retirement WHERE id = 1")
      .get();

    if (
      retired !== undefined &&
      call.taskId <= Value.Parse(RetiredTaskSchema, retired).task
    ) {
      throw new Error(
        "This invocation is older than retained approval history. Ask again in a new invocation."
      );
    }
  }

  #setState(id: number, state: string): void {
    this.#db
      .prepare("UPDATE approvals SET state = ? WHERE id = ?")
      .run(state, id);
  }

  async #deliver(
    waiting: Waiting,
    binding: JsonObject,
    phone: ApprovalPhone
  ): Promise<void> {
    const { id } = waiting.request;

    const file = path.join(this.#details, `approval-${id}-${randomUUID()}.txt`);

    try {
      writeFileSync(
        file,
        JSON.stringify({ request: id, ...binding }, null, 2),
        { flag: "wx", mode: 0o400 }
      );

      const delivery = await phone.deliver(
        waiting.owner,
        file,
        waiting.request,
        waiting.controller.signal,
        (message) => {
          waiting.controller.signal.throwIfAborted();
          waiting.message = message;
          this.#db
            .prepare(
              "UPDATE approvals SET item_id = ?, file_id = ? WHERE id = ? AND state = 'delivering'"
            )
            .run(message.itemId, message.fileId, id);
        }
      );

      waiting.controller.signal.throwIfAborted();
      this.#delivered(waiting, delivery);
    } catch (error) {
      if (this.#close(id, "revoked")) {
        void this.#tell(
          `[Request ${id} never reached his phone] ${waiting.request.summary}\n\nError: ${String(error)}`,
          `approval:${id}:undelivered`
        );
      }
    } finally {
      rmSync(file, { force: true });
    }
  }

  #delivered(waiting: Waiting, delivery: ApprovalDelivery): void {
    const { id } = waiting.request;

    if (
      waiting.message?.itemId !== delivery.itemId ||
      waiting.message.fileId !== delivery.fileId
    ) {
      throw new Error(
        "Approval delivery does not match the request's message and attachment."
      );
    }

    const deliveredAt = Math.max(delivery.uploadedAt, delivery.deliveredAt);

    if (
      !Number.isFinite(deliveredAt) ||
      deliveredAt < waiting.createdAt ||
      deliveredAt > Date.now()
    ) {
      throw new Error("Approval delivery time is invalid.");
    }

    const result = this.#db
      .prepare(`
      UPDATE approvals SET state = 'pending', asked_at = ?, uploaded_at = ?, delivered_at = ?
      WHERE id = ? AND state = 'delivering' AND item_id = ? AND file_id = ?
    `)
      .run(
        deliveredAt,
        delivery.uploadedAt,
        delivery.deliveredAt,
        id,
        delivery.itemId,
        delivery.fileId
      );

    if (result.changes !== 1) {
      throw new Error("Approval was cancelled during delivery.");
    }

    waiting.deliveredAt = deliveredAt;
  }

  /** Prepares the approved action again and runs it only if nothing the owner saw has changed. */
  async #carryOut(waiting: Waiting, signal: AbortSignal): Promise<void> {
    const { id, summary } = waiting.request;

    const where = {
      context: withAbortSignal(signal, BACKGROUND_CONTEXT),
      env: this.#env,
    };

    try {
      let action: Action;

      try {
        action = await waiting.prepare(where);

        if (JSON.stringify(Approvals.#boundOf(action)) !== waiting.bound) {
          throw new Error("what it would do changed after he was asked");
        }
      } catch (error) {
        const stopped = signal.aborted;

        this.#close(id, stopped ? "stopped" : "changed");
        void this.#tell(
          stopped
            ? `[Request ${id} approved, but stopped] ${summary}\n\nIt was stopped before it started, so nothing was done.`
            : `[Request ${id} approved, but not done] ${summary}\n\nIt was not done because ${String(error)}. Ask again if it is still wanted.`,
          `approval:${id}:${stopped ? "stopped" : "changed"}`
        );

        return;
      }

      const claimed = this.#db
        .prepare(
          "UPDATE approvals SET state = 'executing' WHERE id = ? AND state = 'approved'"
        )
        .run(id);

      this.#waiting.delete(id);

      if (claimed.changes !== 1) {
        return;
      }

      try {
        const result = await action.run(where);

        this.#setState(id, "completed");
        this.#show(waiting, "done");
        void this.#tell(
          `[Request ${id} approved and done] ${summary}\n\nResult:\n${resultText(result)}`,
          `approval:${id}:done`
        );
      } catch (error) {
        const stopped = signal.aborted;

        this.#setState(id, "outcome_unknown");
        this.#show(waiting, stopped ? "stopped" : "failed");
        void this.#tell(
          `[Request ${id} approved, but it ${stopped ? "was stopped while running" : "failed"}] ${summary}\n\nError: ${String(error)}\n\nCheck what actually happened before trying again.`,
          `approval:${id}:${stopped ? "stopped" : "failed"}`
        );
      }
    } finally {
      this.#prune();
    }
  }

  async #tell(message: string, requestId: string): Promise<void> {
    // While Shrok shuts down the conversation is closing too, so an outcome then is only recorded.
    if (this.#closing) {
      recordEvent("approvals", `Not reported during shutdown: ${requestId}`);

      return;
    }

    try {
      const report = await this.#report.promise;

      await report(message, requestId);
    } catch (error) {
      recordEvent(
        "approvals",
        `Could not report ${requestId}: ${String(error)}`
      );
    }
  }

  #close(
    id: number,
    state: "declined" | "revoked" | "changed" | "stopped"
  ): boolean {
    const waiting = this.#waiting.get(id);

    if (waiting === undefined) {
      return false;
    }

    const result = this.#db
      .prepare(`
      UPDATE approvals SET state = ?, approved = 0, answered_at = ?
      WHERE id = ? AND state IN ('delivering', 'pending', 'approved')
    `)
      .run(state, Date.now(), id);

    this.#waiting.delete(id);
    waiting.controller.abort();

    if (result.changes !== 1) {
      return false;
    }

    this.#show(waiting, state);

    return true;
  }

  #prune(): void {
    // Keep recent message associations, but never retain terminal action bodies.
    this.#db
      .prepare(`
      UPDATE approvals SET action = '', binding = NULL, summary = NULL
      WHERE state NOT IN ${OPEN_STATES}
    `)
      .run();

    const retired = Value.Parse(
      RetiredApprovalSchema,
      this.#db
        .prepare(`
      SELECT id, call_id FROM approvals
      WHERE state NOT IN ${OPEN_STATES}
      ORDER BY id DESC LIMIT -1 OFFSET ?
    `)
        .all(MAX_RETAINED_APPROVALS)
    );

    if (retired.length === 0) {
      return;
    }

    // A monotonic task watermark rejects every retired call, even after its row is gone.
    this.#db.exec("BEGIN IMMEDIATE");

    try {
      for (const row of retired) {
        const task = Number(row.call_id.split(":")[1]);

        if (Number.isSafeInteger(task) && task >= 0) {
          this.#db
            .prepare(`
            INSERT INTO approval_retirement (id, task) VALUES (1, ?)
            ON CONFLICT(id) DO UPDATE SET task = MAX(task, excluded.task)
          `)
            .run(task);
        }

        this.#db.prepare("DELETE FROM approvals WHERE id = ?").run(row.id);
      }

      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Updates the request's message in the background; close waits for these. */
  #show(waiting: Waiting, state: RequestState): void {
    const { message } = waiting;

    if (message === undefined) {
      return;
    }

    const shown = (async () => {
      try {
        const phone = await this.#phone.promise;

        await phone.showOutcome(
          waiting.owner,
          message.itemId,
          waiting.request,
          state
        );
      } catch (error) {
        recordEvent(
          "approvals",
          `Could not update approval ${waiting.request.id}: ${String(error)}`
        );
      }
    })();

    this.#captions.add(shown);
    void shown.finally(() => {
      this.#captions.delete(shown);
    });
  }
}
