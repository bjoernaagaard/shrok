import { once } from "node:events";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { openBrain } from "./brain.ts";
import { checkControlSocket, serveControl } from "./control.ts";
import { dataDir } from "./data-dir.ts";
import { closeEvents, openEvents, record } from "./events.ts";
import { watchLinks } from "./links.ts";
import { lockDataDir } from "./lock.ts";
import { openPhone } from "./phone.ts";
import "./settings.ts";
import { Approvals } from "./tools/approvals.ts";

const OWNER_ONLY_UMASK = 0o077;
const OWNER_ONLY_FOLDER_MODE = 0o700;

/** Docker kills after its stop grace period, so Shrok must be done well inside it. */
const SHUTDOWN_LIMIT_MS = 20_000;

process.umask(OWNER_ONLY_UMASK);

mkdirSync(dataDir, { recursive: true });

chmodSync(dataDir, OWNER_ONLY_FOLDER_MODE);

lockDataDir(dataDir);

checkControlSocket(dataDir);

/** What shutdown is waiting for, named in the event if it runs out of time. */
let shuttingDown = "starting up";

// Listened for before startup, so a stop that arrives while Shrok starts still closes it cleanly.
const stopping = (async () => {
  await Promise.race([once(process, "SIGINT"), once(process, "SIGTERM")]);

  setTimeout(() => {
    record(
      "shutdown",
      `Shutdown took longer than ${SHUTDOWN_LIMIT_MS / 1000} s, stuck on ${shuttingDown}, so Shrok exited without finishing it.`
    );
    process.exit(1);
  }, SHUTDOWN_LIMIT_MS);
})();

openEvents(path.join(dataDir, "events.sqlite"));

process.on("uncaughtExceptionMonitor", (error, origin) => {
  record("crash", `${origin}: ${error.stack ?? String(error)}`);
});

const approvals = new Approvals(path.join(dataDir, "approvals.sqlite"));
const brain = await openBrain(dataDir, approvals);

const phone = await openPhone(dataDir, {
  answer: brain.answer,
  approvals,
  stop: brain.stop,
});

approvals.attach(phone.approvalPhone);

const notify = async (text: string, unlessSentSince: Date): Promise<void> => {
  await phone.send(text, unlessSentSince);
};

brain.attach({ notify, sendFile: phone.sendFile });

const linksFile = process.env.SHROK_LINKS_FILE;

const stopLinks =
  linksFile === undefined ? undefined : watchLinks(linksFile, brain, notify);

const stopControl = await serveControl(dataDir, phone);

// The invite goes only to the terminal that runs shrok pair, never to this log.
process.stderr.write(
  (await phone.hasOwner())
    ? "Shrok is ready.\n"
    : "Shrok is ready. To pair your phone, run: shrok pair\n"
);

await stopping;

stopLinks?.();

shuttingDown = "the pairing socket";

await stopControl();

shuttingDown = "SimpleX";

await phone.close();

shuttingDown = "the brain, browser and sandbox";

await brain.close();

approvals.close();

closeEvents();

process.exit(0);
