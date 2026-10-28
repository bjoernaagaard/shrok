#!/bin/sh
# Builds the public Shrok app for this machine's platform into $1:
#
#   $1/app/       src, skills, package.json and production node_modules, without any local extension files
#   $1/node/      Node, the version in mise.toml, checked against packaging/checksums.txt
#   $1/bin/       shrok, and Obscura, checked against packaging/checksums.txt
#   $1/lib/       libsimplex and its Node add-on, checked against simplex-chat's pinned hashes
#   $1/browsers/  Playwright's headless shell, checked against packaging/checksums.txt, unless $2 is "system-browser"
#
# Without SHROK_DATA_DIR, the shrok wrapper keeps data in /var/lib/shrok on Linux, where systemd's StateDirectory
# puts it, and in ~/Library/Application Support/Shrok on macOS.
set -eu

out=$1
browser=${2:-bundled}
root=$(cd "$(dirname "$0")/.." && pwd)
node_version=$(sed -n 's/^node = "\(.*\)"$/\1/p' "$root/mise.toml")
obscura_version=v0.2.5
pnpm_version=$(sed -n 's/.*"packageManager": "pnpm@\(.*\)".*/\1/p' "$root/package.json")

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) node_platform=darwin-arm64 obscura_platform=aarch64-macos shell_platform=mac-arm64 ;;
  Darwin-x86_64) node_platform=darwin-x64 obscura_platform=x86_64-macos shell_platform=mac-x64 ;;
  Linux-aarch64) node_platform=linux-arm64 obscura_platform=aarch64-linux shell_platform=linux-arm64 ;;
  Linux-x86_64) node_platform=linux-x64 obscura_platform=x86_64-linux shell_platform=linux64 ;;
  *) echo "app.sh: unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

case "$(uname -s)" in
  Darwin) default_data='$HOME/Library/Application Support/Shrok' ;;
  *) default_data=/var/lib/shrok ;;
esac

if command -v sha256sum >/dev/null; then
  sha256="sha256sum"
else
  sha256="shasum -a 256"
fi

downloads=$(mktemp -d)
trap 'rm -rf "$downloads"' EXIT

# Downloads $1 as $downloads/$2 and stops unless it matches its line in packaging/checksums.txt.
fetch() {
  curl -fsSL -o "$downloads/$2" "$1"
  line=$(awk -v name="$2" '$2 == name' "$root/packaging/checksums.txt")

  if [ -z "$line" ]; then
    echo "app.sh: packaging/checksums.txt has no SHA-256 for $2" >&2
    exit 1
  fi

  if ! (cd "$downloads" && printf '%s\n' "$line" | $sha256 -c - >/dev/null); then
    echo "app.sh: $2 does not match its SHA-256 in packaging/checksums.txt" >&2
    exit 1
  fi
}

rm -rf "$out"
mkdir -p "$out/app" "$out/bin" "$out/lib" "$out/node"

# Node: use the exact version pinned in mise.toml.
node_release=v$node_version
fetch "https://nodejs.org/dist/$node_release/node-$node_release-$node_platform.tar.xz" "node-$node_release-$node_platform.tar.xz"
tar -xJ -C "$out/node" --strip-components 1 -f "$downloads/node-$node_release-$node_platform.tar.xz"
rm -rf "$out/node/include" "$out/node/share" "$out/node/lib/node_modules/corepack"
node="$out/node/bin/node"

cp -R "$root/src" "$root/skills" "$root/package.json" "$root/pnpm-lock.yaml" "$root/pnpm-workspace.yaml" \
  "$root/LICENSE" "$root/secretspec.toml" "$out/app/"
rm -rf "$out/app/src/tools/local.ts" "$out/app/skills/local"

# pnpm is installed outside the app: npm refuses to run inside it, as package.json's devEngines names pnpm.
tools=$(mktemp -d)
(cd "$tools" && PATH="$out/node/bin:$PATH" "$node" "$out/node/lib/node_modules/npm/bin/npm-cli.js" install --global \
  --prefix "$tools" --silent "pnpm@$pnpm_version")
