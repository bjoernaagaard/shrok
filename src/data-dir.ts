import path from "node:path";
import process from "node:process";

/** An unset and an empty setting both mean the default. */
export const setting = (name: string): string | undefined => {
  const value = process.env[name];

  return value === undefined || value === "" ? undefined : value;
};

/** Where Shrok keeps its data. Kept apart from settings.ts, so shrok pair needs no time zone or locale. */
export const dataDir = path.resolve(setting("SHROK_DATA_DIR") ?? "data");
