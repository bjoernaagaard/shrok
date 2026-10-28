import { lstatSync, mkdirSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

import {
  getDefaultWritePaths,
  SandboxManager,
} from "@anthropic-ai/sandbox-runtime";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createBashTool } from "@earendil-works/pi-durable/tools";

import { FLOWS_FOLDER } from "../flows.ts";
import { ITEMS_FOLDER } from "../items.ts";
import { importedSecretPaths, isImportedSecret } from "../secrets.ts";

const PROJECT_MODULES = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "node_modules"
);

export const PROJECT_BIN = path.join(PROJECT_MODULES, ".bin");

// The Node that runs Shrok comes first on PATH, as node_modules/.bin scripts start with #!/usr/bin/env node.
const NODE_BIN = path.dirname(process.execPath);
const NODE_PREFIX = path.dirname(NODE_BIN);

const SECRET_DIRS = [
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  "~/.xurl",
  "~/.config/gws",
  "~/.config/secretspec",
  "~/.config/gh",
  "~/.docker",
  "~/.netrc",
  "~/.npmrc",
  "~/Library/Keychains",
  "~/Library/Cookies",
  "~/Library/Application Support/Google/Chrome",
  "~/Library/Application Support/Firefox",
  "~/Library/Safari",
  "~/.config/google-chrome",
  "~/.config/chromium",
  "~/.mozilla",
  "~/.local/share/keyrings",
  "~/.password-store",
  "~/.kube",
  "~/.config/gcloud",
  "/run/secrets",
  "/run/credentials",
];

const SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "USER",
  "SHELL",
];

const expandHome = (target: string): string =>
  target === "~" || target.startsWith("~/")
    ? path.join(homedir(), target.slice(2))
    : target;

const MAX_SYMLINK_HOPS = 40;

const linkTarget = (target: string): string | undefined => {
  try {
    return lstatSync(target).isSymbolicLink()
      ? path.resolve(path.dirname(target), readlinkSync(target))
      : undefined;
  } catch {
    return undefined;
  }
};

const realPathEvenIfMissing = (target: string, links = 0): string => {
  const resolved = path.resolve(target);

  try {
    // The native call returns the stored letter case, so a case variant cannot
    // pass for a different folder on a case-insensitive volume.
    return realpathSync.native(resolved);
  } catch {
    const parent = path.dirname(resolved);

    if (parent === resolved) {
      return resolved;
    }

    const here = path.join(
      realPathEvenIfMissing(parent, links),
      path.basename(resolved)
    );

    const next = links < MAX_SYMLINK_HOPS ? linkTarget(here) : undefined;

    return next === undefined ? here : realPathEvenIfMissing(next, links + 1);
  }
};

export const isInside = (target: string, folder: string): boolean => {
  const relative = path.relative(
    realPathEvenIfMissing(folder),
    realPathEvenIfMissing(target)
  );

  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

export const isSecret = (target: string): boolean =>
  isImportedSecret(target) ||
  SECRET_DIRS.some((secret) => isInside(target, expandHome(secret)));

export const isShrokRecord = (
  target: string,
  dataDir: string,
  workspace: string
): boolean => isInside(target, dataDir) && !isInside(target, workspace);

export const safeEnv = () => {
  const env: Record<string, string> = {};

  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];

    if (value !== undefined) {
      env[key] = value;
    }
  }

  env.PATH = [PROJECT_BIN, NODE_BIN, env.PATH]
    .filter(Boolean)
    .join(path.delimiter);

  return env;
};

// Version managers such as mise, asdf and pyenv put shims in a "shims" folder. A shim reads the manager's
// settings in the home folder, which the sandbox denies, so bash uses the real install folders after it.
const sandboxPath = (): string =>
  (safeEnv().PATH ?? "")
    .split(path.delimiter)
    .filter(
      (folder) =>
        path.isAbsolute(folder) &&
        path.basename(folder) !== "shims" &&
        !isSecret(folder)
    )
    .join(path.delimiter);

/**
 * Starts the read-only sandbox every bash command runs in. File tools handle bounded workspace writes.
 * Commands may not read the home folder outside the workspace, credentials, the rest of `dataDir`, or the network.
 */
