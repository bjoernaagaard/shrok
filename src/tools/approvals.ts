import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { JsonObject } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { report } from "../events.ts";
import { clockTime } from "../time.ts";

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

export interface ApprovalPhone {
  owner: () => Promise<ApprovalOwner>;
  deliver: (
    owner: ApprovalOwner,
    file: string,
    caption: string,
    signal: AbortSignal,
    sent: (message: ApprovalMessage) => void
  ) => Promise<ApprovalDelivery>;
  editCaption: (
    owner: ApprovalOwner,
    itemId: number,
    text: string
  ) => Promise<void>;
}

interface PreparedAction<
  LocalAdapter extends string,
  LocalTool extends string,
> {
  readonly adapter:
    | "flow-create-v1"
    | "browser-commit-v1"
    | "calendar-add-v1"
    | "x-read-post-v1"
    | "schedule-create-v1"
    | "web-open-v1"
    | "browser-type-v1"
    | LocalAdapter;
  readonly tool:
    | "save_flow"
    | "browser_click"
    | "calendar_add"
    | "x_read_post"
    | "schedule"
    | "web_fetch"
    | "browser_open"
    | "browser_type"
    | LocalTool;
  readonly summary: string;
  readonly arguments: JsonObject;
  readonly resource: JsonObject;
  readonly identity: JsonObject;
  readonly expectedState: JsonObject;
  readonly payload: JsonObject;
}

interface Call {
  readonly taskId: number;
  readonly conversationId: number;
  readonly callId: string;
}

type Rejection = "declined" | "skipped" | "expired" | "revoked";

export type Decision = "decided" | "beforeDelivery" | "unavailable";

interface Waiting {
  readonly owner: ApprovalOwner;
  readonly summary: string;
  readonly createdAt: number;
  readonly controller: AbortController;
  readonly answer: ReturnType<typeof Promise.withResolvers<undefined>>;
  message?: ApprovalMessage;
  deliveredAt?: number;
  expiresAt?: number;
  deadline?: number;
  timer?: ReturnType<typeof setTimeout>;
}

const LIFETIME_MS = 5 * 60 * 1000;
const POLICY = "capabilities-v1";
const MAX_RETAINED_APPROVALS = 1024;
const MAX_PENDING_APPROVALS = 16;
const CountSchema = Type.Object({ count: Type.Integer() });
const MAX_APPROVAL_BYTES = 256 * 1024;
const DETAILS_FILE = /^approval-\d+-[\da-f-]+\.txt$/u;
const RetiredTaskSchema = Type.Object({ task: Type.Integer() });

const RetiredApprovalSchema = Type.Array(
  Type.Object({ call_id: Type.String(), id: Type.Integer() })
);

const SCHEMA = `CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL,
  approved INTEGER
)`;

const ADDED_COLUMNS = [
  ["created_at", "INTEGER"],
  ["asked_at", "INTEGER"],
  ["answered_at", "INTEGER"],
  ["skipped", "INTEGER NOT NULL DEFAULT 0"],
  ["summary", "TEXT"],
  ["item_id", "INTEGER"],
  ["file_id", "INTEGER"],
  ["owner_user", "INTEGER"],
  ["owner_contact", "INTEGER"],
  ["binding", "TEXT"],
  ["state", "TEXT NOT NULL DEFAULT 'legacy'"],
  ["uploaded_at", "INTEGER"],
  ["delivered_at", "INTEGER"],
  ["expires_at", "INTEGER"],
] as const;

const ColumnsSchema = Type.Array(Type.Object({ name: Type.String() }));
const IdSchema = Type.Object({ id: Type.Integer() });

const REQUEST_PREFIX = "/'yes ";

const requestText = (id: number, summary: string): string =>
  `${REQUEST_PREFIX}${id}'   /'no ${id}'\n\n*Shrok wants to:*\n${summary}\n\nFull details are attached. Approval opens after upload and message delivery, and expires five minutes later.`;

export const isApprovalRequestText = (text: string | undefined): boolean =>
  text?.startsWith(REQUEST_PREFIX) === true;

export class Approvals<
  LocalAdapter extends string = never,
  LocalTool extends string = never,
