import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import { copyJson } from "@earendil-works/chord";
import type { JsonValue } from "@earendil-works/chord";
import type {
  ImageContent,
  JsonObject,
  TextContent,
} from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import {
  McpClient,
  McpHttpError,
  StdioTransport,
  StreamableHttpTransport,
  toLlmContent,
} from "@earendil-works/pi-mcp";
import type {
  CallToolResult,
  McpTransport,
  Tool as McpTool,
} from "@earendil-works/pi-mcp";
import { Type } from "typebox";
import type { Static, TUnsafe } from "typebox";
import { Value } from "typebox/value";

import { report } from "../events.ts";
import { safeEnv } from "./sandbox.ts";

const DEFAULT_TIMEOUT_SECONDS = 60;
const CONNECT_RETRY_DELAYS_MS = [250, 1000];
const MAX_TOOL_NAME_LENGTH = 64;
const MCP_OUTPUT_MAX_BYTES = 20 * 1024;
const MCP_JSON_MAX_DEPTH = 64;
const MCP_JSON_MAX_NODES = 10_000;
const NAME_HASH_CHARS = 8;
const TOOL_NAME_CHARS = /[^A-Za-z0-9_]/gu;
const SERVER_NAME = /^[A-Za-z0-9_-]+$/u;

const ENV_REFERENCE =
  /\$(?:(?<escaped>[$!])|\{(?<braced>[A-Za-z_][A-Za-z0-9_]*)\}|(?<bare>[A-Za-z_][A-Za-z0-9_]*))/gu;

const PATTERN_SPECIALS = /[.+?^${}()|[\]\\]/gu;
const HTTP_TIMEOUT = 408;
const HTTP_TOO_MANY = 429;
const HTTP_SERVER_ERROR = 500;
const HTTP_NOT_IMPLEMENTED = 501;
const DATA_KEYWORDS = new Set(["const", "enum", "default", "examples"]);

const MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
  "definitions",
  "$defs",
]);

/**
 * - `codemode` (default): callable from code mode scripts only; scripts find them with `searchTools()`.
 * - `deferred`: offered to the model once `tool_search` loads them.
 * - `direct`: offered to the model like any other tool.
 * - `hidden`: left out.
 */
const ExposureSchema = Type.Union([
  Type.Literal("codemode"),
  Type.Literal("deferred"),
  Type.Literal("direct"),
  Type.Literal("hidden"),
]);

type McpExposure = Static<typeof ExposureSchema>;

const EXPOSURE_FIELDS = {
  codemode: { callers: ["tools"] },
  deferred: { deferred: true },
  direct: {},
} as const;

const CommonFields = {
  description: Type.Optional(Type.String()),
  enabled: Type.Optional(Type.Boolean()),
  exposure: Type.Optional(ExposureSchema),
  timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  toolExposure: Type.Optional(Type.Record(Type.String(), ExposureSchema)),
};

const StdioSchema = Type.Object(
  {
    ...CommonFields,
    args: Type.Optional(Type.Array(Type.String())),
    command: Type.String(),
    cwd: Type.Optional(Type.String()),
    env: Type.Optional(Type.Record(Type.String(), Type.String())),
    type: Type.Optional(Type.Literal("stdio")),
  },
  { additionalProperties: false }
);

const HttpSchema = Type.Object(
  {
    ...CommonFields,
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    type: Type.Optional(
      Type.Union([Type.Literal("http"), Type.Literal("streamable-http")])
    ),
    url: Type.String(),
  },
  { additionalProperties: false }
);

const FileSchema = Type.Object({
  mcpServers: Type.Record(Type.String(), Type.Union([StdioSchema, HttpSchema])),
});

type McpServerConfig = Static<typeof StdioSchema> | Static<typeof HttpSchema>;

type McpTransportFactory = (
  server: string,
  config: McpServerConfig
) => McpTransport;

interface McpNamespace {
  readonly name: string;
  readonly description: string;
  readonly prefix: string;
}

interface McpCallResult {
  readonly output: (TextContent | ImageContent)[];
  readonly structuredOutput: JsonValue;
  readonly isError: boolean;
}

interface McpCallOptions {
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: (text: string) => void;
}

export interface McpServers {
  readonly tools: ToolRegistration[];
  readonly namespaces: McpNamespace[];
  /** Calls a tool by its Shrok name, such as `mcp__github__search`. */
  call: (
    name: string,
    args: JsonObject,
    options: McpCallOptions
  ) => Promise<McpCallResult>;
  close: () => Promise<void>;
}

