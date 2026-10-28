#!/bin/sh
# Packs an app built by packaging/app.sh on Linux into a .deb with dpkg-deb.
#   packaging/deb/build.sh <app dir> <output dir>
set -eu

app=$1
out=$2
here=$(cd "$(dirname "$0")" && pwd)
version=$("$app/node/bin/node" -p 'require(process.argv[1]).version' "$app/app/package.json")

case "$(uname -m)" in
  aarch64) arch=arm64 ;;
  x86_64) arch=amd64 ;;
  *) echo "deb/build.sh: unsupported machine $(uname -m)" >&2; exit 1 ;;
esac

root=$(mktemp -d)
# mktemp makes the staging root 0700, which dpkg-deb would record as the mode of / itself. It stays 0755,
# as every other directory in the package.
chmod 0755 "$root"
mkdir -p "$root/opt" "$root/usr/bin" "$root/usr/lib/systemd/system" "$root/etc/apparmor.d" "$root/DEBIAN"
cp -R "$app" "$root/opt/shrok"
# The copy keeps the builder's umask. Only root, which owns the installed files, may change them.
chmod -R go-w "$root/opt/shrok"
ln -s /opt/shrok/bin/shrok "$root/usr/bin/shrok"
cp "$here/../systemd/shrok.service" "$root/usr/lib/systemd/system/shrok.service"
cp "$here/apparmor/shrok-bwrap" "$here/apparmor/shrok-browser" "$root/etc/apparmor.d/"

for script in postinst prerm postrm; do
  install -m 0755 "$here/$script" "$root/DEBIAN/$script"
done

cat >"$root/DEBIAN/conffiles" <<EOF
/etc/apparmor.d/shrok-bwrap
/etc/apparmor.d/shrok-browser
EOF

cat >"$root/DEBIAN/control" <<EOF
Package: shrok
Version: $version
Architecture: $arch
Maintainer: Bjoern Aagaard <bjoernaagaard@users.noreply.github.com>
Section: net
Priority: optional
Homepage: https://github.com/bjoernaagaard/shrok
Installed-Size: $(du -sk "$root/opt" | cut -f 1)
Pre-Depends: adduser
Depends: bubblewrap, socat, ripgrep, ca-certificates, libatomic1, libnss3, libnspr4, libdbus-1-3, libexpat1,
 libgbm1, libxkbcommon0, libxcb1, libx11-6, libxcomposite1, libxdamage1, libxext6, libxfixes3, libxrandr2,
 libasound2t64 | libasound2, libatk1.0-0t64 | libatk1.0-0, libatk-bridge2.0-0t64 | libatk-bridge2.0-0,
 libatspi2.0-0t64 | libatspi2.0-0, libglib2.0-0t64 | libglib2.0-0
Recommends: apparmor, fonts-liberation
Description: Personal assistant you talk to through SimpleX
 Shrok runs on your own machine and answers you in SimpleX Chat. It keeps a
 memory, saves what you share, runs schedules, and reads the web in a sandbox.
EOF

mkdir -p "$out"
deb="$out/shrok_${version}_${arch}.deb"
dpkg-deb --root-owner-group -Zxz --build "$root" "$deb" >/dev/null
rm -rf "$root"
echo "deb/build.sh: built $deb"
