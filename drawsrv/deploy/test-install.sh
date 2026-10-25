#!/bin/sh
# Exercise the same recipes shipped in release bundles, with no root/systemd.
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
stage=$(mktemp -d)
trap 'rm -rf "$stage"' 0 HUP INT TERM
mkdir -p "$stage/project/bin" "$stage/project/web/dist/assets"
cp "$source_dir/Makefile" "$stage/project/"
cp -R "$source_dir/deploy" "$stage/project/"
printf '#!/bin/sh\nexit 0\n' > "$stage/project/bin/drawsrv"
chmod 755 "$stage/project/bin/drawsrv"
printf 'first index\n' > "$stage/project/web/dist/index.html"
printf 'first asset\n' > "$stage/project/web/dist/assets/v1.js"
cd "$stage/project"
# The default build must reuse committed frontend files, even without npm.
make build GO=true NPM=false
if make check-web WEB_BUILD="$stage/missing" >/dev/null 2>&1; then
    echo 'Missing frontend assets were accepted' >&2
    exit 1
fi
make install install-config install-systemd SUDO= SYSTEMCTL=false DESTDIR="$stage/root"
test -x "$stage/root/usr/local/bin/drawsrv"
test ! -e "$stage/root/var/lib/drawsrv"
cmp web/dist/index.html "$stage/root/usr/local/share/drawsrv/web/index.html"
cmp deploy/drawsrv.service "$stage/root/etc/systemd/system/drawsrv.service"
grep -q '^WorkingDirectory=/var/lib/drawsrv$' "$stage/root/etc/systemd/system/drawsrv.service"
grep -q -- '-data /var/lib/drawsrv ' "$stage/root/etc/systemd/system/drawsrv.service"
printf '# keep local configuration\n' >> "$stage/root/etc/drawsrv/drawsrv.env"
cp "$stage/root/etc/drawsrv/drawsrv.env" "$stage/saved.env"
printf 'second index\n' > web/dist/index.html
rm web/dist/assets/v1.js
printf 'second asset\n' > web/dist/assets/v2.js
make install install-config SUDO= DESTDIR="$stage/root"
cmp "$stage/saved.env" "$stage/root/etc/drawsrv/drawsrv.env"
cmp web/dist/index.html "$stage/root/usr/local/share/drawsrv/web/index.html"
test -f "$stage/root/usr/local/share/drawsrv/web/assets/v1.js"
test -f "$stage/root/usr/local/share/drawsrv/web/assets/v2.js"
make install install-config install-systemd SUDO= SYSTEMCTL=false DESTDIR="$stage/custom" \
    PREFIX=/opt/custom/bin SHARE_DIR=/opt/custom/share CONFIG_DIR=/opt/custom/etc \
    SYSTEMD_DIR=/opt/custom/units SERVICE_USER=custom SERVICE_GROUP=customgroup
unit="$stage/custom/opt/custom/units/drawsrv.service"
grep -q '^User=custom$' "$unit"
grep -q '^Group=customgroup$' "$unit"
grep -q 'ExecStart=/opt/custom/bin/drawsrv ' "$unit"
grep -q -- '-static /opt/custom/share/web ' "$unit"
grep -q '^WorkingDirectory=/var/lib/drawsrv$' "$unit"
grep -q '^StateDirectory=drawsrv$' "$unit"
grep -q '^StateDirectoryMode=0700$' "$unit"
grep -q -- '-data /var/lib/drawsrv ' "$unit"
grep -q 'EnvironmentFile=-/opt/custom/etc/drawsrv.env' "$unit"
if grep -q "$stage/custom" "$unit"; then echo 'DESTDIR leaked into runtime unit' >&2; exit 1; fi
make clean
test -f web/dist/index.html
echo 'Deployment recipes passed: prebuilt install, config preservation, retained assets, custom paths and no systemctl in staging.'
