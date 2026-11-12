import { Buffer } from "node:buffer";
import process from "node:process";

import type { Context } from "@earendil-works/chord/context";
import { defineTool } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

import { dataDir } from "../data-dir.ts";
import { INTEGRATIONS } from "../integrations.ts";
import type { Program } from "../integrations.ts";
import { integrations } from "../settings.ts";
import { textOutcome } from "./approvals.ts";
import type { Approvals } from "./approvals.ts";
import type { ShrokTool } from "./policy.ts";
import { safeEnv } from "./sandbox.ts";

const TIMEOUT_SECONDS = 120;
const MAX_OUTPUT_BYTES = 1024 * 1024;

// gws loads a .env file from its working folder and the folders above it, so it must never start in the
// workspace, which the model can write to. Tools cannot write in the data folder.
const PROGRAM_DIR = dataDir;

const integrationOf = (program: Program) =>
  INTEGRATIONS.find((each) => each.program === program);

/** The installed and configured programs. */
const PROGRAMS: readonly Program[] = INTEGRATIONS.flatMap(({ name, program }) =>
  integrations.has(name) ? [program] : []
);

const programEnv = (program: Program): Record<string, string> => {
  const env = safeEnv();

  for (const key of integrationOf(program)?.keys ?? []) {
    const value = process.env[key];

    if (value !== undefined) {
      env[key] = value;
    }
  }

  return env;
};

interface Output {
  stdout: string;
  stderr: string;
}

/** Runs a program with the owner's login, outside the sandbox, with a time and output limit. */
const runProgram = async (
  argv: readonly [Program, ...string[]],
  env: ExecutionEnv | undefined,
  context: Context
): Promise<{ exitCode: number; output: Output }> => {
  if (env === undefined) {
    throw new Error(`${argv[0]} needs an execution environment.`);
  }

  const output: Output = { stderr: "", stdout: "" };
  let outputBytes = 0;

  const result = await env.exec(
    [...argv],
    {
      cwd: PROGRAM_DIR,
      env: programEnv(argv[0]),
      inheritEnv: false,
      onOutput: (text, _context, { stream }) => {
        outputBytes += Buffer.byteLength(text, "utf-8");

        if (outputBytes > MAX_OUTPUT_BYTES) {
          // The execution environment kills the child tree when this callback throws.
          throw new Error(`${argv[0]} exceeded its output byte limit.`);
        }

        output[stream] += text;
      },
      timeout: TIMEOUT_SECONDS,
    },
    context
  );

  if (!result.ok) {
    throw new Error(`${argv[0]} did not run: ${result.error.message}`);
  }

  return { exitCode: result.value.exitCode, output };
};

const PLAIN_WORD = /^[\w@%+=:,./-]+$/u;
const MAX_SHOWN_COMMAND_CHARS = 2000;

/** The command as the owner reads it: plain words as they are, anything else quoted, so no argument can pose as another. */
const commandLine = (argv: readonly string[]): string => {
  const line = argv
    .map((arg) => (PLAIN_WORD.test(arg) ? arg : JSON.stringify(arg)))
    .join(" ");

  return line.length > MAX_SHOWN_COMMAND_CHARS
    ? `${line.slice(0, MAX_SHOWN_COMMAND_CHARS)} (cut here; the rest is in the attached details)`
    : line;
};

export const programJson = async <T extends TSchema>(
  program: Program,
  schema: T,
  env: ExecutionEnv | undefined,
  args: string[],
  context: Context
): Promise<Static<T>> => {
  const { exitCode, output } = await runProgram(
    [program, ...args],
    env,
    context
  );

  if (exitCode !== 0) {
    throw new Error(
      `${program} failed: ${(output.stdout || output.stderr).trim()}`
    );
  }

  // A gws search that finds nothing, or a call with no response body, prints nothing to stdout.
  return Value.Parse(
    schema,
    JSON.parse(output.stdout.trim() === "" ? "{}" : output.stdout)
  );
};

export const createProgramsTools = (approvals: Approvals): ShrokTool[] =>
  PROGRAMS.length === 0
    ? []
    : [
        {
          describe: (args) =>
            INTEGRATIONS.find(({ program }) => program === args.program)
              ?.phrase,
          phrase: "using a program with your login",
          tool: defineTool({
            description: `Run a program that uses the user's own login, outside the bash sandbox, with arguments only (no shell). Each run waits for the owner's /yes on the exact command, unless he allowed that exact command for good, so prefer a typed tool when one fits. Programs:\n${PROGRAMS.map((program) => `- ${program}: ${integrationOf(program)?.description ?? ""}`).join("\n")}`,
            execute: async (args, api, toolContext) => {
              const argv: [Program, ...string[]] = [args.program, ...args.args];

              return textOutcome(
                await approvals.request(api, toolContext, () => ({
                  arguments: { args: args.args, program: args.program },
                  grants: [`running exactly ${JSON.stringify(argv)}`],
                  run: async ({ context, env }) => {
                    const { exitCode, output } = await runProgram(
                      argv,
                      env,
                      context
                    );

                    return `Exit code ${exitCode}.\n\n${output.stdout}${output.stderr === "" ? "" : `\n\nstderr:\n${output.stderr}`}`;
                  },
                  state: {},
                  summary: `run ${args.program} with your login, outside the sandbox, exactly as: ${commandLine(argv)}`,
                  tool: "run_program",
                }))
              );
            },
            name: "run_program",
            parameters: Type.Object({
              args: Type.Array(Type.String(), {
                description:
                  "Arguments, one per item, exactly as the program takes them",
              }),
              program: Type.Enum(PROGRAMS),
            }),
          }),
        },
      ];
