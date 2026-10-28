import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { setInterval, setTimeout as sleep } from "node:timers/promises";

import { api } from "simplex-chat";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { StageFailedError } from "./stage.ts";

export { StageFailedError } from "./stage.ts";

export const REPLY_BUDGET_MS = 120_000;
const START_BUDGET_MS = 60_000;
const PRIVATE_UMASK = 0o077;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

// The harness is a separate process from Shrok, so it must protect its own retained output.
process.umask(PRIVATE_UMASK);

/** Longer than Shrok's own 20 s shutdown limit, so a slow shutdown shows up in its events. */
const EXIT_BUDGET_MS = 25_000;
const ROOT = path.resolve(import.meta.dirname, "..");

/** SHROK_COMMAND runs an installed Shrok, such as /opt/shrok/bin/shrok, instead of this checkout. */
const SHROK = process.env.SHROK_COMMAND ?? "";

const shrok = (command: "run" | "pair"): [string, string[]] =>
  SHROK === ""
    ? [process.execPath, ["src/cli.ts", command]]
    : [SHROK, [command]];

// A terminal, as for shrok pair --replace, ends lines with \r\n.
const INVITE = /15 minutes:\r?\n\r?\n(?<link>\S+)\r?\n/u;
const READY = "Shrok is ready";
const PAIRED = "Paired.";
const ToolRow = Type.Object({ tool: Type.String() });
const APPROVAL = /^\/'yes (?<id>\d+)'/u;
const ANSWERED = /^\*Request \d+: /u;
const STILL_ARRIVING = "That request is still arriving";
const ANSWER_ATTEMPTS = 10;
const ANSWER_RETRY_MS = 3000;
const POLL_MS = 500;
const CONFIRM = "REPLACE";

const quote = (arg: string): string =>
  `'${arg.replaceAll("'", String.raw`'\''`)}'`;

const ResultRow = Type.Object({ record: Type.String() });

const ToolResult = Type.Object({
  model: Type.Array(
    Type.Object({
      content: Type.Optional(
        Type.Array(Type.Object({ text: Type.Optional(Type.String()) }))
      ),
      isError: Type.Optional(Type.Boolean()),
      role: Type.String(),
      toolName: Type.Optional(Type.String()),
    })
  ),
});

export interface ToolRun {
  readonly tool: string;
  readonly isError: boolean;
  readonly text: string;
}

/** The approval request a message is, or undefined when it is an ordinary reply. */
export const approvalId = (text: string): string | undefined =>
  APPROVAL.exec(text)?.groups?.id;

/** A reply from the model, not an approval request or Shrok's note that one was answered. */
export const isReply = (text: string): boolean =>
  approvalId(text) === undefined &&
  !ANSWERED.test(text) &&
  !text.startsWith(STILL_ARRIVING);

type Details = Readonly<Record<string, string | readonly string[]>>;

type Chat = Parameters<api.ChatApi["apiSendTextMessage"]>[0];

export interface Message {
  readonly direction: "to Shrok" | "from Shrok";
  readonly text: string;
  readonly at: string;
  /** Which test phone sent or got it: 1 is the first owner, 2 the one that replaced it. */
  readonly phone: number;
}

export class Session {
  readonly dataDir: string;
  readonly outputDir: string;
  readonly messages: Message[] = [];
  readonly logs: string[] = [];
  linksFile: string | undefined;
  readonly #phoneDir: string;
  readonly #waiters = new Set<() => void>();
  readonly #phones: api.ChatApi[] = [];
  #shrok: ChildProcess | undefined;
  #env: NodeJS.ProcessEnv = {};
  #phone: api.ChatApi | undefined;
  #chat: Chat | undefined;
  #runs = 0;

  private constructor(dataDir: string, phoneDir: string, outputDir: string) {
    this.dataDir = dataDir;
    this.outputDir = outputDir;
    this.#phoneDir = phoneDir;
  }

  static async open(name: string): Promise<Session> {
    const outputRoot = path.join(import.meta.dirname, "output");
    const outputDir = path.join(outputRoot, name);

    await mkdir(outputRoot, { mode: PRIVATE_DIRECTORY_MODE, recursive: true });
    await chmod(outputRoot, PRIVATE_DIRECTORY_MODE);
    await mkdir(outputDir, { mode: PRIVATE_DIRECTORY_MODE, recursive: true });
    await chmod(outputDir, PRIVATE_DIRECTORY_MODE);

    return new Session(
      // Short: the data folder holds the pairing socket, whose path may be 103 bytes on macOS.
      await mkdtemp(path.join(tmpdir(), "shrok-data-")),
      await mkdtemp(path.join(tmpdir(), "shrok-phone-")),
      outputDir
    );
  }