> {
  readonly #db: DatabaseSync;
  readonly #details: string;
  readonly #waiting = new Map<number, Waiting>();
  readonly #phone = Promise.withResolvers<ApprovalPhone>();

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.#details = path.join(path.dirname(file), "approval-details");
    mkdirSync(this.#details, { mode: 0o700, recursive: true });
    this.#db = new DatabaseSync(file);
    this.#db.exec(SCHEMA);

    const columns = new Set(
      Value.Parse(
        ColumnsSchema,
        this.#db.prepare("PRAGMA table_info(approvals)").all()
      ).map(({ name }) => name)
    );

    for (const [name, type] of ADDED_COLUMNS) {
      if (!columns.has(name)) {
        this.#db.exec(`ALTER TABLE approvals ADD COLUMN ${name} ${type}`);
      }
    }

    this.#db.exec(`
      UPDATE approvals SET state = 'outcome_unknown' WHERE state = 'executing';
      UPDATE approvals SET state = 'revoked' WHERE state IN ('delivering', 'pending', 'approved');
    `);
    this.#db.exec(
      "CREATE TABLE IF NOT EXISTS approval_retirement (id INTEGER PRIMARY KEY CHECK (id = 1), task INTEGER NOT NULL)"
    );

    for (const detail of readdirSync(this.#details)) {
      if (DETAILS_FILE.test(detail)) {
        rmSync(path.join(this.#details, detail), { force: true });
      }
    }

    this.#prune();
    this.#db.exec("VACUUM");
  }

  attach(phone: ApprovalPhone): void {
    this.#phone.resolve(phone);
  }

  async execute<A extends PreparedAction<LocalAdapter, LocalTool>>(
    call: Call,
    prepare: () => A | Promise<A>,
    commit: (action: Readonly<A>) => Promise<void> | undefined,
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted();
    this.#prune();
    const phone = await this.#phone.promise;
    const owner = await phone.owner();
    signal?.throwIfAborted();
    const action = await prepare();
    const serialized = JSON.stringify(action);

    const bound = {
      action,
      call: {
        callId: call.callId,
        conversationId: call.conversationId,
        taskId: call.taskId,
      },
      owner,
      policy: POLICY,
    };

    const binding = JSON.stringify(bound);

    if (Buffer.byteLength(binding, "utf-8") > MAX_APPROVAL_BYTES) {
      throw new Error(
        `Approval details exceed ${MAX_APPROVAL_BYTES} bytes. Prepare a smaller action.`
      );
    }

    const callKey = `${call.conversationId}:${call.taskId}:${call.callId}`;

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

    const pending = Value.Parse(
      CountSchema,
      this.#db
        .prepare(
          "SELECT COUNT(*) AS count FROM approvals WHERE state IN ('delivering', 'pending', 'approved', 'executing')"
        )
        .get()
    ).count;

    if (pending >= MAX_PENDING_APPROVALS) {
      throw new Error(
        "Too many approval requests are pending. Finish them before asking again."
      );
    }

    if (
      this.#db
        .prepare("SELECT id FROM approvals WHERE call_id = ?")
        .get(callKey) !== undefined
    ) {
      throw new Error(
        "This invocation already requested approval. Its consent cannot be reused. Check the previous outcome before asking again."
      );
    }

    const createdAt = Date.now();

    const row = this.#db
      .prepare(`
      INSERT INTO approvals (call_id, action, summary, created_at, binding, owner_user, owner_contact, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'delivering')
    `)
      .run(
        callKey,
        serialized,
        action.summary,
        createdAt,
        binding,
        owner.userId,
        owner.contactId
      );

    const id = Number(row.lastInsertRowid);

    const waiting: Waiting = {
      answer: Promise.withResolvers<undefined>(),
      controller: new AbortController(),
      createdAt,
      owner,
      summary: action.summary,
    };

    this.#waiting.set(id, waiting);

    const abort = (): void => {
      this.#reject(id, "revoked");
    };

    signal?.addEventListener("abort", abort, { once: true });

    const deliver = async (): Promise<void> => {
      const file = path.join(
        this.#details,
        `approval-${id}-${randomUUID()}.txt`
      );

      const details = JSON.stringify({ request: id, ...bound }, null, 2);

      if (Buffer.byteLength(details, "utf-8") > MAX_APPROVAL_BYTES) {
        throw new Error(
          `Approval attachment exceeds ${MAX_APPROVAL_BYTES} bytes. Prepare a smaller action.`
        );
      }

      writeFileSync(file, details, {
        flag: "wx",
        mode: 0o400,
      });

      try {
        const delivery = await phone.deliver(
          owner,
          file,
          requestText(id, action.summary),
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
        this.#delivered(id, waiting, delivery);
      } finally {
        rmSync(file, { force: true });
      }

      await waiting.answer.promise;
    };

    try {
      await Promise.race([deliver(), waiting.answer.promise]);
      signal?.throwIfAborted();
      const currentOwner = await phone.owner();

      if (
        currentOwner.userId !== owner.userId ||
        currentOwner.contactId !== owner.contactId
      ) {
        throw new Error("The approval owner changed. Prepare a new request.");
      }

      const current = await prepare();

      if (JSON.stringify(current) !== serialized) {
        throw new Error(
          "The prepared action, identity or target state changed. Prepare a new request."
        );
      }

      signal?.throwIfAborted();

      if (!Approvals.#inTime(waiting)) {
        throw new Error("Approval expired. Prepare and deliver a new request.");
      }

      const claimed = this.#db
        .prepare(`
        UPDATE approvals SET state = 'executing'
        WHERE id = ? AND binding = ? AND state = 'approved' AND expires_at > ?
      `)
        .run(id, binding, Date.now());

      if (claimed.changes !== 1) {
        throw new Error("This approval is no longer available for execution.");
      }

      try {
        await commit(current);

        const completed = this.#db
          .prepare(
            "UPDATE approvals SET state = 'completed' WHERE id = ? AND state = 'executing'"
          )
          .run(id);

        if (completed.changes !== 1) {
          throw new Error(
            "The execution claim changed before its outcome was recorded."
          );
        }

        void this.#show(waiting, id, "Completed");
      } catch (error) {
        this.#db
          .prepare(
            "UPDATE approvals SET state = 'outcome_unknown' WHERE id = ? AND state = 'executing'"
          )
          .run(id);
        void this.#show(waiting, id, "Outcome unknown");
        throw new Error(
          "The action did not finish cleanly. Reconcile its actual outcome before trying again.",
          { cause: error }
        );
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      clearTimeout(waiting.timer);
      waiting.controller.abort();

      const revoked = this.#db
        .prepare(
          "UPDATE approvals SET state = 'revoked' WHERE id = ? AND state IN ('delivering', 'pending', 'approved')"
        )
        .run(id);

      if (revoked.changes === 1) {
        void this.#show(waiting, id, "revoked");
      }

      this.#waiting.delete(id);
      this.#prune();
    }
  }

  #prune(): void {
    // Keep recent message associations, but never retain terminal action bodies.
    this.#db
      .prepare(`
      UPDATE approvals SET action = '', binding = NULL, summary = NULL
      WHERE state NOT IN ('delivering', 'pending', 'approved', 'executing')
    `)
      .run();

    const retired = Value.Parse(
      RetiredApprovalSchema,
      this.#db
        .prepare(`
      SELECT id, call_id FROM approvals
      WHERE state NOT IN ('delivering', 'pending', 'approved', 'executing')
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

  decide(
    id: number,
    approved: boolean,
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

    if (!approved) {
      return this.#reject(id, "declined") ? "decided" : "unavailable";
    }

    if (waiting.deliveredAt === undefined) {
      return "beforeDelivery";
    }

    if (!Approvals.#inTime(waiting)) {
      this.#reject(id, "expired");

      return "unavailable";
    }

    if (!Number.isFinite(receivedAt) || receivedAt > Date.now()) {
      return "unavailable";
    }

    if (receivedAt <= waiting.deliveredAt) {
      return "beforeDelivery";
    }

    const result = this.#db
      .prepare(`
      UPDATE approvals SET state = 'approved', approved = 1, answered_at = ?
      WHERE id = ? AND state = 'pending' AND owner_user = ? AND owner_contact = ? AND expires_at > ?
    `)
      .run(Date.now(), id, owner.userId, owner.contactId, Date.now());

    if (result.changes !== 1) {
      return "unavailable";
    }

    waiting.answer.resolve(undefined);

    return "decided";
  }

  asked(owner: ApprovalOwner): number[] {
    return [...this.#waiting].flatMap(([id, waiting]) => {
      if (
        waiting.owner.userId !== owner.userId ||
        waiting.owner.contactId !== owner.contactId ||
        !Approvals.#inTime(waiting)
      ) {
        return [];
      }

      return this.#db
        .prepare("SELECT id FROM approvals WHERE id = ? AND state = 'pending'")
        .get(id) === undefined
        ? []
        : [id];
    });
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

  async skipBefore(receivedAt: Date): Promise<void> {
    for (const [id, waiting] of this.#waiting) {
      if (waiting.createdAt < receivedAt.getTime()) {
        this.#reject(id, "skipped");
      }
    }

    await Promise.resolve();
  }

  close(): void {
    for (const id of this.#waiting.keys()) {
      this.#reject(id, "revoked");
    }

    this.#prune();
    this.#db.close();
  }

  #delivered(id: number, waiting: Waiting, delivery: ApprovalDelivery): void {
    if (
      waiting.message?.itemId !== delivery.itemId ||
      waiting.message.fileId !== delivery.fileId
    ) {
      throw new Error(
        "Approval delivery does not match the request's message and attachment."
      );
    }

    const deliveredAt = Math.max(delivery.uploadedAt, delivery.deliveredAt);
    const now = Date.now();

    if (
      !Number.isFinite(deliveredAt) ||
      deliveredAt < waiting.createdAt ||
      deliveredAt > now
    ) {
      throw new Error("Approval delivery time is invalid.");
    }

    const expiresAt = deliveredAt + LIFETIME_MS;

    const result = this.#db
      .prepare(`
      UPDATE approvals SET state = 'pending', asked_at = ?, uploaded_at = ?, delivered_at = ?, expires_at = ?
      WHERE id = ? AND state = 'delivering' AND item_id = ? AND file_id = ?
    `)
      .run(
        deliveredAt,
        delivery.uploadedAt,
        delivery.deliveredAt,
        expiresAt,
        id,
        delivery.itemId,
        delivery.fileId
      );

    if (result.changes !== 1) {
      throw new Error("Approval was cancelled during delivery.");
    }

    waiting.deliveredAt = deliveredAt;
    waiting.expiresAt = expiresAt;
    waiting.deadline = performance.now() + Math.max(0, expiresAt - now);
    waiting.timer = setTimeout(
      () => {
        this.#reject(id, "expired");
      },
      Math.max(0, expiresAt - now)
    );
    waiting.timer.unref();
  }

  static #inTime(waiting: Waiting): boolean {
    const now = Date.now();

    return (
      !waiting.controller.signal.aborted &&
      waiting.deliveredAt !== undefined &&
      waiting.expiresAt !== undefined &&
      waiting.deadline !== undefined &&
      now >= waiting.deliveredAt &&
      now < waiting.expiresAt &&
      performance.now() < waiting.deadline
    );
  }

  #reject(id: number, reason: Rejection): boolean {
    const waiting = this.#waiting.get(id);

    if (waiting === undefined) {
      return false;
    }

    const result = this.#db
      .prepare(`
      UPDATE approvals SET state = ?, approved = 0, skipped = ?, answered_at = ?
      WHERE id = ? AND state IN ('delivering', 'pending', 'approved')
    `)
      .run(reason, reason === "skipped" ? 1 : 0, Date.now(), id);

    if (result.changes !== 1) {
      return false;
    }

    clearTimeout(waiting.timer);
    waiting.controller.abort();
    waiting.answer.reject(
      new Error(`Approval ${id} was ${reason}. Ask again for a new request.`)
    );
    void this.#show(waiting, id, reason);

    return true;
  }

  async #show(waiting: Waiting, id: number, state: string): Promise<void> {
    if (waiting.message === undefined) {
      return;
    }

    try {
      const phone = await this.#phone.promise;
      await phone.editCaption(
        waiting.owner,
        waiting.message.itemId,
        `*Request ${id}: ${state} at ${clockTime.format(new Date())}*\n\n${waiting.summary}\n\nFull details remain attached.`
      );
    } catch (error) {
      report("approvals", `Could not update approval ${id}: ${String(error)}`);
    }
  }
}