const resolveConfigValue = (value: string, where: string): string =>
  value.replaceAll(
    ENV_REFERENCE,
    (_match, escaped?: string, braced?: string, bare?: string) => {
      const name = braced ?? bare ?? "";
      const resolved = escaped ?? process.env[name];

      if (resolved === undefined || resolved === "") {
        throw new Error(`${where}: environment variable ${name} is not set`);
      }

      return resolved;
    }
  );

const resolveAll = (
  values: Readonly<Record<string, string>> | undefined,
  where: string
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(values ?? {}).map(([key, value]) => [
      key,
      resolveConfigValue(value, `${where} "${key}"`),
    ])
  );

const expandHome = (value: string): string =>
  value === "~" || value.startsWith("~/")
    ? path.join(homedir(), value.slice(2))
    : value;

const createDefaultTransport =
  (cwd: string): McpTransportFactory =>
  (server, config) => {
    if ("url" in config) {
      return new StreamableHttpTransport({
        fetch: async (input, init) =>
          await fetch(input, { ...init, redirect: "error" }),
        headers: resolveAll(config.headers, `MCP server "${server}" header`),
        url: config.url,
      });
    }

    return new StdioTransport({
      args: (config.args ?? []).map(expandHome),
      command: expandHome(config.command),
      cwd: path.resolve(cwd, expandHome(config.cwd ?? ".")),
      // Only the safe variables and what mcp.json names, never Shrok's model and service keys.
      env: {
        ...safeEnv(),
        ...resolveAll(config.env, `MCP server "${server}" env`),
      },
      inheritEnv: false,
      stderr: "pipe",
    });
  };

const createMcpToolName = (
  server: string,
  tool: string,
  isTaken: (name: string) => boolean
): string => {
  const name = `mcp__${server}__${tool}`.replaceAll(TOOL_NAME_CHARS, "_");

  if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) {
    return name;
  }

  const hash = createHash("sha256")
    .update(`${server}\0${tool}`)
    .digest("hex")
    .slice(0, NAME_HASH_CHARS);

  return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
};

const mcpNamespace = (server: string): string =>
  `mcp__${server.replaceAll("-", "_")}`;

