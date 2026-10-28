import { once } from "node:events";
import { rmSync } from "node:fs";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { record } from "./events.ts";
import type { Phone } from "./phone.ts";

const SOCKET_FILE = "control.sock";

/** The longest socket path the kernel takes: sun_path holds 104 bytes on macOS and 108 on Linux, with a NUL. */
const MAX_SOCKET_PATH = process.platform === "darwin" ? 103 : 107;
const INVITE_LIFETIME_MS = 15 * 60 * 1000;

const PairRequest = Type.Object({
  replace: Type.Boolean(),
  type: Type.Literal("pair"),
});

export const PairReply = Type.Union([
  Type.Object({ link: Type.String(), type: Type.Literal("invite") }),
  Type.Object({ type: Type.Literal("paired") }),
  Type.Object({ type: Type.Literal("expired") }),
  Type.Object({ message: Type.String(), type: Type.Literal("error") }),
]);

type Reply = Static<typeof PairReply>;

/** The socket `shrok pair` talks to. It sits in the data folder, so only Shrok's own user can open it. */
export const controlSocket = (dataDir: string): string =>
  path.join(dataDir, SOCKET_FILE);

/** Fails at startup, before SimpleX starts, when the socket's path would be too long for the kernel. */
export const checkControlSocket = (dataDir: string): void => {
  const file = controlSocket(dataDir);

  if (Buffer.byteLength(file) > MAX_SOCKET_PATH) {
    throw new Error(
      `The data folder ${dataDir} has too long a path for shrok pair's socket, which may be ${MAX_SOCKET_PATH} bytes. Set SHROK_DATA_DIR to a shorter path.`
    );
  }
};

const send = (socket: Socket, reply: Reply): void => {
  socket.write(`${JSON.stringify(reply)}\n`);
};

/** Leaving a \`for await\` early would destroy the socket, so the request line is read with events. */
const firstLine = async (socket: Socket): Promise<string | undefined> => {
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  let buffered = "";

  const onData = (chunk: Buffer): void => {
    buffered += chunk.toString();

    const end = buffered.indexOf("\n");

    if (end !== -1) {
      socket.off("data", onData);
      resolve(buffered.slice(0, end));
    }
  };

  socket.on("data", onData);
  socket.once("close", () => {
    resolve(undefined);
  });

  return await promise;
};

const pair = async (socket: Socket, phone: Phone): Promise<void> => {
  const line = await firstLine(socket);
  const request: unknown = line === undefined ? undefined : JSON.parse(line);

  if (!Value.Check(PairRequest, request)) {
    send(socket, { message: "Unknown request.", type: "error" });

    return;
  }

  const invite = await phone.invite(request.replace);
  const closed = once(socket, "close").then(() => "closed" as const);

  const expired = sleep(INVITE_LIFETIME_MS, "expired" as const, { ref: false });

  send(socket, { link: invite.link, type: "invite" });
  record("pair", "Made a one-time invite for shrok pair.");

  const outcome = await Promise.race([
    invite.paired.then(() => "paired" as const),
    closed,
    expired,
  ]);

  if (outcome === "paired") {
    record("pair", "A phone paired through shrok pair.");
    send(socket, { type: "paired" });

    return;
  }

  await invite.cancel();
  record("pair", `Deleted the unused invite: shrok pair ${outcome}.`);

  if (outcome === "expired") {
    send(socket, { type: "expired" });
  }
};

/** Serves `shrok pair` and resolves to a function that stops serving. */
export const serveControl = async (
  dataDir: string,
  phone: Phone
): Promise<() => Promise<void>> => {
  const file = controlSocket(dataDir);
  const sockets = new Set<Socket>();

  // A socket left by a crash. The data folder's lock means no running Shrok owns it.
  rmSync(file, { force: true });

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
    socket.on("error", () => {
      socket.destroy();
    });

    void (async () => {
      try {
        await pair(socket, phone);
      } catch (error) {
        send(socket, {
          message: error instanceof Error ? error.message : String(error),
          type: "error",
        });
      } finally {
        socket.end();
      }
    })();
  });

  server.listen(file);
  await once(server, "listening");

  return async () => {
    const closed = once(server, "close");

    server.close();

    for (const socket of sockets) {
      socket.destroy();
    }

    await closed;
    rmSync(file, { force: true });
  };
};
