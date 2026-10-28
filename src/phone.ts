import { mkdirSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { CC, T } from "@simplex-chat/types";
import sharp from "sharp";
import { api, bot, util } from "simplex-chat";

import { deliverApproval } from "./approval-delivery.ts";
import { report } from "./events.ts";
import { FILES_FOLDER } from "./items.ts";
import type { Progress } from "./partials.ts";
import { shareMessage } from "./shares.ts";
import { isApprovalRequestText } from "./tools/approvals.ts";
import type { ApprovalPhone, Approvals, Decision } from "./tools/approvals.ts";

type ChatApi = api.ChatApi;

/**
 * Answers one message from the owner: his text, or a share described by `shareMessage`. `requestId` is stable across restarts, so the answerer can
 * recognize a message it has seen before. `show` takes the answer's progress, shown live on the phone.
 */
type Answer = (
  text: string,
  requestId: string,
  sentAt: Date,
  show: (progress: Progress) => void
) => string | Promise<string>;

export interface PhoneHandlers {
  readonly answer: Answer;
  readonly approvals: Approvals;
  /** Stops the work in progress; false when nothing was running. */
  readonly stop: () => Promise<boolean>;
}

/** A one-time link: whoever connects through it becomes the owner. */
interface Invite {
  readonly link: string;
  /** Resolves with the owner's contact ID when the phone connects through this link. */
  readonly paired: Promise<number>;
  /** Deletes the link, unless a phone already connected through it. */
  readonly cancel: () => Promise<void>;
}

export interface Phone {
  readonly hasOwner: () => Promise<boolean>;
  /**
   * Makes a one-time link to pair a phone. Refused while another invite waits, or while an owner exists unless
   * `replace`, which hands ownership to the new phone.
   */
  readonly invite: (replace: boolean) => Promise<Invite>;
  /**
   * Sends a message to the owner and resolves with its chat item ID. With `since`, skips it when the same
   * text was already sent at or after then, so a retried send arrives once.
   */
  send: (text: string, since?: Date) => Promise<number | undefined>;
  readonly approvalPhone: ApprovalPhone;
  /** Sends the file at absolute path `file`, as a picture when it is an image. */
  sendFile: (file: string, caption: string) => Promise<void>;
  close: () => Promise<void>;
}

const OWNER_MARK = { shrokOwner: true };
const RECENT_CHATS = 100;

const APPROVE = "👍";
const DECLINE = "👎";

const REQUEST_UNAVAILABLE =
  "That approval request is invalid or no longer waiting. Use the numbered command on the current request.";

const UNDECIDED: Readonly<Record<Exclude<Decision, "decided">, string>> = {
  beforeDelivery:
    "That request is still arriving on your phone with its details. Send your answer again in a few seconds.",
  unavailable: REQUEST_UNAVAILABLE,
};

const YES_WORDS = new Set(["yes", "y", "ok", "okay", "sure", APPROVE]);
const NO_WORDS = new Set(["no", "n", "nope", DECLINE]);

const COMMANDS: T.ChatBotCommand[] = [
  { keyword: "help", label: "What Shrok can do", type: "command" },
  { keyword: "stop", label: "Stop what Shrok is doing", type: "command" },
  { keyword: "schedules", label: "Show schedules", type: "command" },
  { keyword: "skills", label: "Show skills", type: "command" },
];

const QUESTIONS = new Map([
  [
    "schedules",
    "Show my schedules: what each does and when it next runs. Use the schedules tool.",
  ],
  [
    "skills",
    "Which skills do you have? List each by name with one short line on what it is for.",
  ],
]);

const HELP = `*Shrok* works for you from this chat. Ask in plain words, or share a link, a file or a photo and I'll keep it.

/stop stops what I'm doing
/schedules shows your reminders and timed tasks
/skills shows what I know how to do

An approval must identify its request: use its numbered command, quote the request in a reply, or react ${APPROVE} or ${DECLINE} on that request. Bare approval commands are not accepted.`;

const ANSWERED = new Set<T.MsgContent["type"]>([
  "text",
  "link",
  "file",
  "image",
]);

const UNSAFE_FILE_CHARS = /[^\w.-]+/gu;
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|heic)$/iu;

