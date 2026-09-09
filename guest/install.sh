#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Run ONLY inside a dedicated Debian/Ubuntu Linux guest, not Termux or Android root.
set -euo pipefail
umask 077
if [[ "${1:-}" != "--guest-confirmed" ]]; then
  echo 'Refusing installation without --guest-confirmed. Read guest/README.md first.' >&2
  exit 2
fi
if [[ $EUID -ne 0 ]] || [[ -e /system/build.prop || -e /system/bin/app_process || -d /apex/com.android.runtime ]]; then
  echo 'Requires root INSIDE the Linux guest. Android/Termux installation is refused.' >&2
  exit 2
fi
if [[ "$(cat /proc/1/comm)" != "systemd" ]] || ! command -v apt-get >/dev/null; then
  echo 'This bootstrap targets a systemd Debian/Ubuntu guest, not arbitrary containers.' >&2
  exit 2
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for file in package.json LICENSE guest/runtime.lock.json guest/agbot.service gateway/src/main.mjs; do
  [[ -f "$ROOT/$file" ]] || { echo "Incomplete guest bundle: $file" >&2; exit 2; }
done
RUNTIME=/opt/agbot-runtime
PREFIX=/opt/agbot
for directory in "$RUNTIME" "$PREFIX"; do
  if [[ -e "$directory" && ! -f "$directory/.agbot-managed" ]]; then
    echo "Unmanaged existing directory, left untouched: $directory" >&2; exit 2
  fi
done
if [[ -f /etc/systemd/system/agbot.service ]] && ! grep -q '^# Agbot-managed service' /etc/systemd/system/agbot.service; then
  echo 'An unrelated agbot.service already exists; left untouched.' >&2; exit 2
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl xz-utils openssl python3 python3-venv git bash build-essential pkg-config iproute2 util-linux
case "$(uname -m)" in aarch64|arm64) ARCH=arm64 ;; x86_64) ARCH=x64 ;; *) echo 'Unsupported guest architecture' >&2; exit 2 ;; esac
NODE_VERSION="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["nodeVersion"])' "$ROOT/guest/runtime.lock.json")"
NODE_SHA="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["nodeSha256"][sys.argv[2]])' "$ROOT/guest/runtime.lock.json" "$ARCH")"
CODEX_VERSION="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["codexVersion"])' "$ROOT/guest/runtime.lock.json")"
install -d -m 0755 "$PREFIX" "$RUNTIME" "$PREFIX/releases"
touch "$PREFIX/.agbot-managed" "$RUNTIME/.agbot-managed"
TMP="$(mktemp -d)"; trap 'rm -rf -- "$TMP"' EXIT
if [[ ! -x "$RUNTIME/node/bin/node" ]]; then
  curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 2 \
    "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${ARCH}.tar.xz" -o "$TMP/node.tar.xz"
  printf '%s  %s\n' "$NODE_SHA" "$TMP/node.tar.xz" | sha256sum -c -
  install -d -m 0755 "$RUNTIME/node"
  tar --extract --xz --file "$TMP/node.tar.xz" --directory "$RUNTIME/node" --strip-components=1 --no-same-owner
fi
[[ "$("$RUNTIME/node/bin/node" --version)" == "v$NODE_VERSION" ]] || { echo 'Installed Node differs from runtime.lock.json; review upgrade rather than replacing it silently.' >&2; exit 2; }
export PATH="$RUNTIME/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
if ! getent passwd agbot >/dev/null; then
  useradd --system --user-group --create-home --home-dir /home/agbot --shell /bin/bash agbot
fi
[[ "$(getent passwd agbot | cut -d: -f6)" == '/home/agbot' ]] || { echo 'Existing agbot account has a different home; left untouched.' >&2; exit 2; }
[[ "$(id -u agbot)" != 0 ]] || { echo 'The agbot account must not be root' >&2; exit 2; }
install -d -o agbot -g agbot -m 0700 /var/lib/agbot /home/agbot /home/agbot/workspaces
# The official platform-specific package is pinned. Disable package lifecycle scripts.
if [[ ! -x "$RUNTIME/codex/node_modules/.bin/codex" ]]; then
  (umask 022; npm install --registry=https://registry.npmjs.org --userconfig=/dev/null --prefix "$RUNTIME/codex" --ignore-scripts --no-audit --no-fund "@openai/codex@$CODEX_VERSION")
fi
# Runtime assets contain no credentials and must be readable/executable by the guest user.
# The installer intentionally has umask 077 for all state and keys outside this prefix.
chmod -R a+rX "$RUNTIME/node" "$RUNTIME/codex"
CODEX_BIN="$RUNTIME/codex/node_modules/.bin/codex"
runuser -u agbot -- env HOME=/home/agbot PATH="$PATH" "$CODEX_BIN" --version | grep -F "$CODEX_VERSION" >/dev/null || {
  echo 'Codex binary/version validation failed; no OAuth fallback or sandbox bypass was enabled.' >&2; exit 2;
}
# Content-addressed source releases; an earlier version and all state survive upgrades.
RELEASE="$(python3 - "$ROOT" <<'PY'
import hashlib, pathlib, sys
root=pathlib.Path(sys.argv[1]); h=hashlib.sha256()
for p in sorted(list((root/'gateway/src').glob('*.mjs')) + [root/'guest/enroll.py']):
    h.update(p.name.encode()); h.update(p.read_bytes())
print(h.hexdigest()[:20])
PY
)"
DEST="$PREFIX/releases/$RELEASE"
if [[ ! -d "$DEST" ]]; then
  install -d -m 0755 "$DEST/gateway" "$DEST/guest"
  cp -R "$ROOT/gateway/src" "$DEST/gateway/src"
  cp "$ROOT/guest/enroll.py" "$DEST/guest/enroll.py"
  cp "$ROOT/package.json" "$ROOT/LICENSE" "$DEST/"
  find "$DEST" -type d -exec chmod 0755 {} +
  find "$DEST" -type f -exec chmod 0644 {} +
  chown -R root:root "$DEST"
