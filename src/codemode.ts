import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import type {
  CodemodeRun,
  CodemodeRunOptions,
} from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import type { CodemodeToolOptions } from "@earendil-works/pi-durable/codemode";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";

import type { CallPolicy } from "./tools/policy.ts";

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

/** Code mode and tool search, with their policies: scripts may classify, a limited number of times per request. */
export const createCodemode = (
  namespaces: CodemodeToolOptions["namespaces"]
) => {
  const options: CodemodeToolOptions = {
    namespaces,
    sandbox: new BoundedCodemodeSandbox({
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
    }),
  };

  const policies: CallPolicy[] = [
    { name: "codemode", phrase: "running a script" },
    { name: "tool_search", phrase: "looking for a tool" },
    { name: "pi.codemode.models.classify", paid: { calls: 32 } },
  ];

  return {
    extensions: [createToolSearchExtension(), createCodemodeExtension(options)],
    options,
    policies,
  };
};
