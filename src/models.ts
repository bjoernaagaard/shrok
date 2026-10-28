import process from "node:process";

import { createModels } from "@earendil-works/pi-ai";
import type {
  Api,
  ClassifierApi,
  ClassifierModel,
  Model,
  Models,
  Provider,
  StreamOptions,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ModelRef } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { withAnthropicClassifier } from "./classifier.ts";
import { markViewCache } from "./memory/cache.ts";

interface Defaults {
  readonly provider: string;
  readonly SHROK_MODEL: string;
  readonly SHROK_SMALL_MODEL: string;
  readonly SHROK_CLASSIFIER: string;
}

/** The first provider here with a key picks every model the settings leave out. */
const PROVIDER_DEFAULTS: readonly Defaults[] = [
  {
    SHROK_CLASSIFIER: "anthropic/claude-haiku-5-5",
    SHROK_MODEL: "anthropic/claude-opus-5-5",
    SHROK_SMALL_MODEL: "anthropic/claude-haiku-5-5",
    provider: "anthropic",
  },
  {
    SHROK_CLASSIFIER: "openai/gpt-6-luna",
    SHROK_MODEL: "openai/gpt-6.1-sol",
    SHROK_SMALL_MODEL: "openai/gpt-6-luna",
    provider: "openai",
  },
];

type Setting = "SHROK_MODEL" | "SHROK_SMALL_MODEL" | "SHROK_CLASSIFIER";

export interface ShrokModels {
  readonly models: Models;
  readonly chatModel: ModelRef;
  /** Writes memory summaries, searches the web and reads Google results. */
  readonly smallModel: Model<Api>;
  /** What flows call through models.classify. */
  readonly classifier: ClassifierModel<ClassifierApi>;
}

type PayloadHook = StreamOptions["onPayload"];

const AdaptiveThinkingSchema = Type.Object({
  thinking: Type.Object({
    display: Type.Optional(Type.String()),
    type: Type.Literal("adaptive"),
  }),
});

// Without the thinking summary, Anthropic starts streaming the answer's text sooner.
const omitThinkingText: NonNullable<PayloadHook> = (payload) => {
  if (Value.Check(AdaptiveThinkingSchema, payload)) {
    payload.thinking.display = "omitted";
  }

  return payload;
};

const prepare =
  (onPayload: PayloadHook): NonNullable<PayloadHook> =>
  async (payload, model) => {
    const own = (await onPayload?.(payload, model)) ?? payload;

    return model.api === "anthropic-messages"
      ? await omitThinkingText(await markViewCache(own, model), model)
      : own;
  };

// The official Anthropic and OpenAI SDKs read these; pi-ai leaves them to its caller.
const BASE_URL_SETTINGS = new Map([
  ["anthropic", "ANTHROPIC_BASE_URL"],
  ["openai", "OPENAI_BASE_URL"],
]);

const withBaseUrl = (provider: Provider): Provider => {
  const setting = BASE_URL_SETTINGS.get(provider.id);
  const baseUrl = setting === undefined ? undefined : process.env[setting];

  if (baseUrl === undefined || baseUrl === "") {
    return provider;
  }

  return {
    ...provider,
    baseUrl,
    getAllModels: () =>
      (provider.getAllModels?.() ?? provider.getModels()).map((model) => ({
        ...model,
        baseUrl,
      })),
    getModels: () =>
      provider.getModels().map((model) => ({ ...model, baseUrl })),
  };
};

// Shrok and pi-durable only call streamSimple.
const withPayloadHooks = (provider: Provider): Provider => ({
  ...provider,
  streamSimple: (model, transcript, options) =>
    provider.streamSimple(model, transcript, {
      ...options,
      onPayload: prepare(options?.onPayload),
    }),
});

const findDefaults = async (models: Models): Promise<Defaults | undefined> => {
  for (const defaults of PROVIDER_DEFAULTS) {
    // oxlint-disable-next-line no-await-in-loop -- the first provider with a key wins
    if ((await models.checkAuth(defaults.provider)) !== undefined) {
      return defaults;
    }
  }

  return undefined;
};

const configuredModel = async <T>(
  models: Models,
  setting: Setting,
  defaults: Defaults | undefined,
  find: (provider: string, id: string) => T | undefined
): Promise<T> => {
  const name = process.env[setting] ?? defaults?.[setting];

  if (name === undefined) {
    throw new Error(
      `Set ANTHROPIC_API_KEY or OPENAI_API_KEY, or set ${setting} to a provider/model whose key is set.`
    );
  }

  const slash = name.indexOf("/");

  if (slash <= 0) {
    throw new Error(
      `${setting} must be written as provider/model, such as ${PROVIDER_DEFAULTS[0]?.[setting]}. It is "${name}".`
    );
  }

  const provider = name.slice(0, slash);

  await models.refresh({ providers: [provider] });

  const model = find(provider, name.slice(slash + 1));

  if (model === undefined) {
    throw new Error(`${setting} names ${name}, which pi-ai doesn't know.`);
  }

  if ((await models.checkAuth(provider)) === undefined) {
    throw new Error(
      `${setting} names ${name}, but provider ${provider} has no credentials. Add its key to secretspec.toml.`
    );
  }

  return model;
};

export const createShrokModels = async (): Promise<ShrokModels> => {
  const models = createModels();

  for (const provider of builtinProviders()) {
    models.setProvider(
      withAnthropicClassifier(withPayloadHooks(withBaseUrl(provider)), models)
    );
  }

  const defaults = await findDefaults(models);
  const chat = (provider: string, id: string) => models.getModel(provider, id);

  const chatModel = await configuredModel(
    models,
    "SHROK_MODEL",
    defaults,
    chat
  );

  const smallModel = await configuredModel(
    models,
    "SHROK_SMALL_MODEL",
    defaults,
    chat
  );

  const classifier = await configuredModel(
    models,
    "SHROK_CLASSIFIER",
    defaults,
    (provider, id) => models.getModelOfType("classifier", provider, id)
  );

  return {
    chatModel: { modelId: chatModel.id, provider: chatModel.provider },
    classifier,
    models,
    smallModel,
  };
};