  async start(): Promise<void> {
    this.#runs += 1;

    const run = this.#runs;

    const logPath = path.join(this.outputDir, `shrok-run${run}.log`);
    const logFile = await open(logPath, "w", PRIVATE_FILE_MODE);

    await logFile.chmod(PRIVATE_FILE_MODE);

    const log = logFile.createWriteStream();

    const { SHROK_LINKS_FILE: _owners, ...inherited } = process.env;

    const env: NodeJS.ProcessEnv = {
      ...inherited,
      SHROK_DATA_DIR: this.dataDir,
    };

    if (this.linksFile !== undefined) {
      env.SHROK_LINKS_FILE = this.linksFile;
    }

    const child = spawn(...shrok("run"), {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.logs.push(logPath);
    this.#env = env;
    this.#shrok = child;
    child.stdout.pipe(log, { end: false });

    let stderr = "";
    const ready = Promise.withResolvers<boolean>();

    child.stderr.on("data", (chunk: Buffer) => {
      log.write(chunk);
      stderr += chunk.toString();

      if (stderr.includes(READY)) {
        ready.resolve(true);
      }
    });
    child.once("exit", () => {
      ready.resolve(false);
    });
    // After the output closes too, so nothing is lost. Ending the stream closes its file, which Node
    // otherwise treats as an error once the file is garbage collected.
    child.once("close", (exitCode) => {
      log.end(`\n[exited with ${String(exitCode)}]\n`);
    });

    const started = await Promise.race([
      ready.promise,
      sleep(START_BUDGET_MS, false, { ref: false }),
    ]);

    const stage = run === 1 ? "start" : "restart";

    if (!started || child.exitCode !== null) {
      throw new StageFailedError(stage, `Shrok run ${run} did not start`);
    }

    if (run > 1) {
      return;
    }

    const link = await this.#pairCommand(env);

    const logged = await readFile(logPath, "utf-8");

    if (logged.includes(link)) {
      throw new StageFailedError(
        "pairing",
        "the invite link appeared in Shrok's own log, not only in shrok pair's terminal"
      );
    }
  }

  /** Runs `shrok pair`, connects the test phone through the link it prints, and waits for it to say Paired. */
  async #pairCommand(env: NodeJS.ProcessEnv): Promise<string> {
    const pair = spawn(...shrok("pair"), {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const link = Promise.withResolvers<string | undefined>();

    pair.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();

      const found = INVITE.exec(stdout)?.groups?.link;

      if (found !== undefined) {
        link.resolve(found);
      }
    });
    pair.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const exited = once(pair, "exit");

    pair.once("exit", () => {
      link.resolve(undefined);
    });

    const invite = await Promise.race([
      link.promise,
      sleep(START_BUDGET_MS, undefined, { ref: false }),
    ]);

    if (invite === undefined) {
      pair.kill();
      throw new StageFailedError(
        "pairing",
        `shrok pair printed no invite link: ${stderr.trim()}`
      );
    }

    await this.#pair(invite, this.#phoneDir);

    const [exitCode] = await Promise.race([
      exited,
      sleep(REPLY_BUDGET_MS, [null], { ref: false }),
    ]);

    if (exitCode !== 0 || !stdout.includes(PAIRED)) {
      pair.kill();
      throw new StageFailedError(
        "pairing",
        `shrok pair did not report the pairing (exit ${String(exitCode)}): ${stderr.trim()}`
      );
    }

    return invite;
  }

  /**
   * Pairs a second test phone with shrok pair --replace, typing its confirmation in a terminal as the owner
   * would. The first phone stays connected, so the test sees what still reaches it.
   */
  async replaceOwner(): Promise<void> {
    const [command, args] = shrok("pair");
    const line = [command, ...args, "--replace"].map(quote).join(" ");

    // script gives shrok pair the terminal it requires. Its input must be a pipe, which sh makes: it types the
    // confirmation, then cat keeps the input open until the test ends it.
    const terminal =
      process.platform === "darwin"
        ? `script -q /dev/null ${line}`
        : `script -qec ${quote(line)} /dev/null`;

    const pair = spawn(
      "sh",
      ["-c", `{ printf '${CONFIRM}\\n'; cat; } | ${terminal}`],
      { cwd: ROOT, env: this.#env, stdio: ["pipe", "pipe", "pipe"] }
    );

    let output = "";
    const link = Promise.withResolvers<string | undefined>();

    const read = (chunk: Buffer): void => {
      output += chunk.toString();

      const found = INVITE.exec(output)?.groups?.link;

      if (found !== undefined) {
        link.resolve(found);
      }
    };

    pair.stdout.on("data", read);
    pair.stderr.on("data", read);

    const exited = once(pair, "exit");

    pair.once("exit", () => {
      link.resolve(undefined);
    });

    const invite = await Promise.race([
      link.promise,
      sleep(START_BUDGET_MS, undefined, { ref: false }),
    ]);

    if (invite === undefined) {
      pair.kill();
      throw new StageFailedError(
        "replace",
        `shrok pair --replace printed no invite link: ${output.trim()}`
      );
    }

    await this.#pair(
      invite,
      await mkdtemp(path.join(tmpdir(), "shrok-phone-"))
    );

    const paired = async (): Promise<boolean> => {
      for await (const _ of setInterval(POLL_MS)) {
        if (output.includes(PAIRED) || pair.exitCode !== null) {
          break;
        }
      }

      return output.includes(PAIRED);
    };

    const done = await Promise.race([
      paired(),
      sleep(REPLY_BUDGET_MS, false, { ref: false }),
    ]);

    pair.stdin.end();
    await Promise.race([exited, sleep(EXIT_BUDGET_MS)]);

    if (!done) {
      pair.kill();
      throw new StageFailedError(
        "replace",
        `shrok pair --replace did not report the pairing: ${output.trim()}`
      );
    }
  }

  /** Every tool result so far, in order, with its text and whether it failed. */
  toolResults(): ToolRun[] {
    const db = new DatabaseSync(path.join(this.dataDir, "shrok.sqlite"), {
      readOnly: true,
    });

    const rows = db
      .prepare(
        "SELECT record FROM entries WHERE json_extract(record, '$.model[0].role') = 'toolResult' ORDER BY id"
      )
      .all();

    db.close();

    return rows.flatMap((row) => {
      const record: unknown = JSON.parse(Value.Parse(ResultRow, row).record);

      if (!Value.Check(ToolResult, record)) {
        return [];
      }

      return record.model.map((message) => ({
        isError: message.isError === true,
        text: (message.content ?? []).map((part) => part.text ?? "").join("\n"),
        tool: message.toolName ?? "",
      }));
    });
  }

  /**
   * Answers approval request `id` with /yes or /no, as the owner taps it, and returns the reply that follows.
   * It sends again while Shrok says the request is still arriving.
   */
  async answer(
    stage: string,
    id: string,
    decision: "yes" | "no",
    budget: number
  ): Promise<Message> {
    for (let attempt = 1; ; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop
      const since = await this.send(`/${decision} ${id}`);

      // oxlint-disable-next-line no-await-in-loop
      const reply = await this.waitFor(
        stage,
        since,
        budget,
        (text) => !ANSWERED.test(text)
      );

      if (!reply.text.startsWith(STILL_ARRIVING)) {
        return reply;
      }

      if (attempt === ANSWER_ATTEMPTS) {
        throw new StageFailedError(
          stage,
          `request ${id} never finished arriving after ${ANSWER_ATTEMPTS} tries`
        );
      }

      // oxlint-disable-next-line no-await-in-loop
      await sleep(ANSWER_RETRY_MS);
    }
  }

  async stop(): Promise<void> {
    const child = this.#shrok;

    if (child === undefined || child.exitCode !== null) {
      return;
    }

    const exited = once(child, "exit");

    child.kill("SIGINT");
    await Promise.race([exited, sleep(EXIT_BUDGET_MS)]);

    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  }

  async send(text: string): Promise<number> {
    const { chat, phone } = this.#paired();
    const since = this.messages.length;

    this.#record("to Shrok", text);
    await phone.apiSendTextMessage(chat, text);

    return since;
  }

  async share(url: string, title = "", description = ""): Promise<number> {
    const { chat, phone } = this.#paired();
    const since = this.messages.length;

    this.#record("to Shrok", url);
    await phone.apiSendMessages(chat, [
      {
        mentions: {},
        msgContent: {
          preview: { description, image: "", title, uri: url },
          text: url,
          type: "link",
        },
      },
    ]);

    return since;
  }

  toolCalls(): string[] {
    const db = new DatabaseSync(path.join(this.dataDir, "shrok.sqlite"), {
      readOnly: true,
    });

    const rows = db
      .prepare(
        "SELECT json_extract(record, '$.model[0].toolName') AS tool FROM entries WHERE json_extract(record, '$.model[0].role') = 'toolResult' ORDER BY id"
      )
      .all();

    db.close();

    return rows.map((row) => Value.Parse(ToolRow, row).tool);
  }

  async waitFor(
    stage: string,
    since: number,
    budget: number,
    matches: (text: string) => boolean
  ): Promise<Message> {
    const { promise, resolve } = Promise.withResolvers<Message>();

    const check = (): void => {
      const found = this.messages
        .slice(since)
        .find((m) => m.direction === "from Shrok" && matches(m.text));

      if (found !== undefined) {
        resolve(found);
      }
    };

    this.#waiters.add(check);
    check();

    const found = await Promise.race([
      promise,
      sleep(budget, undefined, { ref: false }),
    ]);

    this.#waiters.delete(check);

    if (found === undefined) {
      throw new StageFailedError(
        stage,
        `no matching message within ${budget} ms`
      );
    }

    return found;
  }

  async finish(name: string, test: () => Promise<Details>): Promise<never> {
    let failedAt: string | null = null;
    let error: string | null = null;
    let details: Details = {};

    try {
      details = await test();
    } catch (error_) {
      failedAt = error_ instanceof StageFailedError ? error_.stage : "start";
      error = error_ instanceof Error ? error_.message : String(error_);
    } finally {
      await this.stop();

      for (const phone of this.#phones) {
        // oxlint-disable-next-line no-await-in-loop
        await phone.close();
      }
    }

    const resultFile = path.join(this.outputDir, "result.json");

    await writeFile(
      resultFile,
      `${JSON.stringify(
        {
          ...details,
          dataDir: this.dataDir,
          error,
          failedAt,
          logs: this.logs,
          messages: this.messages,
          passed: failedAt === null,
        },
        null,
        2
      )}\n`,
      { mode: PRIVATE_FILE_MODE }
    );
    await chmod(resultFile, PRIVATE_FILE_MODE);

    process.stdout.write(
      failedAt === null ? `${name}: passed\n` : `${name}: failed at ${error}\n`
    );

    process.exit(failedAt === null ? 0 : 1);
  }

  #paired() {
    const phone = this.#phone;
    const chat = this.#chat;

    if (phone === undefined || chat === undefined) {
      throw new StageFailedError("pairing", "the phone is not paired");
    }

    return { chat, phone };
  }

