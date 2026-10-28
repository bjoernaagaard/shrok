import type { Context } from "@earendil-works/chord";
import { OutputBuffer } from "@earendil-works/chord/output";
import { Type } from "@earendil-works/pi-ai";
import type {
  Api,
  Model,
  Models,
  StreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Value } from "typebox/value";

import type { PublicWeb } from "./public-web.ts";
import type { SeenUrls } from "./seen-urls.ts";

const PAGE_CHARS = 40_000;
const PAGE_OUTPUT_MAX_BYTES = PAGE_CHARS * 4;
const FETCH_ERROR_MAX_BYTES = 8 * 1024;
const FETCH_OUTPUT_MAX_LINES = PAGE_CHARS;
const FETCH_TIMEOUT_SECONDS = 60;
const PROGRESS_INTERVAL_MS = 1000;

const SEARCH_INSTRUCTIONS =
  "You are a web search assistant. Search the web to find accurate, up-to-date information for the user's query. Provide a comprehensive summary with all relevant details, numbers, dates, and sources.";

const MAX_SEARCHES = 5;

const SourceSchema = Type.Object({
  title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  url: Type.String(),
});

const ResponsesOutputItemSchema = Type.Object({
  item: Type.Object({
    action: Type.Optional(
      Type.Object({
        sources: Type.Optional(
          Type.Array(
            Type.Object({
              title: Type.Optional(Type.String()),
              url: Type.String(),
            })
          )
        ),
      })
    ),
    content: Type.Optional(
      Type.Array(
        Type.Object({
          annotations: Type.Optional(
            Type.Array(
              Type.Object({
                title: Type.Optional(Type.String()),
                url: Type.Optional(Type.String()),
              })
            )
          ),
        })
      )
    ),
  }),
  type: Type.Literal("response.output_item.done"),
});

const AnthropicSearchResultSchema = Type.Object({
  content_block: Type.Object({
    content: Type.Union([
      Type.Array(SourceSchema),
      Type.Object({ error_code: Type.String() }),
    ]),
    type: Type.Literal("web_search_tool_result"),
  }),
  type: Type.Literal("content_block_start"),
});

const AnthropicCitationSchema = Type.Object({
  delta: Type.Object({
    citation: SourceSchema,
    type: Type.Literal("citations_delta"),
  }),
  type: Type.Literal("content_block_delta"),
});

const PayloadSchema = Type.Object({
  tool_choice: Type.Optional(Type.Unknown()),
  tools: Type.Optional(Type.Array(Type.Unknown())),
});

interface SearchFound {
  readonly source: (url: string, title: string | null | undefined) => void;
  readonly failure: (code: string) => void;
}

type ProviderEvent = Parameters<
  NonNullable<StreamOptions["onProviderStreamEvent"]>
>[0];

/** One API's own web search tool, as its provider documents it. */
interface SearchTool {
  readonly tool: object;
  readonly toolChoice?: string;
  readonly read: (event: ProviderEvent, found: SearchFound) => void;
}

const SEARCH_TOOLS: Readonly<Partial<Record<Api, SearchTool>>> = {
  "anthropic-messages": {
    read: (event, found) => {
      if (Value.Check(AnthropicSearchResultSchema, event)) {
        const { content } = event.content_block;

        if (Array.isArray(content)) {
          for (const result of content) {
            found.source(result.url, result.title);
          }
        } else {
          found.failure(content.error_code);
        }
      }

      if (Value.Check(AnthropicCitationSchema, event)) {
        found.source(event.delta.citation.url, event.delta.citation.title);
      }
    },
    tool: {
      max_uses: MAX_SEARCHES,
      name: "web_search",
      type: "web_search_20250305",
    },
  },
  "openai-responses": {
    read: (event, found) => {
      if (!Value.Check(ResponsesOutputItemSchema, event)) {
        return;
      }

      for (const source of event.item.action?.sources ?? []) {
        found.source(source.url, source.title);
      }

      for (const part of event.item.content ?? []) {
        for (const note of part.annotations ?? []) {
          if (note.url !== undefined) {
            found.source(note.url, note.title);
          }
        }
      }
    },
    tool: { type: "web_search" },
    toolChoice: "required",
  },
};

interface WebSource {
  readonly url: string;
  readonly title: string;
}

export interface WebSearchResult {
  readonly text: string;
  readonly sources: WebSource[];
  readonly usage: Usage;
}

interface WebSearchOptions {
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: (text: string) => void;
}

const instructions = (now: Date): string =>
  `${SEARCH_INSTRUCTIONS}\nCurrent reference date: ${now.toISOString().slice(0, 10)}. Use this reference date to ground relative time expressions (such as today, yesterday, recent, latest, or this year) and ensure search queries and results remain up to date.`;

