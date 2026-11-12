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
    program: "gws",
    skills: ["calendar", "drive", "gmail"],
  },
  {
    description:
      "X (Twitter) API, like curl: `xurl /2/tweets/<id>`. Run `xurl --help` first. Each post read costs money.",
    keys: ["XURL_CLIENT_ID", "XURL_CLIENT_SECRET"],
    name: "x",
    program: "xurl",
    skills: ["x-posts"],
  },
] as const;

export type Integration = (typeof INTEGRATIONS)[number]["name"];

export type Program = (typeof INTEGRATIONS)[number]["program"];

/** The model providers' keys and addresses, which pi-ai and models.ts read from the environment. */
const MODEL_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
] as const;

/** Every secret Shrok reads. Other `_FILE` variables, such as HISTFILE, are not Shrok's to read. */
export const SECRETS: readonly string[] = [
  ...MODEL_KEYS,
  ...INTEGRATIONS.flatMap(({ keys }) => keys),
];
