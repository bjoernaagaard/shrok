import path from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  createRegistry,
  Harness,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import type { Approvals } from "./approvals/approvals.ts";
import { createCodemode } from "./codemode.ts";
import { ask } from "./conversation.ts";
import type { From } from "./conversation.ts";
import { createFlows } from "./flows.ts";
import { Items } from "./items.ts";
import type { Layout } from "./layout.ts";
import { loadLocalTools } from "./local-tools.ts";
import { markViewCache } from "./memory/cache.ts";
import { createMemory } from "./memory/extension.ts";
import { Memory } from "./memory/memory.ts";
import { MemoryStore } from "./memory/store.ts";
import { createShrokModels } from "./models.ts";
import { Partials } from "./partials.ts";
import type { ShowProgress } from "./partials.ts";
import { createSchedules } from "./schedules.ts";
import type { Notify } from "./schedules.ts";
import { mcpConfig } from "./settings.ts";
import { createBrowserTools } from "./tools/browser.ts";
import { createTools } from "./tools/extension.ts";
import { createGuard } from "./tools/guard.ts";
import { connectMcpServers } from "./tools/mcp.ts";
import { ToolCatalog } from "./tools/policy.ts";
import { openPublicWeb } from "./tools/public-web.ts";
import { startSandbox, stopSandbox } from "./tools/sandbox.ts";
import { SeenUrls } from "./tools/seen-urls.ts";
import type { SendFile } from "./tools/send.ts";
import {
  BUNDLED_SKILLS,
  expandSkillCommand,
  loadSkills,
} from "./tools/skills.ts";

const context = BACKGROUND_CONTEXT;

/**
 * Retries of a failed model call. Anthropic's rate limits refill per minute, and pi-durable's default gives up
 * after about 14 s, so a burst, such as several shared links at once, lost its answers.
 */
const RETRY = { baseDelayMs: 5000, maxAgentDelayMs: 120_000, maxRetries: 8 };

interface Outbox {
  readonly notify: Notify;
  readonly sendFile: SendFile;
}

/** How a request with a given ID ended: answered, given up on, or not asked yet. */
type Settled = "done" | "unanswered" | undefined;

export interface Brain {
  /**
   * Answers once per `requestId`; asking again with the same ID returns the stored answer. `show` receives the
   * answer's progress, while the model works on it.
   */
  answer: (
    text: string,
    requestId: string,
    sentAt: Date,
    show?: ShowProgress
  ) => Promise<string>;
  /** Tells the conversation that something happened, as an event rather than the owner's words, and returns the answer. */
  report: (text: string, requestId: string, at: Date) => Promise<string>;
  settled: (requestId: string) => Promise<Settled>;
  /** Stops the work in progress; false when nothing was running. Schedules keep their times. */
  stop: () => Promise<boolean>;
  attach: (outbox: Outbox) => void;
  close: () => Promise<void>;
}

const unansweredText = (reason: string): string =>
  reason === "aborted"
    ? "I stopped before finishing. Send it again if you still want it."
    : `I couldn't finish this (${reason}). Send it again to retry.`;

