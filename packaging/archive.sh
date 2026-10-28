#!/bin/sh
# Packs an app built by packaging/app.sh into shrok-<version>-<os>-<arch>.tar.gz. Unpack it anywhere, such as
# /opt/shrok, and run bin/shrok. On Linux it also holds the systemd unit and, for Ubuntu 24.04 and later, the
# AppArmor profiles that let bubblewrap and the browser make user namespaces. Both expect /opt/shrok.
#   packaging/archive.sh <app dir> <output dir>
set -eu

app=$1
out=$2
here=$(cd "$(dirname "$0")" && pwd)
version=$("$app/node/bin/node" -p 'require(process.argv[1]).version' "$app/app/package.json")
platform=$("$app/node/bin/node" -p '`${process.platform === "darwin" ? "macos" : process.platform}-${process.arch}`')
name="shrok-$version-$platform"

stage=$(mktemp -d)
cp -R "$app" "$stage/$name"
# The copy keeps the builder's umask. Only root, which owns the installed files, may change them.
chmod -R go-w "$stage/$name"

if [ "$(uname -s)" = Linux ]; then
  mkdir -p "$stage/$name/share/systemd" "$stage/$name/share/apparmor"
  cp "$here/systemd/shrok.service" "$stage/$name/share/systemd/"
  cp "$here/deb/apparmor/shrok-bwrap" "$here/deb/apparmor/shrok-browser" "$stage/$name/share/apparmor/"
fi

# Builder identities must never become installation-host owners when root extracts the archive.
archive_owner=0
archive_group=0
case "$(tar --version)" in
  *bsdtar*) set -- --uid "$archive_owner" --gid "$archive_group" --uname root --gname root ;;
  *) set -- --owner="$archive_owner" --group="$archive_group" --numeric-owner ;;
esac

mkdir -p "$out"
tar "$@" -czf "$out/$name.tar.gz" -C "$stage" "$name"
rm -rf "$stage"
echo "archive.sh: built $out/$name.tar.gz"