/** SimpleX carries an image's preview inside the message, so it must stay small. */
const PREVIEW_SIZES = [
  { pixels: 160, quality: 40 },
  { pixels: 120, quality: 30 },
  { pixels: 96, quality: 25 },
] as const;

const MAX_PREVIEW_BYTES = 12_000;

const isAnswered = (item: T.ChatItem): boolean =>
  item.content.type === "rcvMsgContent" &&
  ANSWERED.has(item.content.msgContent.type);

const LIVE_UPDATE_MS = 1000;

const MAX_PENDING_TRANSFERS = 16;
const FILE_TRANSFER_TIMEOUT_MS = 5 * 60 * 1000;

const DELETE_LIVE_MESSAGE = "";

const STATUS_TICK_MS = 5000;

const MS_PER_SECOND = 1000;

const CATCH_UP_ITEMS = 200;

/** A new object per run: `bot.run` writes bot preferences into the profile it is given. */
const shrokProfile = (): T.Profile => ({ displayName: "Shrok", fullName: "" });

const isOwner = (contact: T.Contact): boolean =>
  contact.customData !== undefined &&
  "shrokOwner" in contact.customData &&
  contact.customData.shrokOwner === true;

/** `apiGetChat` is untyped in simplex-chat 7.1; this checks the one field Shrok reads. */
const hasChatItems = (value: unknown): value is { chatItems: T.ChatItem[] } =>
  typeof value === "object" &&
  value !== null &&
  "chatItems" in value &&
  Array.isArray(value.chatItems);

const recentItems = async (
  chat: ChatApi,
  contactId: number,
  count: number
): Promise<T.ChatItem[]> => {
  const found: unknown = await chat.apiGetChat(
    T.ChatType.Direct,
    contactId,
    count
  );

  return hasChatItems(found) ? found.chatItems : [];
};

const sentSince = (item: T.ChatItem, text: string, since: Date): boolean =>
  item.content.type === "sndMsgContent" &&
  item.content.msgContent.text === text &&
  item.meta.itemDeleted === undefined &&
  Date.parse(item.meta.itemTs) >= since.getTime();

/** SimpleX's command to delete a pending connection, which its ChatType enum has no value for. */
const deleteConnection = async (
  chat: ChatApi,
  connId: number
): Promise<void> => {
  const deleted = await chat.sendChatCmd(`/_delete :${connId} full notify=off`);

  if (deleted.type !== "contactConnectionDeleted") {
    throw new Error(
      `SimpleX answered ${deleted.type} to deleting invite ${connId}`
    );
  }
};

/** Invites left by an earlier run: the terminal that asked for them is gone, so nobody may use them. */
const deleteStaleInvites = async (
  chat: ChatApi,
  userId: number
): Promise<void> => {
  const chats = await chat.apiGetChats(
    userId,
    { count: RECENT_CHATS, type: "last" },
    undefined,
    true
  );

  for (const { chatInfo } of chats) {
    if (
      chatInfo.type === "contactConnection" &&
      chatInfo.contactConnection.connLinkInv !== undefined
    ) {
      // oxlint-disable-next-line no-await-in-loop -- SimpleX takes one command at a time
      await deleteConnection(chat, chatInfo.contactConnection.pccConnId);
    }
  }
};

type LiveChat = ConstructorParameters<typeof api.LiveMessage>[0];

const quoting = (
  chat: ChatApi,
  itemId: number,
  guard: <Result>(action: () => Promise<Result>) => Promise<Result>
): LiveChat => ({
  apiDeleteChatItems: async (...args) =>
    await guard(async () => await chat.apiDeleteChatItems(...args)),
  apiSendMessages: async (ref, messages, liveMessage) =>
    await guard(
      async () =>
        await chat.apiSendMessages(
          ref,
          messages.map((message) => ({ ...message, quotedItemId: itemId })),
          liveMessage
        )
    ),
  apiUpdateChatItem: async (...args) =>
    await guard(async () => await chat.apiUpdateChatItem(...args)),
});

