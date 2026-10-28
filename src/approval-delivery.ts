import path from "node:path";

import { T } from "@simplex-chat/types";
import type { ChatEvent } from "@simplex-chat/types";
import type { api } from "simplex-chat";

import type {
  ApprovalDelivery,
  ApprovalOwner,
  ApprovalMessage,
} from "./tools/approvals.ts";

interface Observed extends ApprovalMessage {
  uploadedAt?: number;
  deliveredAt?: number;
}

const deliveryFailed = ({ file, meta }: T.ChatItem): boolean => {
  const status = meta.itemStatus;
  const fileStatus = file?.fileStatus.type;

  return (
    meta.itemDeleted !== undefined ||
    file?.fileProtocol === T.FileProtocol.LOCAL ||
    status.type === "sndError" ||
    status.type === "sndErrorAuth" ||
    status.type === "sndWarning" ||
    fileStatus === "sndError" ||
    fileStatus === "sndWarning" ||
    fileStatus === "sndCancelled" ||
    (status.type === "sndRcvd" &&
      status.msgRcptStatus !== T.MsgReceiptStatus.Ok)
  );
};

// Subscribe before sending: SimpleX can emit completion events before apiSendMessages returns.
export const deliverApproval = async (
  chat: api.ChatApi,
  owner: ApprovalOwner,
  file: string,
  caption: string,
  signal: AbortSignal,
  sent: (message: ApprovalMessage) => void
): Promise<ApprovalDelivery> => {
  signal.throwIfAborted();

  const done = Promise.withResolvers<ApprovalDelivery>();
  let expected: ApprovalMessage | undefined;
  let observed: Observed | undefined;

  const complete = (): void => {
    if (
      expected !== undefined &&
      observed?.itemId === expected.itemId &&
      observed.fileId === expected.fileId &&
      observed.uploadedAt !== undefined &&
      observed.deliveredAt !== undefined
    ) {
      done.resolve({
        ...expected,
        deliveredAt: observed.deliveredAt,
        uploadedAt: observed.uploadedAt,
      });
    }
  };

  const messageOf = ({
    chatInfo,
    chatItem,
  }: T.AChatItem): ApprovalMessage | undefined => {
    if (
      chatInfo.type !== "direct" ||
      chatInfo.contact.contactId !== owner.contactId ||
      chatItem.chatDir.type !== "directSnd" ||
      chatItem.file?.fileName !== path.basename(file)
    ) {
      return undefined;
    }

    return { fileId: chatItem.file.fileId, itemId: chatItem.meta.itemId };
  };

  const observe = (item: T.AChatItem, uploaded = false): void => {
    const message = messageOf(item);

    if (message === undefined) {
      return;
    }

    if (
      (expected !== undefined &&
        (expected.itemId !== message.itemId ||
          expected.fileId !== message.fileId)) ||
      (observed !== undefined &&
        (observed.itemId !== message.itemId ||
          observed.fileId !== message.fileId))
    ) {
      done.reject(
        new Error("The approval attachment identity changed during delivery.")
      );

      return;
    }

    observed ??= message;
    const status = item.chatItem.meta.itemStatus;
    const fileStatus = item.chatItem.file?.fileStatus.type;

    if (deliveryFailed(item.chatItem)) {
      done.reject(
        new Error("The complete approval attachment could not be delivered.")
      );

      return;
    }

    if (uploaded || fileStatus === "sndComplete") {
      observed.uploadedAt ??= Date.now();
    }

    if (
      status.type === "sndRcvd" &&
      status.msgRcptStatus === T.MsgReceiptStatus.Ok &&
      status.sndProgress === T.SndCIStatusProgress.Complete
    ) {
      observed.deliveredAt ??= Date.now();
    }

    complete();
  };

  const onEvent = (event: ChatEvent): void => {
    if (!("user" in event) || event.user.userId !== owner.userId) {
      return;
    }

    if (
      event.type === "newChatItems" ||
      event.type === "chatItemsStatusesUpdated"
    ) {
      for (const item of event.chatItems) {
        observe(item);
      }
    } else if (event.type === "chatItemUpdated") {
      observe(event.chatItem);
    } else if (event.type === "sndFileCompleteXFTP") {
      if (
        event.fileTransferMeta.filePath === file &&
        event.fileTransferMeta.fileId === event.chatItem.chatItem.file?.fileId
      ) {
        observe(event.chatItem, true);
      }
    } else if (
      event.type === "sndFileError" ||
      event.type === "sndFileWarning"
    ) {
      if (event.fileTransferMeta.filePath === file) {
        done.reject(new Error("Approval attachment upload failed."));
      }
    } else if (event.type === "chatItemsDeleted") {
      for (const { deletedChatItem } of event.chatItemDeletions) {
        if (messageOf(deletedChatItem) !== undefined) {
          done.reject(
            new Error(
              "The approval attachment message was deleted during delivery."
            )
          );
        }
      }
    }
  };

  const abort = (): void => {
    done.reject(new Error("Approval attachment delivery was cancelled."));
  };

  chat.onAny(onEvent);
  signal.addEventListener("abort", abort, { once: true });

  const send = async (): Promise<ApprovalDelivery> => {
    signal.throwIfAborted();

    const [item] = await chat.apiSendMessages(
      [T.ChatType.Direct, owner.contactId],
      [
        {
          fileSource: { filePath: file },
          mentions: {},
          msgContent: { text: caption, type: "file" },
        },
      ]
    );

    signal.throwIfAborted();

    expected = item === undefined ? undefined : messageOf(item);

    if (item === undefined || expected === undefined) {
      throw new Error(
        "SimpleX did not return the approval attachment's message identity."
      );
    }

    sent(expected);
    observe(item);
    complete();

    return await done.promise;
  };

  try {
    return await Promise.race([send(), done.promise]);
  } finally {
    chat.offAny(onEvent);
    signal.removeEventListener("abort", abort);
  }
};
