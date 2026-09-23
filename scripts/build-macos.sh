#!/bin/sh
# Build the macOS app bundle and/or DMG.
#
# The macOS app does not bundle the Muse engine: on first launch it offers to
# install the Muse CLI with Meta's official installer
# (curl -fsSL https://dev.meta.ai/install.sh | bash), which puts a
# self-updating `muse` in ~/.local/bin. Nothing about the CLI is needed here.
#
# Usage:
#   sh scripts/build-macos.sh [--bundle app|dmg|all] [--target TRIPLE]
#   sh scripts/build-macos.sh --dev-sidecar PATH   # dev only: stage a fake or
#                                                  # local engine for `tauri dev`
#
# Signing and notarization (optional, like OpenScreen's release builds):
#   APPLE_SIGNING_IDENTITY="Developer ID Application: …"  signs the app and DMG
#   NOTARY_PROFILE=muse-notary   notarizes and staples the DMG with a profile
#                                saved by `xcrun notarytool store-credentials`
#
#   --target  aarch64-apple-darwin (Apple Silicon, default on arm64 hosts) or
#             x86_64-apple-darwin (Intel; needs `rustup target add`).
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
bundle=dmg
target=
dev_sidecar=

while [ $# -gt 0 ]; do
  case "$1" in
    --bundle) bundle=$2; shift 2 ;;
    --target) target=$2; shift 2 ;;
    --dev-sidecar) dev_sidecar=$2; shift 2 ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$bundle" in app|dmg|all) ;; *) echo "--bundle must be app, dmg or all" >&2; exit 2 ;; esac

if [ "$(uname -s)" != Darwin ]; then
  echo "build-macos.sh must run on macOS" >&2
  exit 1
fi

if [ -z "$target" ]; then
  case "$(uname -m)" in
    arm64) target=aarch64-apple-darwin ;;
    x86_64) target=x86_64-apple-darwin ;;
    *) echo "unsupported host architecture: $(uname -m)" >&2; exit 1 ;;
  esac
fi
case "$target" in aarch64-apple-darwin|x86_64-apple-darwin) ;; *)
  echo "unsupported macOS target: $target" >&2; exit 2 ;;
esac

if [ -n "$dev_sidecar" ]; then
  # Dev only: the app prefers an installed ~/.local/bin/muse, then PATH, then
  # this staged file. It is never bundled on macOS.
  dest="$repo/src-tauri/binaries/muse-$target"
  cp "$dev_sidecar" "$dest"
  chmod 755 "$dest"
  echo "staged dev sidecar: $dest"
  exit 0
fi

cd "$repo"
npm run build
case "$bundle" in
  all) bundles=app,dmg ;;
  *) bundles=$bundle ;;
esac
npm run tauri -- build --target "$target" --bundles "$bundles"

bundle_root="$repo/src-tauri/target/$target/release/bundle"
echo "app: $bundle_root/macos/Muse-Desktop.app"
if [ "$bundle" != app ]; then
  dmg=$(ls -t "$bundle_root"/dmg/*.dmg 2>/dev/null | head -n 1)
  echo "dmg: $dmg"
  if [ -n "${NOTARY_PROFILE:-}" ]; then
    if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
      echo "NOTARY_PROFILE needs APPLE_SIGNING_IDENTITY: Apple only notarizes signed builds" >&2
      exit 1
    fi
    # CI keeps the profile in a temporary keychain (NOTARY_KEYCHAIN).
    if [ -n "${NOTARY_KEYCHAIN:-}" ]; then
      xcrun notarytool submit "$dmg" --keychain-profile "$NOTARY_PROFILE" --keychain "$NOTARY_KEYCHAIN" --wait
    else
      xcrun notarytool submit "$dmg" --keychain-profile "$NOTARY_PROFILE" --wait
    fi
    xcrun stapler staple "$dmg"
    spctl -a -t open --context context:primary-signature -vv "$dmg"
  fi
  shasum -a 256 "$dmg"
fi
# The release manifest (scripts/release-manifest.mjs) pins a bundled sidecar
# digest; macOS ships none, so manifests for macOS need a schema decision
# before the update channel covers this platform.