export const startSandbox = async (
  dataDir: string,
  workspace: string
): Promise<void> => {
  if (!SandboxManager.isSupportedPlatform()) {
    throw new Error(
      "The bash sandbox does not support this system, so Shrok will not start without it."
    );
  }

  const dependencies = await SandboxManager.checkDependenciesAsync();

  if (dependencies.errors.length > 0 || dependencies.warnings.length > 0) {
    throw new Error(
      `The sandbox cannot establish all required boundaries: ${[...dependencies.errors, ...dependencies.warnings].join("; ")}${process.platform === "linux" ? ". On Ubuntu 24.04 and later, AppArmor blocks bubblewrap's user namespaces until Shrok's profiles are loaded: sudo apparmor_parser -r /opt/shrok/share/apparmor/*" : ""}`
    );
  }

  const guarded = [ITEMS_FOLDER, FLOWS_FOLDER, "skills"].map((folder) => {
    const dir = path.join(workspace, folder);

    mkdirSync(dir, { recursive: true });

    return realPathEvenIfMissing(dir);
  });

  const config: SandboxRuntimeConfig = {
    allowAppleEvents: false,
    allowNestedUserNamespaces: false,
    credentials: {
      // Credential denies have no allowRead exceptions, including inside the workspace.
      files: importedSecretPaths().map((source) => ({
        mode: "deny",
        path: source,
      })),
    },
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    filesystem: {
      // allowRead wins over denyRead, so these stay readable inside the denied home and data folders.
      // A credential list can never name every file a program keeps in the home folder, so deny all of it.
      // Folders on PATH hold programs, such as those mise installs under the home folder.
      allowRead: [
        workspace,
        PROJECT_MODULES,
        NODE_PREFIX,
        ...sandboxPath().split(path.delimiter),
      ].map((folder) => realPathEvenIfMissing(folder)),
      allowWrite: [],
      denyRead: [
        ...SECRET_DIRS,
        realPathEvenIfMissing(homedir()),
        realPathEvenIfMissing(dataDir),
      ],
      // The runtime adds implicit writable temp and home directories even with allowWrite: [].
      // Keep device-backed stdio, but deny every implicit on-disk write root.
      denyWrite: [
        ...guarded,
        ...getDefaultWritePaths().filter(
          (target) => !target.startsWith("/dev/")
        ),
      ],
    },
    network: {
      allowAllUnixSockets: false,
      allowLocalBinding: false,
      allowMachLookup: [],
      allowUnixSockets: [],
      allowedDomains: [],
      deniedDomains: [],
      strictAllowlist: true,
    },
  };

  await SandboxManager.initialize(config);
};

export const stopSandbox = async (): Promise<void> => {
  await SandboxManager.reset();
};

const MAX_BASH_SECONDS = 30;
const MAX_BASH_OUTPUT_BYTES = 256 * 1024;

// The dependency grants credential-service lookups even with allowMachLookup: [].
// Harden its generated profile at the call boundary. A second sandbox-exec cannot be nested on macOS.
const hardenMacosCommand = (command: string): string => {
  const securityGrant =
    '(allow mach-lookup (global-name "com.apple.SecurityServer"))';

  if (!command.includes(securityGrant)) {
    throw new Error(
      "The sandbox profile cannot establish credential-service isolation."
    );
  }

  // This rule follows the built-in securityd grant. It contains no shell quoting characters.
  // Replace only the first occurrence, inside the generated profile, never the model's command.
  return command.replace(securityGrant, "(deny mach-lookup)");
};

class BoundedBashEnv extends NodeExecutionEnv {
  override async exec(
    ...[command, options, context]: Parameters<NodeExecutionEnv["exec"]>
  ) {
    let bytes = 0;

    return await super.exec(
      command,
      {
        ...options,
        onOutput: (chunk, outputContext, info) => {
          bytes += Buffer.byteLength(chunk);

          if (bytes > MAX_BASH_OUTPUT_BYTES) {
            // NodeExecutionEnv kills the command's process group on a callback error.
            throw new Error(
              "The command exceeded its total output byte budget."
            );
          }

          options?.onOutput?.(chunk, outputContext, info);
        },
        // Never create an unbounded full-output spill file, including on failed calls.
        spill: undefined,
        timeout: Math.min(
          options?.timeout ?? MAX_BASH_SECONDS,
          MAX_BASH_SECONDS
        ),
        window: undefined,
      },
      context
    );
  }
}

export const createSandboxedBash = (workspace: string) => {
  const env = new BoundedBashEnv({ cwd: workspace });

  const tool = createBashTool({
    prepare: async (execution) => {
      execution.cwd = workspace;
      // Programs look for their settings in HOME, which the sandbox denies, so point it at the workspace.
      execution.env = { ...safeEnv(), HOME: workspace, PATH: sandboxPath() };
      execution.inheritEnv = false;
      const wrapped = await SandboxManager.wrapWithSandbox(execution.command);

      execution.command =
        process.platform === "darwin" ? hardenMacosCommand(wrapped) : wrapped;
    },
  });

  return {
    ...tool,
    description:
      "Run a read-only, offline bash command that can read the workspace but not the rest of the home folder. Commands have a mandatory deadline and total output byte budget. Output is never spilled to disk. Use write or edit to change workspace files.",
    execute: async (...[args, api, context]: Parameters<typeof tool.execute>) =>
      await tool.execute(
        {
          ...args,
          timeout: Math.min(args.timeout ?? MAX_BASH_SECONDS, MAX_BASH_SECONDS),
        },
        { ...api, env },
        context
      ),
  };
};