fi
install -d -o root -g agbot -m 0750 /etc/agbot
if [[ ! -f /etc/agbot/guest.key ]]; then
  openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 397 \
    -subj '/CN=Agbot Guest' -addext 'subjectAltName=DNS:agbot.local' \
    -keyout /etc/agbot/guest.key -out /etc/agbot/guest.crt
  chown root:agbot /etc/agbot/guest.key /etc/agbot/guest.crt
  chmod 0640 /etc/agbot/guest.key /etc/agbot/guest.crt
fi
if [[ -n "${AGBOT_SEED_FILE:-}" ]]; then
  python3 - "$AGBOT_SEED_FILE" <<'SEED'
import json, os, pathlib, pwd, re, sys
seed=json.loads(pathlib.Path(sys.argv[1]).read_text())
token=seed['bridgeToken']; instance=seed['instanceId']
if not re.fullmatch(r'[A-Za-z0-9_-]{43}',token) or not re.fullmatch(r'[0-9a-f-]{36}',instance): raise SystemExit('Invalid instance identity')
p=pathlib.Path('/var/lib/agbot/bridge.token')
if p.exists() and p.read_text().strip()!=token: raise SystemExit('Refusing to replace existing token')
if not p.exists():
    with p.open('x') as f:f.write(token+'\n')
    u=pwd.getpwnam('agbot');os.chown(p,u.pw_uid,u.pw_gid);p.chmod(0o600)
i=pathlib.Path('/etc/agbot/instance-id')
if i.exists() and i.read_text().strip()!=instance:raise SystemExit('Refusing changed instance ID')
i.write_text(instance+'\n');i.chmod(0o644)
SEED
fi
if [[ ! -f /var/lib/agbot/bridge.token ]]; then
  runuser -u agbot -- env HOME=/home/agbot AGBOT_DATA_DIR=/var/lib/agbot \
    "$RUNTIME/node/bin/node" "$DEST/gateway/src/main.mjs" --init-token
fi
if [[ ! -f /etc/agbot/gateway.env ]]; then
  cat > /etc/agbot/gateway.env <<ENV
# Agbot-managed configuration. No model keys belong in this file.
AGBOT_DATA_DIR=/var/lib/agbot
AGBOT_TOKEN_FILE=/var/lib/agbot/bridge.token
AGBOT_WORKSPACE_ROOT=/home/agbot/workspaces
AGBOT_BIND=0.0.0.0
AGBOT_PORT=8765
AGBOT_TLS_KEY=/etc/agbot/guest.key
AGBOT_TLS_CERT=/etc/agbot/guest.crt
AGBOT_CODEX_BIN=$CODEX_BIN
ENV
  chmod 0640 /etc/agbot/gateway.env; chown root:agbot /etc/agbot/gateway.env
fi
# Stop existing tasks only for an explicit installation/upgrade, retaining state and old release.
if systemctl is-active --quiet agbot; then systemctl stop agbot; fi
ln -s "$DEST" "$PREFIX/.current-$RELEASE-$$"
mv -Tf "$PREFIX/.current-$RELEASE-$$" "$PREFIX/current"
install -m 0644 "$ROOT/guest/agbot.service" /etc/systemd/system/agbot.service
systemctl daemon-reload
systemctl enable --now agbot
if [[ -f /etc/agbot/instance-id ]]; then
  install -m 0644 "$ROOT/guest/agbot-enroll.service" /etc/systemd/system/agbot-enroll.service
  systemctl daemon-reload
  systemctl enable --now agbot-enroll
fi
HOST="${AGBOT_ADVERTISED_HOST:-$(ip -4 -o addr show scope global | awk 'NR==1 {split($4,a,"/"); print a[1]}')}"
HOST="${HOST:-127.0.0.1}"
PIN="$(openssl x509 -in /etc/agbot/guest.crt -outform DER | sha256sum | cut -d' ' -f1)"
python3 - "$HOST" "$PIN" <<'PY'
import json, pathlib, pwd, os, re, sys
host,pin=sys.argv[1:]
if not re.fullmatch(r'[A-Za-z0-9.-]+',host): raise SystemExit('Invalid advertised host')
p=pathlib.Path('/var/lib/agbot/pairing.json')
token=pathlib.Path('/var/lib/agbot/bridge.token').read_text().strip()
p.write_text(json.dumps({'schema':1,'gatewayBase':f'https://{host}:8765','bridgeToken':token,'certificateSha256':pin},indent=2)+'\n')
p.chmod(0o600); u=pwd.getpwnam('agbot'); os.chown(p,u.pw_uid,u.pw_gid)
PY
printf '\nGuest service installed as non-root agbot. Model keys have not been configured.\n'
printf 'Pairing file: /var/lib/agbot/pairing.json (private; do not upload or send it to anyone).\n'
printf 'Guest address: https://%s:8765\nCertificate SHA-256: %s\n' "$HOST" "$PIN"
printf 'Android-to-guest reachability still depends on the selected DroidVM network configuration.\n'
systemctl --no-pager --full status agbot | head -16 || true