const webSearch = async (
  models: Models,
  model: Model<Api>,
  query: string,
  options: WebSearchOptions = {}
): Promise<WebSearchResult> => {
  const search = SEARCH_TOOLS[model.api];

  if (search === undefined) {
    throw new Error(
      `web_search needs SHROK_SMALL_MODEL on the Anthropic Messages or OpenAI Responses API, which have their own search tool. ${model.provider}/${model.id} uses ${model.api}.`
    );
  }

  const sources = new Map<string, string>();
  const failures: string[] = [];
  let lastProgress = 0;

  const found: SearchFound = {
    failure: (code) => {
      failures.push(code);
    },
    source: (url, title) => {
      sources.set(url, title ?? sources.get(url) ?? "");
    },
  };

  const stream = models.streamSimple(
    model,
    {
      messages: [{ content: query, role: "user", timestamp: Date.now() }],
      systemPrompt: instructions(new Date()),
    },
    {
      onPayload: (payload) => {
        if (Value.Check(PayloadSchema, payload)) {
          payload.tools = [...(payload.tools ?? []), search.tool];

          if (search.toolChoice !== undefined) {
            payload.tool_choice = search.toolChoice;
          }
        }

        return payload;
      },
      onProviderStreamEvent: (event) => {
        search.read(event, found);
      },
      signal: options.signal,
    }
  );

  for await (const event of stream) {
    if (
      event.type === "text_delta" &&
      Date.now() - lastProgress >= PROGRESS_INTERVAL_MS
    ) {
      lastProgress = Date.now();
      options.onProgress?.(
        `Summarizing results (${event.partial.content.length} parts)...`
      );
    }
  }

  const reply = await stream.result();

  if (reply.stopReason === "error" || reply.stopReason === "aborted") {
    throw new Error(
      `Web search failed: ${reply.errorMessage ?? reply.stopReason}`
    );
  }

  const text = reply.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();

  if (sources.size === 0 && failures.length > 0) {
    throw new Error(`Web search failed: ${failures.join(", ")}`);
  }

  if (text === "") {
    throw new Error("Web search completed without any search result text");
  }

  return {
    sources: [...sources].map(([url, title]) => ({ title, url })),
    text,
    usage: reply.usage,
  };
};

const withSources = ({ sources, text }: WebSearchResult): string =>
  sources.length === 0 || text.includes("http")
    ? text
    : `${text}\n\nSources:\n${sources.map(({ title, url }, index) => `${index + 1}. ${title === "" ? url : title}: ${url}`).join("\n")}`;

const fetchPage = async (
  env: ExecutionEnv | undefined,
  url: string,
  context: Context,
  publicWeb: PublicWeb
): Promise<string> => {
  if (env === undefined) {
    throw new Error("web_fetch needs an execution environment.");
  }

  const output = new OutputBuffer({
    maxBytes: PAGE_OUTPUT_MAX_BYTES,
    maxLines: FETCH_OUTPUT_MAX_LINES,
    retain: "head",
  });

  const errors = new OutputBuffer({
    maxBytes: FETCH_ERROR_MAX_BYTES,
    maxLines: FETCH_OUTPUT_MAX_LINES,
    retain: "tail",
  });

  const { argv, done } = publicWeb.fetchArgs(url);

  const result = await env
    .exec(
      argv,
      {
        env: publicWeb.fetchEnv,
        inheritEnv: false,
        onOutput: (chunk, _context, { stream }) => {
          (stream === "stdout" ? output : errors).push(chunk);
        },
        timeout: FETCH_TIMEOUT_SECONDS,
      },
      context
    )
    .finally(done);

  output.end();
  errors.end();

  if (!result.ok || result.value.exitCode !== 0) {
    const lines = errors
      .snapshot()
      .text.split("\n")
      .filter((line) => line.trim() !== "");

    const reason =
      lines.findLast((line) => line.startsWith("Error:")) ?? lines.at(-1) ?? "";

    throw new Error(`Could not load ${url}. ${reason}`.trim());
  }

  const page = output.snapshot();

  return page.droppedBytes > 0 || page.text.length > PAGE_CHARS
    ? `${page.text.slice(0, PAGE_CHARS)}\n[... page cut at ${PAGE_CHARS} characters]`
    : page.text;
};

export const createWebTools = (
  searchModel: Model<Api>,
  publicWeb: PublicWeb,
  seenUrls: SeenUrls
) => [
  defineTool({
    description:
      "Search the web and get a short answer with its sources. Use it for anything current or anything you don't know.",
    execute: async (args, api, context) => {
      const result = await webSearch(api.models, searchModel, args.query, {
        onProgress: (text) => {
          api.output(`${text}\n`);
        },
        signal: context.abortSignal,
      });

      // Only the sources: the answer is a model's text, which could repeat an address the query made up.
      seenUrls.note(result.sources.map(({ url }) => url).join("\n"));

      return {
        output: [{ text: withSources(result), type: "text" as const }],
        usage: result.usage,
      };
    },
    name: "web_search",
    parameters: Type.Object({
      query: Type.String({ description: "What to find out, in plain words" }),
    }),
    replay: "safe",
  }),
  defineTool({
    description:
      "Open one web page and get its text as Markdown. Use it to read a page from a search result or a link. An address that neither the owner nor a tool gave waits for his /yes.",
    execute: async (args, api, context) => {
      const page = await seenUrls.open(
        api,
        "web_fetch",
        args.url,
        async () => await fetchPage(api.env, args.url, context, publicWeb),
        context
      );

      seenUrls.note(page, args.url);

      return { output: [{ text: page, type: "text" as const }] };
    },
    name: "web_fetch",
    parameters: Type.Object({
      url: Type.String({ description: "The page's full http(s) URL" }),
    }),
    replay: "safe",
  }),
];
