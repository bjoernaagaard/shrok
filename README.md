# Shrok

Shrok is a personal assistant that runs on your own computer or server and that you talk to through [SimpleX Chat](https://simplex.chat) on your phone. It answers questions, remembers what matters, saves the links and files you share, runs reminders on a schedule, and reads the web for you. With Google or X set up, it can also read your mail and calendar, draft replies, and read posts.

Shrok asks before it does anything that leaves a trace outside your machine, such as booking or buying. You approve with a 👍 on the request it sends you.

## What you need

- An API key from [Anthropic](https://console.anthropic.com) or [OpenAI](https://platform.openai.com).
- SimpleX Chat on your phone.
- A Mac with Apple silicon or Intel, or Linux on amd64 or arm64. On Linux, Shrok's sandbox needs user namespaces.

## Install

| Where | How | Guide |
| --- | --- | --- |
| Mac | `brew install bjoernaagaard/shrok/shrok` | [docs/setup.md](docs/setup.md#homebrew) |
| Debian or Ubuntu | the `.deb` from the apt repository | [docs/setup.md](docs/setup.md#debian-and-ubuntu) |
| Docker | `ghcr.io/bjoernaagaard/shrok` with `packaging/oci/compose.yaml` | [docs/setup.md](docs/setup.md#docker) |
| Any Linux or Mac | the portable archive from the releases page | [docs/setup.md](docs/setup.md#portable-archive) |

Then pair your phone using the command for your installation in [docs/pairing.md](docs/pairing.md).

## Settings

Shrok reads its settings from the environment.

| Setting | What it does | Default |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` | The model key. Shrok needs one of them. |  |
| `SHROK_TIME_ZONE` | The zone for schedules and calendar times, such as `Europe/Copenhagen` | the system's zone |
| `SHROK_LOCALE` | The language for dates, such as `en-GB` | `LC_ALL`, `LC_TIME` or `LANG`, then macOS's region |
| `SHROK_DATA_DIR` | Where Shrok keeps chats, memory and its SimpleX keys | `/var/lib/shrok` on Linux, `~/Library/Application Support/Shrok` on macOS |
| `SHROK_MODEL`, `SHROK_SMALL_MODEL`, `SHROK_CLASSIFIER` | The models, as `provider/model` | chosen by which key is set |
| `SHROK_MCP_CONFIG` | An `mcp.json` listing MCP servers | `mcp.json` in the data folder |
| `SHROK_BROWSER` | A Chromium binary to use instead of the bundled one |  |

Any key can come from a file instead: set `ANTHROPIC_API_KEY_FILE` to its path, or use a systemd credential of the same name.

## Guides

- [Setup](docs/setup.md)
- [Pairing your phone](docs/pairing.md)
- [Backing up](docs/backup.md)
- [Upgrading](docs/upgrade.md)
- [Google: Gmail and Calendar](docs/google.md)
- [X posts](docs/x.md)

## License

Shrok is free software under the [GNU Affero General Public License 3.0](LICENSE).
