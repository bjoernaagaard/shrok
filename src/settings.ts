import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { whichSync } from "@anthropic-ai/sandbox-runtime/dist/utils/which.js";

import { dataDir, setting } from "./data-dir.ts";
import { loadSecretFiles } from "./secrets.ts";

loadSecretFiles();

const POSIX_LOCALES = new Set(["C", "POSIX"]);
const LOCALE_SUFFIX = /[.@].*$/u;

const isTimeZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone }).format();

    return true;
  } catch {
    return false;
  }
};

const findTimeZone = (): string => {
  const set = setting("SHROK_TIME_ZONE") ?? setting("TZ")?.replace(/^:/u, "");

  if (set !== undefined) {
    if (!isTimeZone(set)) {
      throw new Error(
        `The time zone "${set}" is unknown. Set SHROK_TIME_ZONE to a name such as Europe/Copenhagen.`
      );
    }

    return set;
  }

  // Without /etc/localtime, as in a container, the system zone is UTC by accident rather than by choice.
  if (existsSync("/etc/localtime")) {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  throw new Error(
    "Shrok needs a time zone for schedules and calendar times. Set SHROK_TIME_ZONE, such as SHROK_TIME_ZONE=Europe/Copenhagen."
  );
};

/** `en_GB.UTF-8` and `en_GB@euro` become `en-GB`. */
const asLanguageTag = (value: string): string | undefined => {
  const tag = value.replace(LOCALE_SUFFIX, "").replaceAll("_", "-");

  if (tag === "" || POSIX_LOCALES.has(tag)) {
    return undefined;
  }

  try {
    return Intl.getCanonicalLocales(tag)[0];
  } catch {
    return undefined;
  }
};

const macLocale = (): string | undefined => {
  if (process.platform !== "darwin") {
    return undefined;
  }

  try {
    return execFileSync("defaults", ["read", "-g", "AppleLocale"], {
      encoding: "utf-8",
    }).trim();
  } catch {
    return undefined;
  }
};

const findLocale = (): string => {
  const set = setting("SHROK_LOCALE");

  if (set !== undefined) {
    const tag = asLanguageTag(set);

    if (tag === undefined) {
      throw new Error(
        `The locale "${set}" is unknown. Set SHROK_LOCALE to a language tag such as en-GB.`
      );
    }

    return tag;
  }

  for (const value of [
    setting("LC_ALL"),
    setting("LC_TIME"),
    setting("LANG"),
    macLocale(),
  ]) {
    const tag = value === undefined ? undefined : asLanguageTag(value);

    if (tag !== undefined) {
      return tag;
    }
  }

  throw new Error(
    "Shrok needs a locale for dates and times. Set SHROK_LOCALE, such as SHROK_LOCALE=en-GB."
  );
};

/** A program is offered only when it is installed and every key it reads is set. */
const configured = (program: string, keys: readonly string[]): boolean =>
  whichSync(program) !== null &&
  keys.every((key) => setting(key) !== undefined);

export const timeZone = findTimeZone();
export const locale = findLocale();

export const mcpConfig = path.resolve(
  setting("SHROK_MCP_CONFIG") ?? path.join(dataDir, "mcp.json")
);

/** A browser binary to use instead of the one Shrok picks. */
export const browserPath = setting("SHROK_BROWSER");

export const integrations = {
  google: configured("gws", [
    "GOOGLE_WORKSPACE_CLI_CLIENT_ID",
    "GOOGLE_WORKSPACE_CLI_CLIENT_SECRET",
  ]),
  x: configured("xurl", ["XURL_CLIENT_ID", "XURL_CLIENT_SECRET"]),
} as const;
