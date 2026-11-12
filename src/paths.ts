import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

import { isImportedSecret } from "./secrets.ts";

export const PROJECT_MODULES = path.resolve(
  import.meta.dirname,
  "..",
  "node_modules"
);

export const PROJECT_BIN = path.join(PROJECT_MODULES, ".bin");

// The Node that runs Shrok comes first on PATH, as node_modules/.bin scripts start with #!/usr/bin/env node.
const NODE_BIN = path.dirname(process.execPath);
export const NODE_PREFIX = path.dirname(NODE_BIN);

export const SECRET_DIRS = [
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

/** `~` and `~/...` resolved against the home folder. */
export const expandHome = (target: string): string =>
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

export const realPathEvenIfMissing = (target: string, links = 0): string => {
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
