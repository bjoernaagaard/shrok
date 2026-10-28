import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import type {
  CodemodeRun,
  CodemodeRunOptions,
} from "@earendil-works/pi-codemode";

const CODEMODE_TIMEOUT_MS = 120_000;
const CODEMODE_MEMORY_BYTES = 32 * 1024 * 1024;
const CODEMODE_MAX_WORKERS = 2;

// Reservations cover actual worker lifetime, including delayed termination.
let workers = 0;

class BoundedCodemodeSandbox extends CodemodeSandbox {
  override start(code: string, options: CodemodeRunOptions): CodemodeRun {
    // The durable runner persists startedAt. Replay must not restart the clock.
    const remaining = options.startedAt + CODEMODE_TIMEOUT_MS - Date.now();

    if (remaining <= 0) {
      throw new Error("Code mode deadline has expired.");
    }

    return super.start(code, {
      ...options,
      timeoutMs: Math.min(options.timeoutMs ?? CODEMODE_TIMEOUT_MS, remaining),
    });
  }
}

export const createCodemodeSandbox = (): CodemodeSandbox =>
  new BoundedCodemodeSandbox({
    acquireWorker: () => {
      if (workers >= CODEMODE_MAX_WORKERS) {
        throw new Error("Code mode worker capacity is full.");
      }

      workers += 1;

      return () => {
        workers -= 1;
      };
    },
    memoryLimitBytes: CODEMODE_MEMORY_BYTES,
  });