(cd "$out/app" && PATH="$out/node/bin:$PATH" "$tools/bin/pnpm" install --prod --frozen-lockfile --config.node-linker=hoisted)
rm -rf "$tools"
# Nothing at runtime calls npm: Shrok, srt and the bundled tools all run under Node itself. npm was
# only the way in for pnpm above, and its 144 bundled packages would otherwise ship (and age) for no
# use, so the built Node keeps its runtime and drops its package manager.
rm -rf "$out/node/lib/node_modules/npm"
rm -f "$out/node/bin/npm" "$out/node/bin/npx"
# pnpm leaves its workspace state behind, holding the build machine's absolute app path. It is install
# bookkeeping, not runtime code, so it must not ship. Source maps disclose dependency source layout,
# and upstream test directories are development files. Neither is read at runtime.
rm -f "$out/app/node_modules/.pnpm-workspace-state-v1.json"
find "$out/app/node_modules" -type d \( -name test -o -name tests -o -name __tests__ \) -prune -exec rm -rf {} +
find "$out/app/node_modules" -type f -name '*.map' -delete
# One upstream package ships its package.json executable. Data files never need the execute bit.
find "$out/app/node_modules" -type f -name '*.json' -exec chmod 0644 {} +

fetch "https://github.com/h4ckf0r0day/obscura/releases/download/$obscura_version/obscura-$obscura_platform.tar.gz" \
  "obscura-$obscura_version-$obscura_platform.tar.gz"
tar -xz -C "$out/bin" -f "$downloads/obscura-$obscura_version-$obscura_platform.tar.gz"

(cd "$out/app" && XDG_CACHE_HOME="$out/lib/cache" "$node" --input-type=commonjs -e '
  const libs = require("simplex-chat/dist/libs.js");
  const fs = require("node:fs");
  (async () => {
    fs.cpSync(await libs.resolveLibsDir("sqlite"), process.argv[1] + "/simplex", { recursive: true });
    fs.copyFileSync(await libs.resolveAddonPath(), process.argv[1] + "/simplex-addon.node");
  })();' "$out/lib")
rm -rf "$out/lib/cache"

browser_line=""
if [ "$browser" = bundled ]; then
  # The headless shell playwright-core expects, fetched here because Playwright's installer checks only its size.
  shell_version=$("$node" -p 'require(process.argv[1]).browsers.find((b) => b.name === "chromium-headless-shell").browserVersion' \
    "$out/app/node_modules/playwright-core/browsers.json")
  fetch "https://cdn.playwright.dev/builds/cft/$shell_version/$shell_platform/chrome-headless-shell-$shell_platform.zip" \
    "chrome-headless-shell-$shell_version-$shell_platform.zip"
  mkdir -p "$out/browsers"
  unzip -q "$downloads/chrome-headless-shell-$shell_version-$shell_platform.zip" -d "$out/browsers"
  shell=browsers/chrome-headless-shell-$shell_platform/chrome-headless-shell
  browser_line="export SHROK_BROWSER=\"\${SHROK_BROWSER:-\$here/$shell}\""
fi

cat >"$out/bin/shrok" <<EOF
#!/bin/sh
# Runs the bundled Shrok.
here=\$(cd "\$(dirname "\$(readlink -f "\$0")")/.." && pwd)
export SIMPLEX_LIBS_DIR="\$here/lib/simplex"
export SIMPLEX_ADDON_PATH="\$here/lib/simplex-addon.node"
export SHROK_DATA_DIR="\${SHROK_DATA_DIR:-$default_data}"
$browser_line
# Node too: srt, the sandbox around bash and web_fetch, starts with #!/usr/bin/env node.
export PATH="\$here/bin:\$here/node/bin:\$PATH"
exec "\$here/node/bin/node" "\$here/app/src/cli.ts" "\$@"
EOF
chmod 0755 "$out/bin/shrok"

echo "app.sh: built Shrok $("$node" -p 'require(process.argv[1]).version' "$root/package.json") for $node_platform with Node $node_release in $out"
