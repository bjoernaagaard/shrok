import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { Static } from "typebox";

import type { Approvals } from "./approvals.ts";
import { programJson, typed } from "./programs.ts";

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

export const createXTools = (approvals: Approvals) => [
  defineTool({
    description:
      "Read one post on X: its author, date and full text. Give the x.com or twitter.com link or the post's id. Each read costs the user money and waits for the owner's /yes for that exact post, so search the saved items first.",
    execute: async (args, api, context) => {
      const match = POST_ID.exec(args.post.trim())?.groups;
      const id = match?.bare ?? match?.linked;

      if (id === undefined) {
        throw new Error(
          `${args.post} is not a link to a post on X or a post's id.`
        );
      }

      let response: Static<typeof PostResponse> | undefined;

      await approvals.execute(
        api,
        () => ({
          adapter: "x-read-post-v1" as const,
          arguments: { post: id },
          expectedState: {},
          identity: { program: "xurl" },
          payload: {
            argv: [
              `/2/tweets/${id}?tweet.fields=created_at,note_tweet&expansions=author_id&user.fields=username,name`,
            ],
          },
          resource: { postId: id },
          summary: `make one paid X API read of post ${id} at https://x.com/i/status/${id}`,
          tool: "x_read_post" as const,
        }),
        async (action) => {
          response = await programJson(
            "xurl",
            PostResponse,
            api.env,
            action.payload.argv,
            context
          );
        },
        context.abortSignal
      );

      if (response === undefined) {
        throw new Error("The approved X read did not return a response.");
      }

      const post = response.data;

      if (post === undefined) {
        throw new Error(
          `X could not return post ${id}: ${response.errors?.[0]?.detail ?? "no reason given"}`
        );
      }

      const author = response.includes?.users.find(
        (user) => user.id === post.author_id
      );

      return typed(PostOutput, {
        author:
          author === undefined
            ? post.author_id
            : `${author.name} (@${author.username})`,
        id: post.id,
        posted: post.created_at,
        // A long post's full text is only in note_tweet; `text` stops at 280 characters.
        text: post.note_tweet?.text ?? post.text,
        url: `https://x.com/${author?.username ?? "i"}/status/${post.id}`,
      });
    },
    name: "x_read_post",
    parameters: Type.Object({
      post: Type.String({
        description: "The post's x.com or twitter.com link, or its id",
      }),
    }),
    replay: "unsafe",
    structuredOutputSchema: PostOutput,
  }),
];
