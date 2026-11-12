import { mkdirSync } from "node:fs";
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

import { managedNames } from "../layout.ts";
import type { Layout } from "../layout.ts";
import {
  isSecret,
  NODE_PREFIX,
  PROJECT_MODULES,
  realPathEvenIfMissing,
  safeEnv,
  SECRET_DIRS,
} from "../paths.ts";
import { importedSecretPaths } from "../secrets.ts";
import type { ShrokTool } from "./policy.ts";

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
 * Starts the sandbox every bash command runs in. Commands may write in the workspace outside its managed folders,
 * and reach the public web through Shrok's proxy, which refuses private addresses. They may not read the home folder
 * outside the workspace, credentials, or the rest of the data folder.
 */
export const startSandbox = async (
  layout: Layout,
  proxyPort: number
): Promise<void> => {
  const { dataDir, workspace } = layout;

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

  const guarded = layout.managed.map(({ dir }) => {
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
      allowWrite: [realPathEvenIfMissing(workspace)],
      denyRead: [
        ...SECRET_DIRS,
        realPathEvenIfMissing(homedir()),
        realPathEvenIfMissing(dataDir),
      ],
      // The runtime adds implicit writable temp and home directories. Keep device-backed stdio, but deny every
      // implicit on-disk write root, so the workspace is the only place a command writes.
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
      // Shrok's own proxy decides: public addresses only. Both ports name it, so the runtime starts no proxy of its own.
      httpProxyPort: proxyPort,
      socksProxyPort: proxyPort,
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

export const createSandboxedBash = (layout: Layout) => {
  const { workspace } = layout;

  // The system's temp folder and the real home are outside what the sandbox lets commands write.
  mkdirSync(layout.bashHome, { recursive: true });
  mkdirSync(layout.bashTemp, { recursive: true });

  const env = new BoundedBashEnv({ cwd: workspace });

  const tool = createBashTool({
    prepare: async (execution) => {
      execution.cwd = workspace;
      // Programs look for their settings in HOME, which the sandbox denies, so point it inside the workspace.
      execution.env = {
        ...safeEnv(),
        HOME: layout.bashHome,
        PATH: sandboxPath(),
        TMPDIR: layout.bashTemp,
      };
      execution.inheritEnv = false;
      const wrapped = await SandboxManager.wrapWithSandbox(execution.command);

      execution.command =
        process.platform === "darwin" ? hardenMacosCommand(wrapped) : wrapped;
    },
  });

  return {
    phrase: "running a command",
    tool: {
      ...tool,
      description: `Run a bash command in the workspace. It can write there, except in the ${managedNames(layout)} folders, and reach public web addresses, but not the rest of the home folder or the private network. Commands have a mandatory deadline and total output byte budget. Output is never spilled to disk.`,
      execute: async (
        ...[args, api, context]: Parameters<typeof tool.execute>
      ) => await tool.execute(args, { ...api, env }, context),
    },
  } satisfies ShrokTool;
};
