import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

/** The secrets in secretspec.toml. Other `_FILE` variables, such as HISTFILE, are not Shrok's to read. */
const SECRETS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "GOOGLE_WORKSPACE_CLI_CLIENT_ID",
  "GOOGLE_WORKSPACE_CLI_CLIENT_SECRET",
  "XURL_CLIENT_ID",
  "XURL_CLIENT_SECRET",
  "TYPESAFE_API_KEY",
] as const;

const TRAILING_NEWLINE = /\r?\n$/u;
const secretSources = new Set<string>();
const secretIdentities = new Set<string>();

export const importedSecretPaths = (): readonly string[] => [...secretSources];

export const isImportedSecret = (target: string): boolean => {
  if (secretSources.has(path.resolve(target))) {
    return true;
  }

  try {
    const info = statSync(target);

    return (
      secretSources.has(realpathSync(target)) ||
      secretIdentities.has(`${info.dev}:${info.ino}`)
    );
  } catch {
    return false;
  }
};

const readSecret = (file: string): string => {
  const canonical = realpathSync(file);
  const descriptor = openSync(canonical, "r");

  try {
    const info = fstatSync(descriptor);

    if (!info.isFile() || info.nlink !== 1) {
      throw new Error("A secret source must be a regular file with one link.");
    }

    const value = readFileSync(descriptor, "utf-8");

    secretSources.add(path.resolve(file));
    secretSources.add(canonical);
    secretIdentities.add(`${info.dev}:${info.ino}`);

    return value.replace(TRAILING_NEWLINE, "");
  } finally {
    closeSync(descriptor);
  }
};

/**
 * Reads each secret from a file into NAME: the file NAME_FILE names, as with Docker secrets, or else
 * $CREDENTIALS_DIRECTORY/NAME, where systemd puts the credentials it imports. One trailing newline is dropped.
 * Values are never printed.
 */
export const loadSecretFiles = (): void => {
  for (const name of SECRETS) {
    const key = `${name}_FILE`;
    const named = process.env[key];
    const credentials = process.env.CREDENTIALS_DIRECTORY;

    const imported =
      credentials === undefined || credentials === ""
        ? undefined
        : path.join(credentials, name);

    if (named === undefined || named === "") {
      if (
        imported !== undefined &&
        process.env[name] === undefined &&
        existsSync(imported)
      ) {
        process.env[name] = readSecret(imported);
      }

      continue;
    }

    const file = named;

    if (process.env[name] !== undefined) {
      throw new Error(`Both ${name} and ${key} are set. Keep one of them.`);
    }

    let value: string;

    try {
      value = readSecret(file);
    } catch (error) {
      throw new Error(`${key} names ${file}, which Shrok cannot read.`, {
        cause: error,
      });
    }

    process.env[name] = value;
  }
};