const patternMatches = (pattern: string, name: string): boolean =>
  new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replaceAll(PATTERN_SPECIALS, "\\$&"))
      .join(".*")}$`,
    "u"
  ).test(name);

const getMcpToolExposure = (
  config: McpServerConfig,
  tool: string
): McpExposure => {
  const overrides = config.toolExposure ?? {};
  const exact = overrides[tool];

  if (exact !== undefined) {
    return exact;
  }

  for (const [pattern, exposure] of Object.entries(overrides)) {
    if (pattern.includes("*") && patternMatches(pattern, tool)) {
      return exposure;
    }
  }

  return config.exposure ?? "codemode";
};

const textOf = (content: readonly (TextContent | ImageContent)[]): string =>
  content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");

// Bound the tree before dependencies copy, serialize or recursively process peer-controlled JSON.
const assertJsonBudget = (
  value: McpTool["inputSchema"] | CallToolResult
): void => {
  const pending: { value: unknown; depth: number }[] = [{ depth: 0, value }];
  let nodes = 0;

  while (pending.length > 0) {
    const next = pending.pop();

    if (next === undefined) {
      break;
    }

    nodes += 1;

    if (next.depth > MCP_JSON_MAX_DEPTH || nodes > MCP_JSON_MAX_NODES) {
      throw new Error("MCP JSON exceeds the supported depth or node budget.");
    }

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Bound untrusted JSON before the recursive strict-JSON parser runs.
    if (next.value !== null && typeof next.value === "object") {
      const children = Object.values(next.value);

      if (nodes + pending.length + children.length > MCP_JSON_MAX_NODES) {
        throw new Error("MCP JSON exceeds the supported node budget.");
      }

      for (const child of children) {
        pending.push({ depth: next.depth + 1, value: child });
      }
    }
  }
};

const convertMcpResult = (
  server: string,
  tool: string,
  result: CallToolResult
): McpCallResult => {
  assertJsonBudget(result);

  const output = toLlmContent(result);

  if (result.isError === true && textOf(output) === "") {
    output.push({
      text: `MCP tool ${server}/${tool} returned an error`,
      type: "text",
    });
  }

  const { _meta: _ignored, ...scriptResult } = result;

  return {
    isError: result.isError === true,
    output,
    structuredOutput: copyJson(scriptResult, { omitUndefinedProperties: true }),
  };
};

const isLocalRef = (value: JsonValue): value is string =>
  typeof value === "string" && (value === "#" || value.startsWith("#/"));

const isJsonObject = (
  value: JsonValue
): value is { [key: string]: JsonValue } =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const relocateSchema = (schema: JsonValue, pointer: string): JsonValue => {
  if (Array.isArray(schema)) {
    return schema.map((item) => relocateSchema(item, pointer));
  }

  if (!isJsonObject(schema)) {
    return schema;
  }

  return Object.fromEntries(
    Object.entries(schema).map(([key, value]): [string, JsonValue] => {
      if (key === "$ref" && isLocalRef(value)) {
        return [key, `${pointer}${value.slice(1)}`];
      }

      if (DATA_KEYWORDS.has(key)) {
        return [key, value];
      }

      if (MAP_KEYWORDS.has(key) && isJsonObject(value)) {
        return [
          key,
          Object.fromEntries(
            Object.entries(value).map(([name, inner]) => [
              name,
              relocateSchema(inner, pointer),
            ])
          ),
        ];
      }

      return [key, relocateSchema(value, pointer)];
    })
  );
};

const schemaJson = (
  schema: McpTool["inputSchema"]
): { [key: string]: JsonValue } => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The peer's schema root must be an object before copying it.
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    throw new TypeError("An MCP tool schema must be a JSON object.");
  }

  assertJsonBudget(schema);

  const json = copyJson(schema);

  if (!isJsonObject(json)) {
    throw new TypeError("An MCP tool schema must be a JSON object.");
  }

  return json;
};

const toParameters = (schema: {
  [key: string]: JsonValue;
}): TUnsafe<JsonObject> =>
  Type.Unsafe<JsonObject>({
    ...schema,
    properties: schema.properties ?? {},
    type: schema.type ?? "object",
  });

const resultSchema = (
  outputSchema: { [key: string]: JsonValue } | undefined
): TUnsafe<JsonObject> =>
  Type.Unsafe<JsonObject>({
    additionalProperties: true,
    properties: {
      content: {
        items: {
          additionalProperties: true,
          properties: {
            data: { type: "string" },
            mimeType: { type: "string" },
            text: { type: "string" },
            type: {
              enum: ["text", "image", "audio", "resource_link", "resource"],
            },
          },
          required: ["type"],
          type: "object",
        },
        type: "array",
      },
      isError: { type: "boolean" },
      structuredContent:
        outputSchema === undefined
          ? {}
          : relocateSchema(outputSchema, "#/properties/structuredContent"),
    },
    required: ["content"],
    type: "object",
  });

const isTransientError = (error: unknown): error is McpHttpError | TypeError =>
  error instanceof McpHttpError
    ? error.status === HTTP_TIMEOUT ||
      error.status === HTTP_TOO_MANY ||
      (error.status >= HTTP_SERVER_ERROR &&
        error.status !== HTTP_NOT_IMPLEMENTED)
    : error instanceof TypeError;

class McpServerConnection {
  readonly name: string;
  readonly config: McpServerConfig;
  readonly #createTransport: McpTransportFactory;
  #client: McpClient | undefined;
  #opening: Promise<McpClient> | undefined;

  constructor(
    name: string,
    config: McpServerConfig,
    createTransport: McpTransportFactory
  ) {
    this.name = name;
    this.config = config;
    this.#createTransport = createTransport;
  }

  get timeoutMs(): number {
    return (this.config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  }

  async client(): Promise<McpClient> {
    if (this.#client?.connectionState === "connected") {
      return this.#client;
    }

    this.#opening ??= this.#open(0).finally(() => {
      this.#opening = undefined;
    });

    return await this.#opening;
  }

  async close(): Promise<void> {
    await this.#client?.close();
  }

  async #open(attempt: number): Promise<McpClient> {
    const client = new McpClient({ name: "shrok", version: "1.0.0" });

    try {
      await client.connect(this.#createTransport(this.name, this.config));
      this.#client = client;

      return client;
    } catch (error) {
      await client.close();

      const delay = CONNECT_RETRY_DELAYS_MS[attempt];

      if (delay === undefined || !isTransientError(error)) {
        throw error;
      }

      await sleep(delay);

      return await this.#open(attempt + 1);
    }
  }
}

const describeTool = (tool: McpTool, server: string): string => {
  const description = tool.description?.trim() ?? "";

  if (description !== "") {
    return description;
  }

  return tool.title ?? `MCP tool ${tool.name} from server ${server}`;
};

interface RegisteredTool {
  readonly connection: McpServerConnection;
  readonly tool: string;
}

/** No file means no MCP servers. */
const readConfig = (configFile: string): [string, McpServerConfig][] => {
  if (!existsSync(configFile)) {
    return [];
  }

  const file = Value.Parse(
    FileSchema,
    JSON.parse(readFileSync(configFile, "utf-8"))
  );

  for (const name of Object.keys(file.mcpServers)) {
    if (!SERVER_NAME.test(name)) {
      throw new Error(
        `invalid MCP server name "${name}" (use letters, digits, "_" and "-")`
      );
    }
  }

  return Object.entries(file.mcpServers).filter(
    ([, config]) => config.enabled !== false
  );
};

const listTools = async (
  connection: McpServerConnection
): Promise<McpTool[]> => {
  try {
    const client = await connection.client();

    return await client.listTools({ timeoutMs: connection.timeoutMs });
  } catch (error) {
    report(
      "mcp",
      `MCP server ${connection.name} did not start: ${String(error)}`
    );

    return [];
  }
};

/**
 * Connects to every enabled server in the config file. Each tool becomes a pi-durable tool named
 * `mcp__<server>__<tool>`, exposed the way its config says: to code mode scripts by default.
 */
export const connectMcpServers = async (
  configFile: string
): Promise<McpServers> => {
  const createTransport = createDefaultTransport(path.dirname(configFile));

  const connections = readConfig(configFile).map(
    ([name, config]) => new McpServerConnection(name, config, createTransport)
  );

  const listed = await Promise.all(
    connections.map(
      async (connection) => [connection, await listTools(connection)] as const
    )
  );

  const registered = new Map<string, RegisteredTool>();
  const tools: ToolRegistration[] = [];

  const call = async (
    name: string,
    args: JsonObject,
    options: McpCallOptions
  ): Promise<McpCallResult> => {
    const target = registered.get(name);

    if (target === undefined) {
      throw new Error(`No MCP tool named ${name}.`);
    }

    const client = await target.connection.client();

    const result = await client.callTool(target.tool, args, {
      onProgress: (progress) => {
        const total = progress.total === undefined ? "" : `/${progress.total}`;

        options.onProgress?.(
          progress.message ?? `Progress ${progress.progress}${total}`
        );
      },
      signal: options.signal,
      timeoutMs: target.connection.timeoutMs,
    });

    return convertMcpResult(target.connection.name, target.tool, result);
  };

  for (const [connection, serverTools] of listed) {
    for (const tool of serverTools) {
      const exposure = getMcpToolExposure(connection.config, tool.name);

      const name = createMcpToolName(connection.name, tool.name, (candidate) =>
        registered.has(candidate)
      );

      if (exposure !== "hidden") {
        try {
          const outputSchema =
            tool.outputSchema === undefined
              ? undefined
              : schemaJson(tool.outputSchema);

          tools.push(
            defineTool({
              ...EXPOSURE_FIELDS[exposure],
              description: describeTool(tool, connection.name),
              execute: async (args, api, context) => {
                const result = await call(name, args, {
                  onProgress: (text) => {
                    api.output(`${text}\n`);
                  },
                  signal: context.abortSignal,
                });

                return {
                  isError: result.isError,
                  output: result.output,
                  structuredOutput: result.structuredOutput,
                };
              },
              name,
              outputLimits: { maxBytes: MCP_OUTPUT_MAX_BYTES },
              parameters: toParameters(schemaJson(tool.inputSchema)),
              structuredOutputSchema: resultSchema(outputSchema),
            })
          );
          registered.set(name, { connection, tool: tool.name });
        } catch (error) {
          report("mcp", `MCP tool ${name} was skipped: ${String(error)}`);
        }
      }
    }
  }

  return {
    call,
    close: async () => {
      await Promise.allSettled(
        connections.map(async (connection) => {
          await connection.close();
        })
      );
    },
    namespaces: connections.map((connection) => ({
      description:
        connection.config.description ??
        `Tools of the ${connection.name} MCP server`,
      name: mcpNamespace(connection.name),
      prefix: `${mcpNamespace(connection.name)}__`,
    })),
    tools,
  };
};
