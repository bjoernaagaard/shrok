/** Programs that act with the owner's own login. Each is offered only when installed and all its keys are set. */
export const INTEGRATIONS = [
  {
    description:
      "Google Workspace: Gmail, Calendar, Drive. Run `gws --help` or `gws <service> --help` first.",
    keys: [
      "GOOGLE_WORKSPACE_CLI_CLIENT_ID",
      "GOOGLE_WORKSPACE_CLI_CLIENT_SECRET",
    ],
    name: "google",
    phrase: "using Google",
    program: "gws",
    skills: ["calendar", "drive", "gmail"],
  },
  {
    description:
      "X (Twitter) API, like curl: `xurl /2/tweets/<id>`. Run `xurl --help` first. Each post read costs money.",
    keys: ["XURL_CLIENT_ID", "XURL_CLIENT_SECRET"],
    name: "x",
    phrase: "using X",
    program: "xurl",
    skills: ["x-posts"],
  },
] as const;

export type Integration = (typeof INTEGRATIONS)[number]["name"];

export type Program = (typeof INTEGRATIONS)[number]["program"];

/** The model providers, with the key pi-ai reads and the base URL setting models.ts reads. */
export const MODEL_PROVIDERS = [
  {
    baseUrl: "ANTHROPIC_BASE_URL",
    key: "ANTHROPIC_API_KEY",
    provider: "anthropic",
  },
  { baseUrl: "OPENAI_BASE_URL", key: "OPENAI_API_KEY", provider: "openai" },
] as const;

/** Every secret Shrok reads. Other `_FILE` variables, such as HISTFILE, are not Shrok's to read. */
export const SECRETS: readonly string[] = [
  ...MODEL_PROVIDERS.flatMap(({ baseUrl, key }) => [key, baseUrl]),
  ...INTEGRATIONS.flatMap(({ keys }) => keys),
];
