import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";

import { Asked, typedOutcome } from "./approvals.ts";
import type { Approvals } from "./approvals.ts";
import type { ShrokTool } from "./policy.ts";
import { programJson } from "./programs.ts";

const POST_ID = /^(?<bare>\d{1,20})$|\/status(?:es)?\/(?<linked>\d{1,20})/u;

const PostResponse = Type.Object({
  data: Type.Optional(
    Type.Object({
      author_id: Type.String(),
      created_at: Type.String(),
      id: Type.String(),
      note_tweet: Type.Optional(Type.Object({ text: Type.String() })),
      text: Type.String(),
    })
  ),
  errors: Type.Optional(Type.Array(Type.Object({ detail: Type.String() }))),
  includes: Type.Optional(
    Type.Object({
      users: Type.Array(
        Type.Object({
          id: Type.String(),
          name: Type.String(),
          username: Type.String(),
        })
      ),
    })
  ),
});

const PostOutput = Type.Object({
  author: Type.String(),
  id: Type.String(),
  posted: Type.String(),
  text: Type.String(),
  url: Type.String(),
});

export const createXTools = (approvals: Approvals): ShrokTool[] => [
  {
    flow: true,
    phrase: "reading a post on X",
    tool: defineTool({
      description:
        "Read one post on X: its author, date and full text. Give the x.com or twitter.com link or the post's id. Each read costs the user money and, unless he allowed reads for good, waits for his /yes for that exact post, so search the saved items first.",
      execute: async (args, api) => {
        const match = POST_ID.exec(args.post.trim())?.groups;
        const id = match?.bare ?? match?.linked;

        if (id === undefined) {
          throw new Error(
            `${args.post} is not a link to a post on X or a post's id.`
          );
        }

        return typedOutcome(
          PostOutput,
          await approvals.request(api, () => ({
            arguments: { post: id },
            grants: ["paid X API reads of posts"],
            run: async ({ context, env }) => {
              const response = await programJson(
                "xurl",
                PostResponse,
                env,
                [
                  `/2/tweets/${id}?tweet.fields=created_at,note_tweet&expansions=author_id&user.fields=username,name`,
                ],
                context
              );

              const post = response.data;

              if (post === undefined) {
                throw new Error(
                  `X could not return post ${id}: ${response.errors?.[0]?.detail ?? "no reason given"}`
                );
              }

              const author = response.includes?.users.find(
                (user) => user.id === post.author_id
              );

              return {
                author:
                  author === undefined
                    ? post.author_id
                    : `${author.name} (@${author.username})`,
                id: post.id,
                posted: post.created_at,
                // A long post's full text is only in note_tweet; `text` stops at 280 characters.
                text: post.note_tweet?.text ?? post.text,
                url: `https://x.com/${author?.username ?? "i"}/status/${post.id}`,
              };
            },
            state: {},
            summary: `make one paid X API read of post ${id} at https://x.com/i/status/${id}`,
            tool: "x_read_post",
          }))
        );
      },
      name: "x_read_post",
      parameters: Type.Object({
        post: Type.String({
          description: "The post's x.com or twitter.com link, or its id",
        }),
      }),
      replay: "unsafe",
      structuredOutputSchema: Type.Union([PostOutput, Asked]),
    }),
  },
];
