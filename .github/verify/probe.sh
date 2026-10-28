#!/bin/sh
# Prints one line for each part of the runtime that needs the kernel's help: bubblewrap, srt running Obscura,
# and Chromium's own sandbox. Runs on a host and inside the image.
#   CHROME  the browser binary
#   PW      path to playwright-core's index.mjs
#   SRT     the srt binary

printf 'bwrap: '
if command -v bwrap >/dev/null; then
  bwrap --unshare-user --unshare-net --unshare-pid --die-with-parent --ro-bind / / --proc /proc --dev /dev \
    --tmpfs /tmp echo ok 2>&1 | head -n 1
else
  echo "not used on this system"
fi

printf 'srt running obscura fetch: '
scratch=$(cd "$(mktemp -d)" && pwd -P)
printf '{"network":{"allowedDomains":["example.com"],"deniedDomains":[]},"filesystem":{"allowRead":["%s"],"allowWrite":["%s"],"denyRead":[],"denyWrite":[]}}' \
  "$(dirname "$(command -v obscura)")" "$scratch" >"$scratch/srt.json"
# Obscura refuses a proxy named localhost, so the proxy srt hands the sandbox is named by IP.
fetched=$("$SRT" --settings "$scratch/srt.json" -- sh -c \
  'obscura fetch --proxy "$(echo "$HTTPS_PROXY" | sed s/@localhost:/@127.0.0.1:/)" --dump text https://example.com 2>&1' 2>&1)
# Obscura warns about a page's own failed scripts, so the page loading is looked for first.
echo "$fetched" | grep -m 1 "Page loaded" || echo "$fetched" | grep -E -m 1 "bwrap|denied|ermission|rror" || echo "no output"

printf 'chromium sandbox: '
node --input-type=module -e "
const { chromium } = await import(process.env.PW);
try {
  const browser = await chromium.launch({ chromiumSandbox: true, executablePath: process.env.CHROME, headless: true });
  const page = await browser.newPage();
  await page.goto('https://example.com');
  console.log('ok, ' + (await page.title()) + ', ' + browser.version());
  await browser.close();
} catch (error) {
  const lines = String(error.message).split('\n');
  console.log('failed, ' + (lines.find((line) => /sandbox|namespace/i.test(line)) ?? lines[0]));
}" 2>&1 | tail -n 1
