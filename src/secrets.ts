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
import { parseEnv } from "node:util";

import { setting } from "./data-dir.ts";
import { SECRETS } from "./integrations.ts";

const SECRETS_FILE = "secrets.env";
const TRAILING_NEWLINE = /\r?\n$/u;

/** An empty variable counts as unset, as for every other setting. */
const isSet = (name: string): boolean => setting(name) !== undefined;

/** The mode bits below this value hold the permissions of the group and of others. */
const GROUP_OR_OTHER_BITS = 0o100;
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

/** Reads a secret source, which must be a regular file with one link, and remembers it so no tool may open it. */
const readSecret = (file: string, ownerOnly = false): string => {
  const canonical = realpathSync(file);
  const descriptor = openSync(canonical, "r");

  try {
    const info = fstatSync(descriptor);

    if (!info.isFile() || info.nlink !== 1) {
      throw new Error("A secret source must be a regular file with one link.");
    }

    if (
      ownerOnly &&
      (info.mode % GROUP_OR_OTHER_BITS !== 0 || info.uid !== process.getuid?.())
    ) {
      throw new Error(
        `${file} must belong to Shrok's user and be readable only by it: chmod 600 ${file}`
      );
    }

    const value = readFileSync(descriptor, "utf-8");

    secretSources.add(path.resolve(file));
    secretSources.add(canonical);
    secretIdentities.add(`${info.dev}:${info.ino}`);

    return value;
  } finally {
    closeSync(descriptor);
  }
};

/**
 * NAME from the file NAME_FILE names, as with Docker secrets, or from $CREDENTIALS_DIRECTORY/NAME, as systemd
 * imports them, for each NAME the environment leaves unset.
 */
const loadFileSecrets = (): void => {
  const credentials = process.env.CREDENTIALS_DIRECTORY;

  for (const name of SECRETS.filter((secret) => !isSet(secret))) {
    const key = `${name}_FILE`;
    const named = process.env[key];

    if (named !== undefined && named !== "") {
      try {
        process.env[name] = readSecret(named).replace(TRAILING_NEWLINE, "");
      } catch (error) {
        throw new Error(`${key} names ${named}, which Shrok cannot read.`, {
          cause: error,
        });
      }
    } else if (credentials !== undefined && credentials !== "") {
      const imported = path.join(credentials, name);

      if (existsSync(imported)) {
        process.env[name] = readSecret(imported).replace(TRAILING_NEWLINE, "");
      }
    }
  }
};

/**
 * Keys and settings from `secrets.env` in the data folder, one NAME=value per line, for whatever the environment
 * leaves unset. Shrok's own secrets and SHROK_ settings only, so a typo shows at startup.
 */
const loadSecretsEnv = (dataDir: string): void => {
  const file = path.join(dataDir, SECRETS_FILE);

  if (!existsSync(file)) {
    return;
  }

  for (const [name, value] of Object.entries(
    parseEnv(readSecret(file, true))
  )) {
    if (
      name === "SHROK_DATA_DIR" ||
      !(SECRETS.includes(name) || name.startsWith("SHROK_"))
    ) {
      throw new Error(
        `${file} sets ${name}, which Shrok does not read from it. It takes ${SECRETS.join(", ")} and SHROK_ settings other than SHROK_DATA_DIR.`
      );
    }

    if (!isSet(name)) {
      process.env[name] = value;
    }
  }
};

/** Fills the environment from secret files. Values already set win; values are never printed. */
export const loadSecrets = (dataDir: string): void => {
  loadFileSecrets();
  loadSecretsEnv(dataDir);
};