  async #pair(invite: string, phoneDir: string): Promise<void> {
    const client = await api.ChatApi.init({
      filePrefix: path.join(phoneDir, "phone"),
      type: "sqlite",
    });

    this.#phones.push(client);
    this.#phone = client;

    const phone = this.#phones.length;

    client.on("newChatItems", ({ chatItems }) => {
      for (const { chatItem } of chatItems) {
        if (chatItem.content.type === "rcvMsgContent") {
          this.#onItem(
            chatItem.content.msgContent.text,
            chatItem.meta.itemLive,
            phone
          );
        }
      }
    });
    client.on("chatItemUpdated", ({ chatItem: { chatItem } }) => {
      if (chatItem.content.type === "rcvMsgContent") {
        this.#onItem(
          chatItem.content.msgContent.text,
          chatItem.meta.itemLive,
          phone
        );
      }
    });

    await client.apiCreateActiveUser({ displayName: "owner", fullName: "" });
    await client.startChat();

    const connected = client.wait("contactConnected", REPLY_BUDGET_MS);

    await client.apiConnectActiveUser(invite);

    const event = await connected;
    const contact = event?.contact;

    if (contact === undefined) {
      throw new StageFailedError(
        "pairing",
        "the client never connected to Shrok"
      );
    }

    this.#chat = { contact, type: "direct" };
  }

  #record(
    direction: Message["direction"],
    text: string,
    phone = this.#phones.length
  ): void {
    this.messages.push({
      at: new Date().toISOString(),
      direction,
      phone,
      text,
    });

    for (const wake of this.#waiters) {
      wake();
    }
  }

  #onItem(text: string, live: boolean | undefined, phone: number): void {
    if (live !== true) {
      this.#record("from Shrok", text, phone);
    }
  }
}
