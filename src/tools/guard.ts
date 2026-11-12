import type { Context } from "@earendil-works/chord/context";
import {
  defineDoc,
  defineExtension,
  hook,
  LiveDoc,
  ToolTask,
} from "@earendil-works/pi-durable";
import type {
  JsonObject,
  SubmissionId,
  ToolExecutionApi,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type { ShrokTool, ToolCatalog } from "./policy.ts";

const BLOCKED =
  "This operation has no reviewed capability and is blocked. A model judgment or generic approval cannot authorize it. The owner must complete it manually. Do not try another tool to bypass this restriction.";

/** Why a call may not open the file at `path`, or undefined. Checked before a call and again in its executor. */
export type PathProblem = (
  tool: string,
  path: string | undefined,
  context: Context
) => Promise<string | undefined>;

interface Spent extends JsonObject {
  input: SubmissionId;
  calls: Record<string, number>;
  chars: Record<string, number>;
}

const PaidDoc = defineDoc<{ run?: Spent }>({
  checkpointWhen: () => false,
  fork: "initial",
  history: "latest",
  initial: () => ({}),
  kind: "shrok.paid-tools",
  scope: "conversation",
  version: 2,
});

const Fields = Type.Record(Type.String(), Type.Unknown());
const Text = Type.String();
const PathArgs = Type.Object({ path: Type.String() });

/** Debits a paid call before it runs, including every interrupted attempt that may pay again. */
const spend = async (
  name: string,
  paid: NonNullable<ShrokTool["paid"]>,
  textChars: number,
  api: ToolExecutionApi,
  context: Context
): Promise<void> => {
  await api.commit(async (tx) => {
    const live = await tx.doc(LiveDoc, api.conversationId);
    const input = live.run?.inputs[0];

    if (input === undefined) {
      throw new Error("Paid tools require an active owner request.");
    }

    const doc = await tx.doc(PaidDoc, api.conversationId);

    // A run's generation task changes at every tool round. Its first input does not.
    if (doc.run?.input !== input) {
      doc.run = { calls: {}, chars: {}, input };
    }

    const calls = (doc.run.calls[name] ?? 0) + 1;
    const chars = (doc.run.chars[name] ?? 0) + textChars;

    if (
      calls > paid.calls ||
      chars > (paid.chars ?? Number.POSITIVE_INFINITY)
    ) {
      throw new Error(`${name} reached this request's paid-tool allowance.`);
    }

    doc.run.calls[name] = calls;
    doc.run.chars[name] = chars;
  }, context);
};

/**
 * Lets only catalogued tools run, with arguments their own schema allows, within their paid allowance. The executor
 * checks too, not only the hook: a replay-safe tool can resume in its execute phase after a restart, without the
 * hook or the harness's argument validation running again.
 */
export const createGuard = (catalog: ToolCatalog, problem: PathProblem) => {
  const check = async (
    name: string,
    path: string | undefined,
    context: Context
  ): Promise<string | undefined> =>
    catalog.get(name) === undefined
      ? BLOCKED
      : await problem(name, path, context);

  const guard = (tools: readonly ToolRegistration[]): ToolRegistration[] =>
    tools.map((tool) => ({
      ...tool,
      description:
        catalog.get(tool.name) === undefined ? BLOCKED : tool.description,
      execute: async (args, api, context) => {
        const blocked = await check(
          tool.name,
          Value.Check(PathArgs, args) ? args.path : undefined,
          context
        );

        if (blocked !== undefined) {
          throw new Error(blocked);
        }

        if (!Value.Check(tool.parameters, args)) {
          throw new Error(
            `${tool.name} got arguments its schema does not allow.`
          );
        }

        const paid = catalog.get(tool.name)?.paid;

        if (paid !== undefined) {
          const chars = Value.Check(Fields, args)
            ? Object.values(args).reduce(
                (sum: number, value) =>
                  sum + (Value.Check(Text, value) ? value.length : 0),
                0
              )
            : 0;

          await spend(tool.name, paid, chars, api, context);
        }

        return await tool.execute(args, api, context);
      },
    }));

  const extension = defineExtension({
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, _api, context) => {
          const block = await check(
            call.name,
            Value.Check(PathArgs, call.arguments)
              ? call.arguments.path
              : undefined,
            context
          );

          return block === undefined ? {} : { block };
        },
      }),
    ],
    name: "guard",
  });

  return { extension, guard };
};
