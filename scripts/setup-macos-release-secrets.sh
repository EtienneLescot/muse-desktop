#!/bin/sh
# One-time setup of the GitHub secrets the macOS release job needs
# (.github/workflows/release.yml). Run it yourself, from the repository root:
#
#   sh scripts/setup-macos-release-secrets.sh
#
# - Exports the "Developer ID Application" identity from the login keychain as
#   a .p12 protected by a random password (macOS asks you to allow the export).
# - Stores MAC_CERTIFICATE_P12, MAC_CERTIFICATE_PASSWORD, APPLE_ID and
#   APPLE_TEAM_ID with `gh secret set`, then asks for the app-specific password
#   (APPLE_APP_SPECIFIC_PASSWORD) at an interactive prompt.
# No value is printed; the .p12 is deleted on exit.
set -eu

APPLE_ID_VALUE=${APPLE_ID_VALUE:-etienne@etiennelescot.fr}
TEAM_ID_VALUE=${TEAM_ID_VALUE:-M4LK7C6S84}

command -v gh >/dev/null || { echo "gh is required" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "run: gh auth login" >&2; exit 1; }

identity=$(security find-identity -v -p codesigning \
  | sed -n "s/.*\"\(Developer ID Application: [^\"]*($TEAM_ID_VALUE)\)\".*/\1/p" | head -n 1)
[ -n "$identity" ] || { echo "no Developer ID Application identity for team $TEAM_ID_VALUE" >&2; exit 1; }
echo "Identity: $identity"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
p12="$work/certificate.p12"
p12_password=$(openssl rand -hex 24)

# Exports only this identity (certificate + private key).
security export -k login.keychain-db -t identities -f pkcs12 -P "$p12_password" -o "$work/all.p12" >/dev/null
# `security export` exports every identity; keep only the Developer ID one.
openssl pkcs12 -in "$work/all.p12" -passin "pass:$p12_password" -nodes -legacy 2>/dev/null > "$work/all.pem" \
  || openssl pkcs12 -in "$work/all.p12" -passin "pass:$p12_password" -nodes > "$work/all.pem"
awk -v want="$identity" '
  /friendlyName:/ { keep = (index($0, want) > 0) }
  /-----BEGIN/ { block = keep } block { print } /-----END/ { block = 0 }
' "$work/all.pem" > "$work/one.pem"
grep -q "PRIVATE KEY" "$work/one.pem" || { echo "the private key of $identity was not exported" >&2; exit 1; }
openssl pkcs12 -export -in "$work/one.pem" -passout "pass:$p12_password" -out "$p12" 2>/dev/null

base64 -i "$p12" | gh secret set MAC_CERTIFICATE_P12
printf '%s' "$p12_password" | gh secret set MAC_CERTIFICATE_PASSWORD
printf '%s' "$APPLE_ID_VALUE" | gh secret set APPLE_ID
printf '%s' "$TEAM_ID_VALUE" | gh secret set APPLE_TEAM_ID
echo "App-specific password for $APPLE_ID_VALUE (input hidden):"
gh secret set APPLE_APP_SPECIFIC_PASSWORD

gh secret list
