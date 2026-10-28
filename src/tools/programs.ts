import { Buffer } from "node:buffer";
import process from "node:process";

import type { Context } from "@earendil-works/chord";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

import { dataDir } from "../data-dir.ts";
import { integrations } from "../settings.ts";
import { safeEnv } from "./sandbox.ts";

const PROGRAMS = {
  gws: {
    description:
      "Google Workspace: Gmail, Calendar, Drive. Run `gws --help` or `gws <service> --help` first.",
    env: [
      "GOOGLE_WORKSPACE_CLI_CLIENT_ID",
      "GOOGLE_WORKSPACE_CLI_CLIENT_SECRET",
    ],
  },
  xurl: {
    description:
      "X (Twitter) API, like curl: `xurl /2/tweets/<id>`. Run `xurl --help` first. Each post read costs money.",
    env: ["XURL_CLIENT_ID", "XURL_CLIENT_SECRET"],
  },
} as const;

type ProgramName = keyof typeof PROGRAMS;

const INTEGRATION: Record<ProgramName, keyof typeof integrations> = {
  gws: "google",
  xurl: "x",
};

/** Only the programs that are installed and configured. */
const NAMES: readonly ProgramName[] = (["gws", "xurl"] as const).filter(
  (name) => integrations[INTEGRATION[name]]
);

const TIMEOUT_SECONDS = 120;

// gws loads a .env file from its working folder and the folders above it, so it must never start in the
// workspace, which the model can write to. Tools cannot write in the data folder.
const PROGRAM_DIR = dataDir;
const MAX_OUTPUT_BYTES = 1024 * 1024;

const programEnv = (program: ProgramName): Record<string, string> => {
  const env = safeEnv();

  for (const key of PROGRAMS[program].env) {
    const value = process.env[key];

    if (value !== undefined) {
      env[key] = value;
    }
  }

  return env;
};

export const typed = <T extends TSchema>(schema: T, value: Static<T>) => ({
  output: [{ text: JSON.stringify(value, null, 2), type: "text" as const }],
  structuredOutput: Value.Parse(schema, value),
});

export const programJson = async <T extends TSchema>(
  program: ProgramName,
  schema: T,
  env: ExecutionEnv | undefined,
  args: string[],
  context: Context
): Promise<Static<T>> => {
  if (env === undefined) {
    throw new Error(`${program} needs an execution environment.`);
  }

  const out = { stderr: "", stdout: "" };
  let outputBytes = 0;

  const result = await env.exec(
    [program, ...args],
    {
      cwd: PROGRAM_DIR,
      env: programEnv(program),
      inheritEnv: false,
      onOutput: (text, _context, { stream }) => {
        outputBytes += Buffer.byteLength(text, "utf-8");

        if (outputBytes > MAX_OUTPUT_BYTES) {
          // The execution environment kills the child tree when this callback throws.
          throw new Error(`${program} exceeded its output byte limit.`);
        }

        out[stream] += text;
      },
      timeout: TIMEOUT_SECONDS,
    },
    context
  );

  if (!result.ok) {
    throw new Error(`${program} did not run: ${result.error.message}`);
  }

  if (result.value.exitCode !== 0) {
    throw new Error(`${program} failed: ${(out.stdout || out.stderr).trim()}`);
  }

  // A gws search that finds nothing prints its notice to stderr and nothing to stdout.
  return Value.Parse(
    schema,
    JSON.parse(out.stdout.trim() === "" ? "{}" : out.stdout)
  );
};

const createProgramsTool = () =>
  defineTool({
    description: `Run a program that uses the user's own login, outside the bash sandbox, with arguments only (no shell). Programs:\n${NAMES.map((name) => `- ${name}: ${PROGRAMS[name].description}`).join("\n")}`,
    execute: async (args, api, context) => {
      const { env } = api;

      if (env === undefined) {
        throw new Error("run_program needs an execution environment.");
      }

      const result = await env.exec(
        [args.program, ...args.args],
        {
          cwd: PROGRAM_DIR,
          env: programEnv(args.program),
          inheritEnv: false,
          onOutput: (text) => {
            api.output(text);
          },
          timeout: TIMEOUT_SECONDS,
        },
        context
      );

      if (!result.ok) {
        throw new Error(`${args.program} did not run: ${result.error.message}`);
      }

      return { isError: result.value.exitCode !== 0 };
    },
    name: "run_program",
    parameters: Type.Object({
      args: Type.Array(Type.String(), {
        description:
          "Arguments, one per item, exactly as the program takes them",
      }),
      program: StringEnum(NAMES),
    }),
  });

export const createProgramsTools = () =>
  NAMES.length === 0 ? [] : [createProgramsTool()];
