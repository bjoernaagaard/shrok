import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, LiveDoc } from "@earendil-works/pi-durable";
import type {
  JsonObject,
  SubmissionId,
  ToolExecutionApi,
} from "@earendil-works/pi-durable";

const MAX_CLASSIFIER_CALLS = 32;
const MAX_TRANSFORM_CALLS = 8;
const MAX_SEARCH_CALLS = 4;
const MAX_TRANSFORM_INSTRUCTION_CHARS = 4000;
const MAX_TRANSFORM_TEXT_CHARS = 40_000;
const MAX_TRANSFORM_TOTAL_CHARS = 160_000;

export const TRANSFORM_TEXT_PARAMETERS = Type.Object({
  instructions: Type.String({
    description: "What to write, such as: Summarize in two sentences.",
    maxLength: MAX_TRANSFORM_INSTRUCTION_CHARS,
  }),
  text: Type.String({ maxLength: MAX_TRANSFORM_TEXT_CHARS }),
});

const PAID_CALL_LIMITS = {
  "pi.codemode.models.classify": MAX_CLASSIFIER_CALLS,
  transform_text: MAX_TRANSFORM_CALLS,
  web_search: MAX_SEARCH_CALLS,
} as const;

type PaidTool = keyof typeof PAID_CALL_LIMITS;

interface RunBudget extends JsonObject {
  input: SubmissionId;
  calls: Record<PaidTool, number>;
  transformChars: number;
}

const PaidToolsDoc = defineDoc<{ run?: RunBudget }>({
  checkpointWhen: () => false,
  fork: "initial",
  history: "latest",
  initial: () => ({}),
  kind: "shrok.paid-tools",
  scope: "conversation",
  version: 1,
});

/** Debit before dispatch, including every interrupted attempt that may pay again. */
export const admitPaidTool = async (
  name: string,
  transformChars: number,
  api: ToolExecutionApi,
  context: Context
): Promise<void> => {
  if (
    name !== "pi.codemode.models.classify" &&
    name !== "transform_text" &&
    name !== "web_search"
  ) {
    return;
  }

  await api.commit(async (tx) => {
    const live = await tx.doc(LiveDoc, api.conversationId);
    const input = live.run?.inputs[0];

    if (input === undefined) {
      throw new Error("Paid tools require an active owner request.");
    }

    const budget = await tx.doc(PaidToolsDoc, api.conversationId);

    // A run's generation task changes at every tool round. Its first input does not.
    if (budget.run?.input !== input) {
      budget.run = {
        calls: {
          "pi.codemode.models.classify": 0,
          transform_text: 0,
          web_search: 0,
        },
        input,
        transformChars: 0,
      };
    }

    const { run } = budget;

    if (
      run.calls[name] >= PAID_CALL_LIMITS[name] ||
      run.transformChars + transformChars > MAX_TRANSFORM_TOTAL_CHARS
    ) {
      throw new Error(`${name} reached this request's paid-tool allowance.`);
    }

    run.calls[name] += 1;
    run.transformChars += transformChars;
  }, context);
};
