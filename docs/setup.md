# Setup

Pick one way to install. Each ends with Shrok running and waiting for your phone. Then follow [pairing.md](pairing.md).

## Homebrew

On a Mac:

```sh
brew install bjoernaagaard/shrok/shrok
$(brew --prefix secretspec)/bin/secretspec set -f $(brew --prefix)/var/shrok/app/app/secretspec.toml \
  --provider keyring:// ANTHROPIC_API_KEY
brew services start shrok
shrok pair
```

The key goes into your login Keychain. Store it with Homebrew's `secretspec`, as above, because that is the one the service runs. Then macOS lets the service read the key without asking. To use OpenAI instead, store `OPENAI_API_KEY`.

Shrok logs to `$(brew --prefix)/var/log/shrok.log` and keeps its data in `~/Library/Application Support/Shrok`.

## Debian and Ubuntu

Add the repository, then install:

```sh
curl -fsSL https://bjoernaagaard.github.io/shrok/shrok-archive-key.asc |
  sudo tee /etc/apt/keyrings/shrok.asc >/dev/null
echo "deb [signed-by=/etc/apt/keyrings/shrok.asc] https://bjoernaagaard.github.io/shrok stable main" |
  sudo tee /etc/apt/sources.list.d/shrok.list
sudo apt update
sudo apt install shrok
```

Store the key as an encrypted systemd credential, set the time zone and locale, and start Shrok:

```sh
echo -n 'sk-ant-...' | sudo systemd-creds encrypt --name=ANTHROPIC_API_KEY - /etc/credstore.encrypted/ANTHROPIC_API_KEY
printf 'SHROK_TIME_ZONE=Europe/Copenhagen\nSHROK_LOCALE=en-GB\n' | sudo tee /etc/shrok/env
sudo systemctl enable --now shrok
sudo -u shrok shrok pair
```

Shrok runs as the user `shrok`, keeps its data in `/var/lib/shrok`, and logs to the journal: `journalctl -u shrok`. The package loads an AppArmor profile selected only by Shrok's systemd service. On Ubuntu 24.04 and later, it lets the service and its children make the user namespaces their sandboxes need. It does not attach to the system bubblewrap executable or grant namespaces to other users. A second, inactive profile replaces the browser attachment used by older packages.

## Docker

Create a fresh private deployment folder with `PRIVATE_DIRECTORY_MODE=0700; mkdir -m "$PRIVATE_DIRECTORY_MODE" shrok-deploy`. Copy `compose.yaml`, `seccomp.json` and the `apparmor` folder from [packaging/oci](../packaging/oci) into it. Run these commands inside that folder:

```sh
PRIVATE_DIRECTORY_MODE=0700
PRIVATE_SECRET_MODE=0400
SHROK_UID=10001
SHROK_GID=10001
mkdir -m "$PRIVATE_DIRECTORY_MODE" secrets
printf %s 'sk-ant-...' | sudo install -o "$SHROK_UID" -g "$SHROK_GID" -m "$PRIVATE_SECRET_MODE" /dev/stdin secrets/ANTHROPIC_API_KEY
printf 'SHROK_TIME_ZONE=Europe/Copenhagen\nSHROK_LOCALE=en-GB\n' >.env
sudo apparmor_parser -r -W apparmor/shrok-container   # only on hosts with AppArmor, such as Ubuntu
docker compose up -d
docker compose exec shrok shrok pair
```

The secret file is owned by the image's user, UID 10001, and is readable only by that user. The private host directories prevent other host users from reaching it. Compose binds this file without changing its host ownership or permissions.

On Docker Desktop or OrbStack, which have no AppArmor, delete the `apparmor=shrok-container` line from `compose.yaml`.

Shrok's sandbox and browser need user namespaces. Docker's default seccomp profile blocks them, so the image runs with `seccomp.json`. That profile is Docker's own with five more system calls allowed: `clone`, `unshare`, `mount`, `umount2` and `pivot_root`. It also needs `systempaths=unconfined` so the sandbox can mount its own `/proc`. It never needs `--privileged`. The image has no time zone of its own, so set `SHROK_TIME_ZONE`.

The image has no Google or X programs. To use them, build an image on top of it that installs `gws` or `xurl`.

## Portable archive

Download `shrok-<version>-<os>-<arch>.tar.gz` from the releases page. It holds Shrok, Node, Obscura, SimpleX's library and a headless browser.

```sh
sudo tar --no-same-owner --no-same-permissions -xzf shrok-*-linux-*.tar.gz -C /opt
sudo mv /opt/shrok-*-linux-* /opt/shrok
sudo chown -R root:root /opt/shrok
sudo apt install bubblewrap socat ripgrep                # or your system's packages
sudo apparmor_parser -r /opt/shrok/share/apparmor/*      # Ubuntu 24.04 and later
ANTHROPIC_API_KEY=sk-ant-... SHROK_DATA_DIR=~/shrok /opt/shrok/bin/shrok run
```

On Ubuntu 24.04 and later, use the bundled systemd unit to select the service's AppArmor profile. For a foreground run on those hosts, install `apparmor-utils` and replace the final command above with `ANTHROPIC_API_KEY=sk-ant-... SHROK_DATA_DIR=~/shrok aa-exec -p shrok-bwrap -- /opt/shrok/bin/shrok run`. This explicitly selects the profile for that invocation without changing other users' bubblewrap policy.

On Linux, the browser needs the system libraries the `.deb` lists, which most desktop systems have. A systemd unit for `/opt/shrok` is in `share/systemd/shrok.service`. It runs Shrok as the user `shrok`, so create that user first.

On a Mac, unpack the archive in a folder you own and start it from there:

```sh
tar -xzf shrok-*-macos-*.tar.gz
ANTHROPIC_API_KEY=sk-ant-... ./shrok-*-macos-*/bin/shrok run
```

Leave it running and use its full path to pair in another terminal, as shown in [pairing.md](pairing.md). If you set `SHROK_DATA_DIR`, set it to the same path in both terminals. The first start after unpacking takes longer, while macOS checks the new programs.

## CI verification credentials

Before enabling the `verify` workflow, create a GitHub environment named `verification` in the repository's Settings. Require a trusted reviewer, prevent self-review and disable administrator bypass. Put `ANTHROPIC_API_KEY` and `TYPESAFE_API_KEY` only in that environment, not in repository or organization secrets available to branch workflows. Review the exact source commit before approving a run. Both verification jobs require this environment. Model keys are passed only to their browser security steps on manual runs of `main`. Pushes to verification branches run without model keys.
