import { randomUUID } from "node:crypto";
import { lstatSync, opendirSync, realpathSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

import type { Context } from "@earendil-works/chord";
import { ok } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

import { isInside, isSecret } from "./sandbox.ts";

const MAX_WORKSPACE_BYTES = 256 * 1024 * 1024;
const MAX_WORKSPACE_ENTRIES = 4096;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const ALLOCATION_BYTES = 4096;
const STAT_BLOCK_BYTES = 512;

const isMissing = (error: Error): boolean =>
  "code" in error && error.code === "ENOENT";

const workspaceUsage = (folder: string) => {
  let bytes = 0;
  let entries = 0;
  const pending = [folder];

  while (pending.length > 0) {
    const current = pending.pop();

    if (current === undefined) {
      break;
    }

    const directory = opendirSync(current);

    try {
      for (
        let entry = directory.readSync();
        entry !== null;
        entry = directory.readSync()
      ) {
        const target = path.join(current, entry.name);
        const info = lstatSync(target);

        entries += 1;
        bytes += Math.max(info.size, info.blocks * STAT_BLOCK_BYTES);

        if (entries > MAX_WORKSPACE_ENTRIES || bytes > MAX_WORKSPACE_BYTES) {
          throw new Error("The workspace storage budget is exhausted.");
        }

        if (info.isDirectory()) {
          pending.push(target);
        }
      }
    } finally {
      directory.closeSync();
    }
  }

  return { bytes, entries };
};

const missingParents = (target: string): number => {
  let folder = path.dirname(target);
  let count = 0;

  for (;;) {
    try {
      if (!lstatSync(folder).isDirectory()) {
        // Existing symlink parents are resolved and checked before use.
        realpathSync(folder);
      }

      return count;
    } catch (error) {
      if (!(error instanceof Error && isMissing(error))) {
        throw error;
      }

      count += 1;

      if (count > MAX_WORKSPACE_ENTRIES) {
        throw new Error("The file needs too many parent directories.", {
          cause: error,
        });
      }

      folder = path.dirname(folder);
    }
  }
};

const rejectLinkedFile = (target: string): void => {
  try {
    const info = lstatSync(target);

    if (!info.isFile() || info.nlink !== 1) {
      throw new Error("File changes require a regular file with one link.");
    }

    if (info.size > MAX_FILE_BYTES) {
      throw new Error("The file exceeds the file tool byte budget.");
    }
  } catch (error) {
    if (!(error instanceof Error && isMissing(error))) {
      throw error;
    }
  }
};

/** Host-side file writes are serialized, quota-checked, and replace rather than mutate an inode. */
export const createWorkspaceFiles = (workspace: string) => {
  let pending: Promise<unknown> = Promise.resolve();

  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = pending;
    const gate = Promise.withResolvers<undefined>();

    pending = gate.promise;
    await previous;

    try {
      return await operation();
    } finally {
      gate.resolve(undefined);
    }
  };

  class WorkspaceEnv extends NodeExecutionEnv {
    override async readTextFile(file: string, context: Context) {
      rejectLinkedFile(path.resolve(workspace, file));

      return await super.readTextFile(file, context);
    }

    override async writeFile(
      file: string,
      content: string | Uint8Array,
      context: Context
    ): ReturnType<NodeExecutionEnv["writeFile"]> {
      const target = path.resolve(this.cwd, file);
      const size = Buffer.byteLength(content);

      context.abortSignal?.throwIfAborted();

      if (!isInside(target, workspace) || isSecret(target)) {
        throw new Error("File changes must stay in the non-secret workspace.");
      }

      rejectLinkedFile(target);

      if (size > MAX_FILE_BYTES) {
        throw new Error("The content exceeds the file tool byte budget.");
      }

      const usage = workspaceUsage(workspace);
      const parents = missingParents(target);

      const allocation = Math.max(
        ALLOCATION_BYTES,
        Math.ceil(size / ALLOCATION_BYTES) * ALLOCATION_BYTES
      );

      // Reserve the full temporary replacement as well as any new directories.
      if (
        usage.bytes + allocation + parents * ALLOCATION_BYTES >
          MAX_WORKSPACE_BYTES ||
        usage.entries + parents + 1 > MAX_WORKSPACE_ENTRIES
      ) {
        throw new Error("The write would exceed the workspace storage budget.");
      }

      await mkdir(path.dirname(target), { recursive: true });

      const parent = realpathSync(path.dirname(target));
      const destination = path.join(parent, path.basename(target));
      const temporary = path.join(parent, `.shrok-${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      let replaced = false;

      try {
        await handle.writeFile(content, { signal: context.abortSignal });
        await handle.close();
        context.abortSignal?.throwIfAborted();
        await rename(temporary, destination);
        replaced = true;
      } finally {
        await handle.close();

        if (!replaced) {
          await unlink(temporary);
        }
      }

      return ok(undefined);
    }
  }

  return { env: new WorkspaceEnv({ cwd: workspace }), run };
};
