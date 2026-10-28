#!/bin/sh
# Starts the real Shrok with a placeholder model key, reports whether it got ready, checks that shrok pair
# reaches it and prints an invite, then stops Shrok with SIGTERM and times the shutdown. No link is printed.
#   SHROK  the shrok command, such as bin/shrok. Default: node src/cli.ts

shrok=${SHROK:-node src/cli.ts}
data=$(mktemp -d)
export ANTHROPIC_API_KEY=placeholder SHROK_TIME_ZONE=${SHROK_TIME_ZONE:-Europe/Copenhagen} \
  SHROK_LOCALE=${SHROK_LOCALE:-en-GB} SHROK_DATA_DIR="$data"

# shellcheck disable=SC2086
$shrok run >"$data/out" 2>"$data/err" &
pid=$!
waited=0

while [ "$waited" -lt 120 ] && ! grep -q 'Shrok is ready' "$data/err" && kill -0 "$pid" 2>/dev/null; do
  sleep 1
  waited=$((waited + 1))
done

if grep -q 'Shrok is ready' "$data/err"; then
  echo "shrok: ready after ${waited}s"
else
  echo "shrok: did not get ready"
fi

# shellcheck disable=SC2086
$shrok pair >"$data/pair" 2>&1 &
pair=$!
sleep 5
kill "$pair" 2>/dev/null
wait "$pair" 2>/dev/null

if grep -q '15 minutes:' "$data/pair"; then
  echo "shrok pair: printed an invite"
else
  echo "shrok pair: no invite: $(head -n 1 "$data/pair")"
fi

stopped=$(date +%s)
kill -TERM "$pid" 2>/dev/null
wait "$pid"
echo "shrok: exit $? after $(($(date +%s) - stopped))s of SIGTERM"

if grep -q 'simplex.im' "$data/out" "$data/err"; then
  echo "shrok: FAILED, an invite link reached Shrok's own output"
fi

grep -m 1 "Error:" "$data/err"
sed -E 's#https://[^ ]+#<link>#g' "$data/err" | tail -n 5
rm -rf "$data"