const deleteLeftoverLiveReplies = async (
  chat: ChatApi,
  contactId: number
): Promise<void> => {
  const items = await recentItems(chat, contactId, CATCH_UP_ITEMS);

  const leftovers = items
    .filter(
      (item) =>
        item.chatDir.type === "directSnd" &&
        item.meta.itemLive === true &&
        item.meta.itemDeleted === undefined
    )
    .map((item) => item.meta.itemId);

  if (leftovers.length > 0) {
    await chat.apiDeleteChatItems(
      T.ChatType.Direct,
      contactId,
      leftovers,
      T.CIDeleteMode.Broadcast
    );
  }
};

const unanswered = (items: readonly T.ChatItem[]): T.ChatItem[] => {
  const answered = new Set<number>();

  for (const item of items) {
    const finished =
      item.meta.itemLive !== true && item.meta.itemDeleted === undefined;

    const quoted =
      item.chatDir.type === "directSnd" && finished
        ? item.quotedItem?.itemId
        : undefined;

    if (quoted !== undefined) {
      answered.add(quoted);
    }
  }

  return items.filter(
    (item) =>
      isAnswered(item) &&
      !answered.has(item.meta.itemId) &&
      !item.reactions.some((reaction) => reaction.userReacted)
  );
};

const statusLine = (progress: Progress, startedAt: number): string => {
  const seconds = Math.round((Date.now() - startedAt) / MS_PER_SECOND);

  if (progress.activity === undefined) {
    return `⏳ _Thinking, ${seconds} s_`;
  }

  const doing = `${progress.activity.charAt(0).toUpperCase()}${progress.activity.slice(1)}`;

  return `⏳ _${doing}, step ${progress.steps}, ${seconds} s_`;
};

const liveText = (progress: Progress, startedAt: number): string => {
  const status = statusLine(progress, startedAt);

  return progress.text === "" ? status : `${progress.text}\n\n${status}`;
};

/** A small JPEG for SimpleX to show inline, or none when the image can't be read, such as HEIC. */
const imagePreview = async (file: string): Promise<string | undefined> => {
  for (const { pixels, quality } of PREVIEW_SIZES) {
    let jpeg: Buffer;

    try {
      // oxlint-disable-next-line no-await-in-loop -- each smaller size is tried only if the last was too big
      jpeg = await sharp(file)
        .rotate()
        .resize(pixels, pixels, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
    } catch {
      return undefined;
    }

    const encoded = jpeg.toString("base64");

    if (encoded.length <= MAX_PREVIEW_BYTES) {
      return `data:image/jpg;base64,${encoded}`;
    }
  }

  return undefined;
};

type Route =
  | { readonly kind: "handled" }
  | { readonly kind: "brain"; readonly question?: string };

const HANDLED: Route = { kind: "handled" };
const BRAIN: Route = { kind: "brain" };

const plainVerdict = (text: string): boolean | undefined => {
  const word = text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/u, "");

  if (YES_WORDS.has(word)) {
    return true;
  }

  return NO_WORDS.has(word) ? false : undefined;
};

/**
 * The phone that connects through the invite `shrok pair` asked for becomes the owner, and nobody else. Shared files are received as soon as they
 * arrive, because SimpleX relays keep them only for two days. Every answer quotes its message, so after a
 * restart Shrok finds the messages it never answered.
 */
