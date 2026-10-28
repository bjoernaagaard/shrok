type Share =
  | {
      readonly kind: "link";
      readonly url: string;
      readonly title: string;
      readonly preview: string;
      readonly text: string;
    }
  | {
      readonly kind: "file" | "image";
      readonly workspacePath: string;
      readonly name: string;
      readonly bytes: number;
      readonly text: string;
    }
  | {
      readonly kind: "lost";
      readonly name: string;
      readonly reason: string;
      readonly text: string;
    };

const KILOBYTE = 1024;

const message = (text: string): string[] =>
  text.trim() === "" ? [] : [`Message: ${text.trim()}`];

/** The text the brain receives for a share. Its first line always starts with `[Shared <kind>]`. */
export const shareMessage = (share: Share): string => {
  if (share.kind === "link") {
    const lines = [`[Shared link] ${share.url}`];

    if (share.title !== "") {
      lines.push(`Title: ${share.title}`);
    }

    if (share.preview !== "") {
      lines.push(`Preview: ${share.preview}`);
    }

    const extra = share.text.replace(share.url, "");

    return [...lines, ...message(extra)].join("\n");
  }

  if (share.kind === "lost") {
    return [
      `[Shared file] ${share.name} could not be received: ${share.reason}`,
      ...message(share.text),
    ].join("\n");
  }

  const size = Math.max(1, Math.round(share.bytes / KILOBYTE));

  return [
    `[Shared ${share.kind}] ${share.workspacePath} (${share.name}, ${size} KB)`,
    ...message(share.text),
  ].join("\n");
};
