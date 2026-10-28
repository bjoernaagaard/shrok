import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { isLoopbackName } from "@anthropic-ai/sandbox-runtime/dist/sandbox/address.js";
import { createHttpProxyServer } from "@anthropic-ai/sandbox-runtime/dist/sandbox/http-proxy.js";
import { canonicalizeHost } from "@anthropic-ai/sandbox-runtime/dist/sandbox/parent-proxy.js";
import {
  createResolvedAddressGuard,
  isResolvedAddressDenied,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/resolved-address-guard.js";
import { whichSync } from "@anthropic-ai/sandbox-runtime/dist/utils/which.js";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { report } from "../events.ts";
import { PROJECT_BIN, safeEnv } from "./sandbox.ts";

/**
 * Address space that is not the public internet and that the sandbox runtime's guard leaves to us. The guard
 * itself already refuses loopback, unspecified, link-local, multicast, broadcast, the cloud metadata endpoints
 * and every address of this host's own interfaces.
 */
const NON_PUBLIC = [
  "10.0.0.0/8",
  "100.64.0.0/10",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "240.0.0.0/4",
  "2001:db8::/32",
  "64:ff9b:1::/48",
  "fc00::/7",
  "fec0::/10",
];

/** A name that resolves nowhere: asking the guard whether it may resolve to an address judges that address. */
const ANY_NAME = "public-web.invalid";

const SRT = path.join(PROJECT_BIN, "srt");
const PROXY_AUTH_TOKEN_BYTES = 32;

/**
 * Where a sandboxed command reaches Shrok's proxy. macOS's sandbox shares this host's loopback. Linux's has its
 * own network, where srt relays the proxy at its fixed port 3128. It is named by IP because Obscura refuses a
 * proxy called `localhost`, which resolves to ::1.
 */
const sandboxProxy = (port: number, token: string): string =>
  `http://srt:${token}@127.0.0.1:${process.platform === "linux" ? 3128 : port}`;

/**
 * Obscura follows the standard proxy variables, which srt sets to `localhost` inside the sandbox. This shell step
 * points them at `SHROK_WEB_PROXY` before Obscura starts, so the credential stays out of every command line.
 */
const WITH_WEB_PROXY = [
  'p="$SHROK_WEB_PROXY"',
  'HTTP_PROXY="$p" HTTPS_PROXY="$p" ALL_PROXY="$p" http_proxy="$p" https_proxy="$p" all_proxy="$p" exec "$0" "$@"',
].join("; ");

const refuse = (host: string, port: number, reason: string): void => {
  report("public-web", `Refused ${host}:${port}: ${reason}`);
};

const ListeningAddress = Type.Object({ port: Type.Number() });

export interface PublicWeb {
  readonly proxy: {
    readonly server: string;
    readonly username: string;
    readonly password: string;
  };
  readonly fetchArgs: (url: string) => { argv: string[]; done: () => void };
  readonly fetchEnv: Record<string, string>;
  readonly close: () => Promise<void>;
}

export const publicUrl = (url: string): string => {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${url} is not a web address.`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Only public http and https pages can be opened, not ${parsed.protocol} addresses.`
    );
  }

  return parsed.href;
};

export const openPublicWeb = async (dataDir: string): Promise<PublicWeb> => {
  const guard = createResolvedAddressGuard({
    deniedResolvedAddresses: NON_PUBLIC,
  });

  /* oxlint-disable promise/prefer-await-to-callbacks -- a net.LookupFunction is Node's callback API */
  const lookupFor = (port: number): LookupFunction => {
    const lookup = guard.lookupFor(port);

    return (hostname, options, callback) => {
      lookup(hostname, options, (error, address, family) => {
        if (isResolvedAddressDenied(error)) {
          refuse(hostname, port, error.reason);
        }

        callback(error, address, family);
      });
    };
  };
  /* oxlint-enable promise/prefer-await-to-callbacks */

  const proxyAuthToken = randomBytes(PROXY_AUTH_TOKEN_BYTES).toString("hex");

  const server = createHttpProxyServer({
    // An IP literal is judged here, as the guard never judges one. `localhost` is refused by name, as the guard
    // lets it resolve to loopback.
    filter: (port, host, _socket, _command, explain) => {
      const canonical = canonicalizeHost(host);

      const allowed =
        canonical !== undefined &&
        !isLoopbackName(canonical) &&
        (isIP(canonical) === 0 || guard.permits(ANY_NAME, canonical, port));

      if (!allowed) {
        refuse(host, port, "not a public internet address");
        explain?.("not a public internet address");
      }

      return allowed;
    },
    lookupFor,
    proxyAuthToken,
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  server.unref();

  const address = Value.Parse(ListeningAddress, server.address());

  const installed = whichSync("obscura");

  if (installed === null) {
    throw new Error("Obscura is not installed, so web_fetch cannot run.");
  }

  // Run by its real path: a symlink on the way, such as mise's `latest`, may lie in the unreadable home.
  const obscura = realpathSync(installed);

  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "shrok-web-")));
  const settings = path.join(scratch, "srt.json");
  const proxy = `http://127.0.0.1:${address.port}`;

  writeFileSync(
    settings,
    JSON.stringify({
      filesystem: {
        allowRead: [path.dirname(obscura)],
        allowWrite: [scratch],
        denyRead: [homedir(), realpathSync(dataDir)],
        denyWrite: [],
      },
      network: {
        allowedDomains: [],
        deniedDomains: [],
        httpProxyPort: address.port,
        socksProxyPort: address.port,
      },
    })
  );

  return {
    close: async () => {
      const closed = once(server, "close");

      server.close();
      server.closeAllConnections();
      await closed;
      rmSync(scratch, { force: true, recursive: true });
    },
    fetchArgs: (url) => {
      const storage = mkdtempSync(path.join(scratch, "fetch-"));

      return {
        argv: [
          SRT,
          "--settings",
          settings,
          "--",
          "/bin/sh",
          "-c",
          WITH_WEB_PROXY,
          obscura,
          "fetch",
          "--storage-dir",
          storage,
          "--dump",
          "markdown",
          publicUrl(url),
        ],
        done: () => {
          rmSync(storage, { force: true, recursive: true });
        },
      };
    },
    fetchEnv: {
      ...safeEnv(),
      // Keep the credential out of command arguments and pass it through the sandbox's byte relay.
      SHROK_WEB_PROXY: sandboxProxy(address.port, proxyAuthToken),
      TMPDIR: scratch,
    },
    proxy: { password: proxyAuthToken, server: proxy, username: "srt" },
  };
};