export const openBrain = async (
  layout: Layout,
  approvals: Approvals
): Promise<Brain> => {
  const { chatModel, classifier, models, smallModel } =
    await createShrokModels(markViewCache);

  const mcp = await connectMcpServers(mcpConfig);
  const publicWeb = await openPublicWeb(layout.dataDir);

  await startSandbox(layout, publicWeb.bashProxyPort);

  const items = new Items(layout);
  const seenUrls = new SeenUrls(approvals);

  const catalog = new ToolCatalog();

  const browser = createBrowserTools(
    path.join(layout.dataDir, "browser", "state.json"),
    publicWeb,
    approvals,
    seenUrls,
    () => approvals.waitingFor(catalog.pageTools())
  );

  await browser.check();

  const local = await loadLocalTools({ approvals, browser });

  const memory = new Memory(
    new MemoryStore(path.join(layout.dataDir, "memory.sqlite")),
    models,
    smallModel
  );

  const fileSender = Promise.withResolvers<SendFile>();
  const remembering = createMemory(memory);
  const schedules = createSchedules();
  const codemode = createCodemode(mcp.namespaces);

  const tools = createTools({
    approvals,
    fileSender: fileSender.promise,
    items,
    layout,
    mcpTools: mcp.tools,
    moreTools: [...browser.tools, ...local.tools],
    publicWeb,
    seenUrls,
    smallModel,
  });

  const flows = createFlows(
    layout,
    codemode.options,
    approvals,
    classifier,
    catalog
  );

  catalog.add([
    ...remembering.tools,
    ...schedules.tools,
    ...codemode.policies,
    ...tools.tools,
    ...flows.tools,
    ...(local.policies ?? []),
  ]);

  const guard = createGuard(catalog);
  const registry = createRegistry();

  for (const extension of [
    remembering.extension,
    tools.extension,
    schedules.extension,
    ...codemode.extensions,
    flows.extension,
    guard.extension,
  ]) {
    registry.install(extension);
  }

  const names = new Set<string>();

  for (const extension of registry.snapshot().installed()) {
    for (const tool of extension.tools ?? []) {
      if (names.has(tool.name)) {
        throw new Error(`Duplicate tool registration: ${tool.name}`);
      }

      names.add(tool.name);
    }

    registry.install({
      ...extension,
      tools: guard.guard(extension.tools ?? []),
    });
  }

  const storage = await openNodeSqliteStorage(
    path.join(layout.dataDir, "shrok.sqlite")
  );

  const harness = await Harness.open(
    storage,
    {
      env: () => new NodeExecutionEnv({ cwd: layout.workspace }),
      models,
      registry,
      // A failed run must not hold up the messages queued behind it until the owner writes again.
      settings: {
        afterFailedRun: "continue",
        compaction: { enabled: false },
        retry: RETRY,
      },
    },
    context
  );

  const root = await harness.root(context);

  await root.configure({ model: chatModel }, context);

  const partials = new Partials((name, args) => catalog.phrase(name, args));

  await partials.attach(harness, root.id, context);
  harness.resume();

  const submit = async (
    message: { text: string; requestId: string; at: Date; from: From },
    show?: ShowProgress
  ): Promise<string> => {
    let listened: Parameters<Partials["forget"]>[0] | undefined;

    const answered = await ask(
      {
        answerOf: async (id) => {
          const entry = await root.commit(
            async (tx) => await tx.entry(AssistantEntry, id),
            context
          );

          return entry?.model;
        },
        submit: async (draft, submitContext) =>
          await root.submit(draft, submitContext),
      },
      message,
      context,
      (submission) => {
        if (show !== undefined) {
          listened = submission.id;
          partials.listen(submission.id, show);
        }
      }
    ).finally(() => {
      if (listened !== undefined) {
        partials.forget(listened);
      }
    });

    return answered.answered ? answered.text : unansweredText(answered.reason);
  };

  const answer = async (
    text: string,
    requestId: string,
    sentAt: Date,
    show?: ShowProgress
  ): Promise<string> => {
    // Only the owner's own words make addresses safe to open.
    seenUrls.note(text);

    const answered = await submit(
      {
        at: sentAt,
        from: "owner",
        requestId,
        text: expandSkillCommand(
          text,
          loadSkills([layout.skills, BUNDLED_SKILLS]).skills
        ),
      },
      show
    );

    // An answer can end with a tool, such as send_file, and no words; the owner still gets a reply.
    return answered === "" ? "Done." : answered;
  };

  return {
    answer,
    attach: ({ notify, sendFile }) => {
      schedules.attach(notify);
      fileSender.resolve(sendFile);
    },
    close: async () => {
      await partials.close();
      await harness.close(context);
      await codemode.options.sandbox.close();
      await memory.close();
      await mcp.close();
      await browser.close();
      await publicWeb.close();
      await stopSandbox();
      items.close();
    },
    report: async (text, requestId, at) =>
      await submit({ at, from: "event", requestId, text }),
    settled: async (requestId) => {
      const submission = await storage.submissionByRequest(
        root.id,
        requestId,
        context
      );

      return submission?.status === "done" ||
        submission?.status === "unanswered"
        ? submission.status
        : undefined;
    },
    stop: async () => {
      const busy = partials.busy();
      const acting = approvals.stop();

      await root.abort(context);

      return busy || acting;
    },
  };
};
