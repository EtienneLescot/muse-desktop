#!/usr/bin/env bash
# Pins one Muse engine version beside the launcher, for the macOS proofs.
#
# The launcher (~/.local/bin/muse) updates itself and deletes every other
# muse-bin-* in its folder, so a proof never calls it: it calls the binary
# pinned here, with MUSE_NO_AUTO_UPDATE=1. Same source, same manifest and same
# size and SHA-256 checks as the launcher; the launcher and its .muse-version
# are left untouched. The access token is read from the engine's own
# credential file and never printed.
#
#   scripts/macos/pin-engine.sh [version] [dest-root]
#   -> <dest-root>/<version>/muse-bin, default ~/muse-proofs/engine
set -euo pipefail
version="${1:-1.4.2-R4684.1}"
root="${2:-$HOME/muse-proofs/engine}"
platform=aarch64_macos
[[ "$(uname -s):$(uname -m)" == Darwin:arm64 ]] || { echo "Apple Silicon only" >&2; exit 1; }
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-R[0-9]+(\.[0-9]+)?$ ]] || { echo "bad version: $version" >&2; exit 1; }
dest="$root/$version"
if [[ -x "$dest/muse-bin" ]]; then
  echo "already pinned: $dest/muse-bin"
  exit 0
fi
auth="${MUSE_AUTH_PATH:-${XDG_CONFIG_HOME:-$HOME/.config}/muse/auth.json}"
token="$(/usr/bin/python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["providers"]["meta"]["access_token"])' "$auth" 2>/dev/null || true)"
work="$(mktemp -d "${TMPDIR:-/tmp}/muse-pin.XXXXXX")"
trap 'rm -rf "$work"' EXIT
fetch() { # url dest -> http status; anonymous first, as the launcher does
  local status
  status="$(curl -sS -L --max-redirs 3 --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --user-agent muse-code/launcher-3 -o "$2" -w '%{http_code}' "$1")"
  if [[ "$status" =~ ^(401|403|404)$ && -n "$token" ]]; then
    status="$(curl -sS -L --max-redirs 3 --proto '=https' --proto-redir '=https' --tlsv1.2 \
      --user-agent muse-code/launcher-3 -H "Authorization: Bearer $token" -o "$2" -w '%{http_code}' "$1")"
  fi
  echo "$status"
}
manifest_url="https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=$version&file=manifest.json"
status="$(fetch "$manifest_url" "$work/manifest.json")"
[[ "$status" == 2?? ]] || { echo "manifest: HTTP $status" >&2; exit 1; }
read -r url checksum size < <(/usr/bin/python3 -I -c '
import json,sys
m=json.load(open(sys.argv[1]))
assert m["version"]==sys.argv[2] and m["checksum_algorithm"]=="sha256"
a=m["artifacts"][sys.argv[3]]
assert a["url"].startswith("https://")
print(a["url"], a["checksum"], a["size"])' "$work/manifest.json" "$version" "$platform")
status="$(fetch "$url" "$work/muse-bin")"
[[ "$status" == 2?? ]] || { echo "artifact: HTTP $status" >&2; exit 1; }
actual_size="$(wc -c <"$work/muse-bin" | tr -d '[:space:]')"
[[ "$actual_size" == "$size" ]] || { echo "size mismatch: $actual_size != $size" >&2; exit 1; }
actual="$(shasum -a 256 "$work/muse-bin" | cut -d' ' -f1)"
[[ "$actual" == "$checksum" ]] || { echo "checksum mismatch" >&2; exit 1; }
mkdir -p "$dest"
cp "$work/manifest.json" "$dest/manifest.json"
chmod 0755 "$work/muse-bin"
mv "$work/muse-bin" "$dest/muse-bin"
echo "pinned: $dest/muse-bin sha256=$actual size=$size"
