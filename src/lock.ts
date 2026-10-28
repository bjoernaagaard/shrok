import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const LOCK_FILE = "lock.sqlite";

/** Kept referenced: a collected handle would close and drop the lock. */
const held: DatabaseSync[] = [];

/**
 * Holds an exclusive SQLite lock on the data folder for as long as Shrok runs, so a second Shrok on the same
 * folder stops at once instead of sharing its SimpleX and chat databases. The lock goes when the process does.
 */
export const lockDataDir = (dataDir: string): void => {
  const lock = new DatabaseSync(path.join(dataDir, LOCK_FILE), { timeout: 0 });

  try {
    lock.exec("BEGIN EXCLUSIVE");
    held.push(lock);
  } catch {
    lock.close();
    throw new Error(
      `Another Shrok is already running on ${dataDir}. Stop it first, or set SHROK_DATA_DIR to another folder.`
    );
  }
};
