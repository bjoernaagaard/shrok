import { hasApi } from "@earendil-works/pi-ai";
import type {
  ClassifierAnswer,
  ClassifierApi,
  ClassifierContext,
  ClassifierModel,
  ClassifierQuestion,
  ClassifierResult,
  Models,
  Provider,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";

/** Anthropic has no classifier API, so this one answers through a single forced, strict tool call. */
const TOOL_CALL_API = "anthropic-tool-call";
const ANSWER_TOOL = "answer";
const CLASSIFIER_ID = "claude-haiku-5-5";

/** Each request allows a fixed number of classify calls, and this bounds what each one sends. */
const MAX_STATE_CHARS = 200_000;

/** What the tool's strict schema allows each answer to be. */
const Answers = Type.Record(
  Type.String(),
  Type.Union([Type.String(), Type.Boolean()])
);

const SYSTEM_PROMPT = `You classify a JSON state. Read the state and every question, then call the ${ANSWER_TOOL} tool once with an answer to each question. Judge only from what the state says.`;

const answerSchema = (question: ClassifierQuestion): TSchema => {
  if (question.type === "choice") {
    return Type.Enum(Object.keys(question.criteria));
  }

  if (question.type === "score") {
    return Type.Enum(question.criteria);
  }

  return Type.Boolean();
};

const describe = (question: ClassifierQuestion): string => {
  if (question.type === "choice") {
    return `${question.instructions}\nPick one:\n${Object.entries(
      question.criteria
    )
      .map(([label, meaning]) => `- ${label}: ${meaning}`)
      .join("\n")}`;
  }

  if (question.type === "score") {
    return `${question.instructions}\nPick the level that fits, from lowest to highest:\n${question.criteria
      .map((level) => `- ${level}`)
      .join("\n")}`;
  }

  return `${question.instructions}\ntrue means: ${question.criteria.true}\nfalse means: ${question.criteria.false}`;
};

/** Every probability is 0 or 1: one tool call gives an answer, not a distribution. */
const typedAnswer = (
  question: ClassifierQuestion,
  value: string | boolean | undefined
): ClassifierAnswer => {
  if (question.type === "choice") {
    const choice = String(value);

    return {
      choice,
      confidence: 1,
      probabilities: Object.fromEntries(
        Object.keys(question.criteria).map((label) => [
          label,
          label === choice ? 1 : 0,
        ])
      ),
      type: "choice",
    };
  }

  if (question.type === "score") {
    return {
      confidence: 1,
      score: question.criteria.indexOf(String(value)),
      type: "score",
    };
  }

  return { probability: value === true ? 1 : 0, type: "bool" };
};

const classify = async (
  models: Models,
  model: ClassifierModel<ClassifierApi>,
  context: ClassifierContext,
  signal: AbortSignal | undefined
): Promise<ClassifierResult> => {
  const result: ClassifierResult = {
    answers: {},
    api: model.api,
    model: model.id,
    provider: model.provider,
    stopReason: "stop",
    timestamp: Date.now(),
  };

  const chat = models.getModel(model.provider, model.id);

  if (chat === undefined || !hasApi(chat, "anthropic-messages")) {
    return {
      ...result,
      errorMessage: `${model.provider}/${model.id} is not an Anthropic chat model.`,
      stopReason: "error",
    };
  }

  const state = JSON.stringify(context.state);

  if (state.length > MAX_STATE_CHARS) {
    return {
      ...result,
      errorMessage: `The state to classify is ${state.length} characters, over the ${MAX_STATE_CHARS}-character limit.`,
      stopReason: "error",
    };
  }

  const questions = Object.entries(context.questions);

  const parameters = Type.Object(
    Object.fromEntries(
      questions.map(([name, question]) => [
        name,
        { ...answerSchema(question), description: describe(question) },
      ])
    ),
    { additionalProperties: false }
  );

  const message = await models.complete(
    chat,
    {
      messages: [
        {
          content: [{ text: state, type: "text" }, ...(context.images ?? [])],
          role: "user",
          timestamp: Date.now(),
        },
      ],
      systemPrompt: SYSTEM_PROMPT,
      tools: [
        {
          constrainedSampling: { strict: "require", type: "json_schema" },
          description: "Answer every question about the state.",
          name: ANSWER_TOOL,
          parameters,
        },
      ],
    },
    { signal, toolChoice: { name: ANSWER_TOOL, type: "tool" } }
  );

  if (message.usage !== undefined) {
    result.usage = message.usage;
  }

  if (message.stopReason === "error" || message.stopReason === "aborted") {
    return {
      ...result,
      errorMessage: message.errorMessage,
      stopReason: message.stopReason,
    };
  }

  const call = message.content.find(
    (part) => part.type === "toolCall" && part.name === ANSWER_TOOL
  );

  if (call?.type !== "toolCall" || !Value.Check(parameters, call.arguments)) {
    return {
      ...result,
      errorMessage: `${model.id} did not answer every question.`,
      stopReason: "error",
    };
  }

  const answers = Value.Parse(Answers, call.arguments);

  result.answers = Object.fromEntries(
    questions.map(([name, question]) => [
      name,
      typedAnswer(question, answers[name]),
    ])
  );

  return result;
};

/** Whether a classifier's probabilities mean anything between 0 and 1. */
export const isCalibrated = (model: ClassifierModel<ClassifierApi>): boolean =>
  model.api !== TOOL_CALL_API;

/** Adds `anthropic/claude-haiku-5-5` as a classifier to Anthropic's built-in provider. */
export const withAnthropicClassifier = (
  provider: Provider,
  models: Models
): Provider => {
  if (provider.id !== "anthropic") {
    return provider;
  }

  const listed = () => provider.getAllModels?.() ?? provider.getModels();

  const classifierModel = (): ClassifierModel<ClassifierApi> | undefined => {
    const chat = provider.getModels().find((each) => each.id === CLASSIFIER_ID);

    return chat === undefined
      ? undefined
      : {
          api: TOOL_CALL_API,
          baseUrl: chat.baseUrl,
          contextWindow: chat.contextWindow,
          cost: chat.cost,
          id: chat.id,
          input: chat.input,
          name: chat.name,
          provider: chat.provider,
          type: "classifier",
        };
  };

  return {
    ...provider,
    classify: async (model, context, options) =>
      await classify(models, model, context, options?.signal),
    getAllModels: () => {
      const classifier = classifierModel();

      return classifier === undefined ? listed() : [...listed(), classifier];
    },
  };
};
