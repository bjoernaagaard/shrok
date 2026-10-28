import path from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  createRegistry,
  Harness,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";

import { createCodemodeSandbox } from "./codemode.ts";
import { createFlowsExtension } from "./flows.ts";
import { Items } from "./items.ts";
import { loadLocalTools } from "./local-tools.ts";
import { createMemoryExtension } from "./memory/extension.ts";
import { Memory, OPTCHAT_SIZES } from "./memory/memory.ts";
import { MemoryStore } from "./memory/store.ts";
import { createShrokModels } from "./models.ts";
import { Partials } from "./partials.ts";
import type { ShowProgress } from "./partials.ts";
import { answerText, createSchedulesExtension } from "./schedules.ts";
import type { Notify } from "./schedules.ts";
import { mcpConfig } from "./settings.ts";
import { localTime } from "./time.ts";
import type { Approvals } from "./tools/approvals.ts";
import { createBrowserTools } from "./tools/browser.ts";
import { createToolsExtension } from "./tools/extension.ts";
import { restrictTools } from "./tools/judge.ts";
import { connectMcpServers } from "./tools/mcp.ts";
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

interface Outbox {
  readonly notify: Notify;
  readonly sendFile: SendFile;
}

export interface Brain {
  /** Answers once per `requestId`; asking again with the same ID returns the stored answer. */
  /** `show` receives the answer's progress, while the model works on it. */
  answer: (
    text: string,
    requestId: string,
    sentAt: Date,
    show?: ShowProgress
  ) => Promise<string>;
  /** True once what was submitted with `requestId` has its final answer, or none it ever will. */
  finished: (requestId: string) => Promise<boolean>;
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
  dataDir: string,
  approvals: Approvals
): Promise<Brain> => {
  const { chatModel, classifier, models, smallModel } =
    await createShrokModels();

  const workspace = path.join(dataDir, "workspace");
  const skillsDir = path.join(workspace, "skills");
  const mcp = await connectMcpServers(mcpConfig);

  await startSandbox(dataDir, workspace);

  const items = new Items(workspace);
  const publicWeb = await openPublicWeb(dataDir);
  const seenUrls = new SeenUrls(approvals);

  const browser = createBrowserTools(
    path.join(dataDir, "browser", "state.json"),
    publicWeb,
    approvals,
    seenUrls
  );

  await browser.check();

  const local = await loadLocalTools(browser, approvals);
  const localAllowed = new Set(local.allowed);

  const memory = new Memory(
    new MemoryStore(path.join(dataDir, "memory.sqlite")),
    models,
    smallModel,
    OPTCHAT_SIZES
  );

  const registry = createRegistry();
  const fileSender = Promise.withResolvers<SendFile>();

  registry.install(createMemoryExtension(memory));
  registry.install(
    createToolsExtension({
      allowed: localAllowed,
      approvals,
      browserTools: [...browser.tools, ...local.tools],
      dataDir,
      fileSender: fileSender.promise,
      items,
      mcpTools: mcp.tools,
      publicWeb,
      searchModel: smallModel,
      seenUrls,
      textModel: smallModel,
      workspace,
    })
  );
  const schedules = createSchedulesExtension(approvals);

  registry.install(schedules.extension);

  const codemode = {
    namespaces: mcp.namespaces,
    sandbox: createCodemodeSandbox(),
  };

  registry.install(createToolSearchExtension());
  registry.install(createCodemodeExtension(codemode));
  registry.install(
    createFlowsExtension(workspace, codemode, approvals, classifier)
  );

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
      tools: restrictTools(extension.tools ?? [], localAllowed),
    });
  }

  const storage = await openNodeSqliteStorage(
    path.join(dataDir, "shrok.sqlite")
  );

  const harness = await Harness.open(
    storage,
    {
      env: () => new NodeExecutionEnv({ cwd: workspace }),
      models,
      registry,
      settings: { compaction: { enabled: false } },
    },
    context
  );

  const root = await harness.root(context);

  await root.configure({ model: chatModel }, context);

  const partials = new Partials(local.phrases ?? {});

  await partials.attach(harness, root.id, context);
  harness.resume();

  const answer = async (
    text: string,
    requestId: string,
    sentAt: Date,
    show?: ShowProgress
  ): Promise<string> => {
    seenUrls.note(text);

    const submission = await root.submit(
      {
        content: `<sent>${localTime.format(sentAt)}</sent>\n\n${expandSkillCommand(text, loadSkills([skillsDir, BUNDLED_SKILLS]).skills)}`,
        requestId,
        type: "input",
      },
      context
    );

    if (show !== undefined) {
      partials.listen(submission.id, show);
    }

    const settled = await submission.wait(context).finally(() => {
      partials.forget(submission.id);
    });

    if (settled.status !== "done" || settled.type !== "input") {
      return unansweredText(
        settled.status === "unanswered" ? settled.reason : settled.status
      );
    }

    const answerId = settled.answer;

    const entry = await root.commit(
      async (tx) => await tx.entry(AssistantEntry, answerId),
      context
    );

    return answerText(entry?.model);
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
      await codemode.sandbox.close();
      await memory.close();
      await mcp.close();
      await browser.close();
      await publicWeb.close();
      await stopSandbox();
      items.close();
    },
    finished: async (requestId) => {
      const submission = await storage.submissionByRequest(
        root.id,
        requestId,
        context
      );

      return (
        submission?.status === "done" || submission?.status === "unanswered"
      );
    },
    stop: async () => {
      const busy = partials.busy();

      await root.abort(context);

      return busy;
    },
  };
};