export const openPhone = async (
  dataDir: string,
  handlers: PhoneHandlers
): Promise<Phone> => {
  const { answer, approvals, stop } = handlers;
  const ready = Promise.withResolvers<ChatApi>();
  const activeUser = Promise.withResolvers<number>();
  const inFlight = new Set<number>();
  const workspace = path.join(dataDir, "workspace");
  const filesDir = path.join(workspace, FILES_FOLDER);
  const transfers = new Map<number, PromiseWithResolvers<T.CIFile>>();
  const liveReplies = new Set<() => void>();
  let closing = false;
  let ownerGeneration = Symbol("owner");
  let ownerTasks = Promise.resolve();

  /** Pairing and owner-bound actions share one queue, including native command completion. */
  const withOwnerLock = async <Result>(
    action: () => Promise<Result>
  ): Promise<Result> => {
    const earlier = ownerTasks;
    const done = Promise.withResolvers<undefined>();
    ownerTasks = done.promise;
    await earlier;

    try {
      return await action();
    } finally {
      done.resolve(undefined);
    }
  };

  const currentOwnerId = async (): Promise<number | undefined> => {
    const chat = await ready.promise;
    const contacts = await chat.apiListContacts(await activeUser.promise);
    const owners = contacts.filter(isOwner);

    return owners.length === 1 ? owners[0]?.contactId : undefined;
  };

  const withOwner = async <Result>(
    contactId: number,
    generation: symbol,
    action: () => Promise<Result>
  ): Promise<Result> =>
    await withOwnerLock(async () => {
      if (
        closing ||
        generation !== ownerGeneration ||
        contactId !== (await currentOwnerId())
      ) {
        throw new Error("The phone owner changed before the action.");
      }

      return await action();
    });

  /** The invite waiting for a phone, by its connection ID. */
  let pending:
    | {
        readonly connId: number;
        readonly replace: boolean;
        readonly paired: PromiseWithResolvers<number>;
      }
    | undefined;

  mkdirSync(filesDir, { recursive: true });

  const transfer = (fileId: number): PromiseWithResolvers<T.CIFile> => {
    const known = transfers.get(fileId);

    if (known !== undefined) {
      return known;
    }

    if (closing || transfers.size >= MAX_PENDING_TRANSFERS) {
      throw new Error("No file transfer slot is available.");
    }

    const done = Promise.withResolvers<T.CIFile>();

    const timeout = setTimeout(() => {
      done.reject(new Error("The file transfer timed out."));
    }, FILE_TRANSFER_TIMEOUT_MS);

    timeout.unref();

    const created = {
      ...done,
      promise: done.promise.finally(() => {
        clearTimeout(timeout);

        if (transfers.get(fileId) === created) {
          transfers.delete(fileId);
        }
      }),
    };

    // An event may reject the waiter while ReceiveFile's command is still pending.
    void created.promise.catch(() => {
      // receive observes this rejection after its native command returns.
    });
    transfers.set(fileId, created);

    return created;
  };

  const receivedPath = (itemId: number, file: T.CIFile): string =>
    path.resolve(
      filesDir,
      `${itemId}-${path.basename(file.fileName).replaceAll(UNSAFE_FILE_CHARS, "_")}`
    );

  const receive = async (itemId: number, file: T.CIFile): Promise<T.CIFile> => {
    const status = file.fileStatus.type;

    if (status === "rcvComplete") {
      return file;
    }

    if (status === "rcvAccepted" || status === "rcvTransfer") {
      return await transfer(file.fileId).promise;
    }

    if (status !== "rcvInvitation") {
      throw new Error(`the transfer ended as ${status}`);
    }

    const chat = await ready.promise;
    const done = transfer(file.fileId);

    try {
      const accepted = await chat.sendChatCmd(
        CC.ReceiveFile.cmdString({
          fileId: file.fileId,
          filePath: receivedPath(itemId, file),
          storeEncrypted: false,
          userApprovedRelays: true,
        })
      );

      if (accepted.type !== "rcvFileAccepted") {
        throw new Error(`SimpleX answered ${accepted.type}`);
      }

      return await done.promise;
    } catch (error) {
      done.reject(error);
      throw error;
    }
  };

  const messageText = async (
    item: T.ChatItem,
    content: T.MsgContent
  ): Promise<string> => {
    if (content.type === "link") {
      return shareMessage({
        kind: "link",
        preview: content.preview.description,
        text: content.text,
        title: content.preview.title,
        url: content.preview.uri,
      });
    }

    if (
      (content.type !== "file" && content.type !== "image") ||
      item.file === undefined
    ) {
      return content.text;
    }

    try {
      const received = await receive(item.meta.itemId, item.file);

      const saved = receivedPath(item.meta.itemId, item.file);
      const source = received.fileSource?.filePath;
      const savedStat = await stat(saved);

      if (
        received.fileId !== item.file.fileId ||
        received.fileStatus.type !== "rcvComplete" ||
        source === undefined ||
        path.resolve(filesDir, source) !== saved ||
        (await realpath(saved)) !==
          path.join(await realpath(filesDir), path.basename(saved)) ||
        !savedStat.isFile()
      ) {
        throw new Error("The received file does not match this attachment.");
      }

      return shareMessage({
        bytes: received.fileSize,
        kind: content.type,
        name: item.file.fileName,
        text: content.text,
        workspacePath: path.relative(workspace, saved),
      });
    } catch (error) {
      return shareMessage({
        kind: "lost",
        name: item.file.fileName,
        reason: error instanceof Error ? error.message : String(error),
        text: content.text,
      });
    }
  };

  /** Makes the contact the owner when it connected through the pending invite. */
  const claimOwner = async (contact: T.Contact): Promise<void> => {
    await withOwnerLock(async () => {
      const invite = pending;

      if (
        closing ||
        invite === undefined ||
        contact.activeConn?.connId !== invite.connId
      ) {
        return;
      }

      const chat = await ready.promise;

      try {
        const contacts = await chat.apiListContacts(await activeUser.promise);

        if (!invite.replace && contacts.some(isOwner)) {
          throw new Error("Shrok already has an owner.");
        }

        // Work the previous owner started must not outlive their ownership.
        if (contacts.some(isOwner)) {
          await stop();
        }

        ownerGeneration = Symbol("owner");

        for (const cancel of liveReplies) {
          cancel();
        }

        liveReplies.clear();

        for (const earlier of contacts) {
          if (isOwner(earlier)) {
            // oxlint-disable-next-line no-await-in-loop -- ownership changes must commit in order
            await chat.apiSetContactCustomData(earlier.contactId, {});
          }
        }

        await chat.apiSetContactCustomData(contact.contactId, OWNER_MARK);
        invite.paired.resolve(contact.contactId);
      } catch (error) {
        invite.paired.reject(error);
        throw error;
      } finally {
        pending = undefined;
      }
    });
  };

  const say = async (
    contactId: number,
    itemId: number,
    text: string
  ): Promise<void> => {
    const chat = await ready.promise;

    await chat.apiSendTextMessage([T.ChatType.Direct, contactId], text, itemId);
  };

  const react = async (
    contactId: number,
    itemId: number,
    emoji: string
  ): Promise<void> => {
    const chat = await ready.promise;

    await chat.apiChatItemReaction(T.ChatType.Direct, contactId, itemId, true, {
      emoji,
      type: "emoji",
    });
  };

  const approve = async (
    contactId: number,
    itemId: number,
    approved: boolean,
    params: string,
    receivedAt: number
  ): Promise<void> => {
    const verb = approved ? "yes" : "no";
    const approvalOwner = { contactId, userId: await activeUser.promise };
    const waiting = approvals.asked(approvalOwner);
    const named = /^\d+$/u.test(params) ? Number(params) : undefined;

    const decision =
      named !== undefined && Number.isSafeInteger(named) && named > 0
        ? approvals.decide(named, approved, approvalOwner, receivedAt)
        : "unavailable";

    if (decision === "decided") {
      await react(contactId, itemId, approved ? APPROVE : DECLINE);

      return;
    }

    if (params !== "") {
      await say(contactId, itemId, UNDECIDED[decision]);

      return;
    }

    if (waiting.length === 0) {
      await say(
        contactId,
        itemId,
        `Nothing is waiting for your ${verb} right now.`
      );

      return;
    }

    const choices = waiting.map((waitingId) => `/'${verb} ${waitingId}'`);

    await say(
      contactId,
      itemId,
      `An approval must identify its request. Tap the one you mean:\n\n${choices.join("   ")}`
    );
  };

  const route = async (
    contactId: number,
    item: T.ChatItem,
    text: string
  ): Promise<Route> => {
    const { itemId } = item.meta;
    const receivedAt = Date.parse(item.meta.createdAt);

    const quotedRequest =
      item.quotedItem?.itemId === undefined
        ? undefined
        : approvals.requestIn(item.quotedItem.itemId, {
            contactId,
            userId: await activeUser.promise,
          });

    const verdict = plainVerdict(text);

    if (quotedRequest !== undefined && verdict !== undefined) {
      await approve(
        contactId,
        itemId,
        verdict,
        String(quotedRequest),
        receivedAt
      );

      return HANDLED;
    }

    if (
      verdict !== undefined &&
      isApprovalRequestText(item.quotedItem?.content.text)
    ) {
      await say(contactId, itemId, REQUEST_UNAVAILABLE);

      return HANDLED;
    }

    const command = util.ciBotCommand(item);
    const keyword = command?.keyword.toLowerCase();

    if (command === undefined || keyword === undefined) {
      return BRAIN;
    }

    if (keyword === "yes" || keyword === "no") {
      await approve(
        contactId,
        itemId,
        keyword === "yes",
        command.params,
        receivedAt
      );

      return HANDLED;
    }

    if (keyword === "help") {
      await say(contactId, itemId, HELP);

      return HANDLED;
    }

    if (keyword === "stop") {
      await ((await stop())
        ? react(contactId, itemId, APPROVE)
        : say(contactId, itemId, "Nothing is running right now."));

      return HANDLED;
    }

    const question = QUESTIONS.get(keyword);

    return question === undefined ? BRAIN : { kind: "brain", question };
  };

  const think = async (
    chat: ChatApi,
    contactId: number,
    item: T.ChatItem,
    question: string | undefined,
    generation: symbol
  ): Promise<void> => {
    if (closing || generation !== ownerGeneration) {
      return;
    }

    const { itemId } = item.meta;
    const startedAt = Date.now();
    let progress: Progress = { activity: undefined, steps: 0, text: "" };

    const live = new api.LiveMessage(
      quoting(
        chat,
        itemId,
        async (action) => await withOwner(contactId, generation, action)
      ),
      T.ChatType.Direct,
      contactId,
      LIVE_UPDATE_MS,
      (error) => {
        report(
          "phone",
          `Shrok could not update a live reply: ${String(error)}`
        );
      }
    );

    const show = (): void => {
      if (!closing && generation === ownerGeneration) {
        live.update(liveText(progress, startedAt));
      }
    };

    show();
    const ticker = setInterval(show, STATUS_TICK_MS);

    const cancel = (): void => {
      clearInterval(ticker);
      void live.end(DELETE_LIVE_MESSAGE);
    };

    liveReplies.add(cancel);

    const receivedAt = new Date(item.meta.createdAt);
    const sentAt = new Date(item.meta.itemTs);

    try {
      const content =
        item.content.type === "rcvMsgContent"
          ? item.content.msgContent
          : undefined;

      const text =
        question ??
        (content === undefined ? "" : await messageText(item, content));

      // Start under the owner lock, but never hold pairing up for the model's answer.
      const answering = await withOwner(contactId, generation, async () => {
        await approvals.skipBefore(receivedAt);

        return {
          result: answer(text, `simplex:${itemId}`, sentAt, (next) => {
            progress = next;
            show();
          }),
        };
      });

      const answered = await answering.result;

      clearInterval(ticker);

      if (!closing && generation === ownerGeneration) {
        await live.end(answered);
      }
    } catch (error) {
      clearInterval(ticker);

      if (!closing && generation === ownerGeneration) {
        await live.end(
          `I hit an error and stopped: ${error instanceof Error ? error.message : String(error)}\n\nSend it again to retry.`
        );
      }

      report(
        "phone",
        `Shrok could not answer message ${itemId}: ${String(error)}`
      );
    } finally {
      clearInterval(ticker);
      liveReplies.delete(cancel);
    }
  };

  const reply = async (contactId: number, item: T.ChatItem): Promise<void> => {
    const { itemId } = item.meta;

    if (
      inFlight.has(itemId) ||
      item.content.type !== "rcvMsgContent" ||
      !isAnswered(item)
    ) {
      return;
    }

    inFlight.add(itemId);

    try {
      const chat = await ready.promise;
      const content = item.content.msgContent;

      const generation = ownerGeneration;

      const routed = await withOwner(contactId, generation, async () =>
        content.type === "text"
          ? await route(contactId, item, content.text)
          : BRAIN
      );

      if (routed.kind === "brain") {
        await think(chat, contactId, item, routed.question, generation);
      }
    } catch (error) {
      report(
        "phone",
        `Shrok could not handle message ${itemId}: ${String(error)}`
      );
    } finally {
      inFlight.delete(itemId);
    }
  };

  const onReaction = async (event: {
    added: boolean;
    reaction: T.ACIReaction;
    user: T.User;
  }): Promise<void> => {
    const receivedAt = Date.now();
    await ready.promise;
    const { chatInfo, chatReaction } = event.reaction;

    if (
      !event.added ||
      event.user.userId !== (await activeUser.promise) ||
      chatInfo.type !== "direct" ||
      chatInfo.contact.contactId !== (await currentOwnerId()) ||
      chatReaction.chatDir.type !== "directRcv" ||
      chatReaction.reaction.type !== "emoji"
    ) {
      return;
    }

    const { emoji } = chatReaction.reaction;

    const approvalOwner = {
      contactId: chatInfo.contact.contactId,
      userId: event.user.userId,
    };

    if (emoji !== APPROVE && emoji !== DECLINE) {
      return;
    }

    const id = approvals.requestIn(
      chatReaction.chatItem.meta.itemId,
      approvalOwner
    );

    if (id === undefined) {
      if (isApprovalRequestText(util.ciContentText(chatReaction.chatItem))) {
        await say(
          approvalOwner.contactId,
          chatReaction.chatItem.meta.itemId,
          REQUEST_UNAVAILABLE
        );
      }

      return;
    }

    const decision = approvals.decide(
      id,
      emoji === APPROVE,
      approvalOwner,
      receivedAt
    );

    if (decision !== "decided") {
      await say(
        approvalOwner.contactId,
        chatReaction.chatItem.meta.itemId,
        UNDECIDED[decision]
      );
    }
  };

  const [chat, user] = await bot.run({
    dbOpts: {
      filePrefix: path.join(dataDir, "simplex", "shrok"),
      type: "sqlite",
    },
    events: {
      chatItemReaction: async (event) => {
        await withOwnerLock(async () => {
          await onReaction(event);
        });
      },
      contactConnected: async ({ contact }) => {
        await claimOwner(contact);
      },
      rcvFileComplete: ({ chatItem: { chatItem } }) => {
        if (chatItem.file !== undefined) {
          const done = transfers.get(chatItem.file.fileId);
          transfers.delete(chatItem.file.fileId);
          done?.resolve(chatItem.file);
        }
      },
      rcvFileError: ({ agentError, rcvFileTransfer }) => {
        const done = transfers.get(rcvFileTransfer.fileId);
        transfers.delete(rcvFileTransfer.fileId);
        done?.reject(
          new Error(`the transfer failed: ${JSON.stringify(agentError)}`)
        );
      },
    },
    onMessage: async ({ chatInfo, chatItem }) => {
      if (chatInfo.type !== "direct") {
        return;
      }

      if (
        await withOwnerLock(
          async () => chatInfo.contact.contactId === (await currentOwnerId())
        )
      ) {
        // Not awaited: SimpleX delivers events one at a time, and an answer can take minutes.
        void reply(chatInfo.contact.contactId, chatItem);
      }
    },
    options: {
      allowFiles: true,
      commands: COMMANDS,
      createAddress: false,
      logContacts: false,
    },
    profile: shrokProfile(),
  });

  activeUser.resolve(user.userId);
  ready.resolve(chat);

  const contacts = await chat.apiListContacts(user.userId);
  const owner = contacts.find(isOwner);

  await deleteStaleInvites(chat, user.userId);

  if (owner) {
    await deleteLeftoverLiveReplies(chat, owner.contactId);

    for (const item of unanswered(
      await recentItems(chat, owner.contactId, CATCH_UP_ITEMS)
    )) {
      void reply(owner.contactId, item);
    }
  }

  const hasOwner = async (): Promise<boolean> =>
    await withOwnerLock(async () => {
      const listed = await chat.apiListContacts(user.userId);

      return listed.some(isOwner);
    });

  const invite = async (replace: boolean): Promise<Invite> =>
    await withOwnerLock(async () => {
      if (pending !== undefined) {
        throw new Error(
          "Another shrok pair is waiting for a phone. Finish or stop that one first."
        );
      }

      const listed = await chat.apiListContacts(user.userId);

      if (closing || (!replace && listed.some(isOwner))) {
        throw new Error(
          "Shrok already has an owner. To pair a different phone, run shrok pair --replace."
        );
      }

      const created = await chat.sendChatCmd(
        CC.APIAddContact.cmdString({ incognito: false, userId: user.userId })
      );

      if (created.type !== "invitation") {
        throw new Error(`SimpleX answered ${created.type} to making an invite`);
      }

      const connId = created.connection.pccConnId;
      const paired = Promise.withResolvers<number>();
      void paired.promise.catch(() => {
        // The control socket observes pairing failure once it has the invite.
      });

      pending = { connId, paired, replace };

      return {
        cancel: async () => {
          await withOwnerLock(async () => {
            if (pending?.connId !== connId) {
              return;
            }

            await deleteConnection(chat, connId);
            pending = undefined;
          });
        },
        link:
          created.connLinkInvitation.connShortLink ??
          created.connLinkInvitation.connFullLink,
        paired: paired.promise,
      };
    });

  const ownerId = async (): Promise<number> => {
    const ownerNow = await currentOwnerId();

    if (ownerNow === undefined) {
      throw new Error("Shrok has no owner to message yet.");
    }

    return ownerNow;
  };

  return {
    approvalPhone: {
      deliver: async (recipient, file, caption, signal, sent) => {
        if (
          recipient.userId !== user.userId ||
          recipient.contactId !== (await ownerId())
        ) {
          throw new Error("The approval owner changed before delivery.");
        }

        return await deliverApproval(
          chat,
          recipient,
          file,
          caption,
          signal,
          sent
        );
      },
      editCaption: async (recipient, itemId, text) => {
        if (
          recipient.userId !== user.userId ||
          recipient.contactId !== (await ownerId())
        ) {
          throw new Error(
            "The approval owner changed before updating its message."
          );
        }

        await chat.apiUpdateChatItem(
          T.ChatType.Direct,
          recipient.contactId,
          itemId,
          { text, type: "file" },
          false
        );
      },
      owner: async () => ({ contactId: await ownerId(), userId: user.userId }),
    },
    close: async () => {
      closing = true;

      for (const cancel of liveReplies) {
        cancel();
      }

      liveReplies.clear();

      for (const done of transfers.values()) {
        done.reject(
          new Error("The phone closed before the transfer finished.")
        );
      }

      transfers.clear();
      await chat.close();
    },
    hasOwner,
    invite,
    send: async (text, since) => {
      const contactId = await ownerId();

      const recent =
        since === undefined
          ? []
          : await recentItems(chat, contactId, CATCH_UP_ITEMS);

      const earlier =
        since === undefined
          ? undefined
          : recent.find((item) => sentSince(item, text, since));

      if (earlier !== undefined) {
        return earlier.meta.itemId;
      }

      const [sent] = await chat.apiSendTextMessage(
        [T.ChatType.Direct, contactId],
        text
      );

      return sent?.chatItem.meta.itemId;
    },
    sendFile: async (file, caption) => {
      const preview = IMAGE_FILE.test(file)
        ? await imagePreview(file)
        : undefined;

      const msgContent: T.MsgContent =
        preview === undefined
          ? { text: caption, type: "file" }
          : { image: preview, text: caption, type: "image" };

      await chat.apiSendMessages(
        [T.ChatType.Direct, await ownerId()],
        [{ fileSource: { filePath: file }, mentions: {}, msgContent }]
      );
    },
  };
};
