#!/usr/bin/env bash
# Submit an MSIX to the Microsoft Store as an update of product STORE_APP_ID,
# through the Store submission API (https://manage.devcenter.microsoft.com).
#
# The msstore CLI is not used: it publishes from a project root it has to
# recognise (Electron, Flutter, WinUI…) and has no publisher for a Tauri app.
# The API is what the CLI calls underneath:
#   token → new submission (a copy of the live one) → swap the package →
#   upload the zipped package → commit → wait for the commit to settle.
# The submission goes to certification with targetPublishMode "Manual":
# nothing reaches customers until someone clicks Publish now.
#
#   STORE_TENANT_ID STORE_CLIENT_ID STORE_CLIENT_SECRET STORE_APP_ID \
#     scripts/store-submit.sh path/to/App_1.2.3_x64.msix
#
# Needs curl, jq and zip (all on ubuntu-latest).
set -euo pipefail

msix=${1:?usage: store-submit.sh <package.msix>}
test -f "$msix" || { echo "::error::$msix not found"; exit 1; }
: "${STORE_TENANT_ID:?}" "${STORE_CLIENT_ID:?}" "${STORE_CLIENT_SECRET:?}" "${STORE_APP_ID:?}"
api="https://manage.devcenter.microsoft.com/v1.0/my/applications/$STORE_APP_ID"

token=$(curl -fsS "https://login.microsoftonline.com/$STORE_TENANT_ID/oauth2/token" \
  --data-urlencode grant_type=client_credentials \
  --data-urlencode "client_id=$STORE_CLIENT_ID" \
  --data-urlencode "client_secret=$STORE_CLIENT_SECRET" \
  --data-urlencode resource=https://manage.devcenter.microsoft.com | jq -r .access_token)
call() { curl -fsS -H "Authorization: Bearer $token" -H "Content-Type: application/json" "$@"; }

# A draft already open in Partner Center belongs to whoever opened it:
# never overwrite or delete it from CI.
pending=$(call "$api" | jq -r '.pendingApplicationSubmission.id // empty')
if [ -n "$pending" ]; then
  echo "::error::submission $pending is already pending in Partner Center; finish or delete it, then upload $(basename "$msix") by hand"
  exit 1
fi

submission=$(call -X POST "$api/submissions")
id=$(jq -r .id <<<"$submission")
upload_url=$(jq -r .fileUploadUrl <<<"$submission")
echo "Created submission $id"

# Every package of the live submission is replaced by this one.
jq --arg file "$(basename "$msix")" '
  .applicationPackages |= (map(.fileStatus = "PendingDelete")
    + [{fileName: $file, fileStatus: "PendingUpload", minimumDirectXVersion: "None", minimumSystemRam: "None"}])
  | .targetPublishMode = "Manual"' <<<"$submission" > submission.json
call -X PUT "$api/submissions/$id" --data @submission.json > /dev/null

zip -j -q package.zip "$msix"
# The SAS URL may carry "+", which Azure reads as a space unless encoded.
curl -fsS -X PUT -H "x-ms-blob-type: BlockBlob" --upload-file package.zip "${upload_url//+/%2B}"
call -X POST "$api/submissions/$id/commit" > /dev/null

for _ in $(seq 1 60); do
  status=$(call "$api/submissions/$id/status")
  state=$(jq -r .status <<<"$status")
  [ "$state" != CommitStarted ] && break
  sleep 10
done
echo "Submission $id: $state"
if [ "$state" = CommitFailed ] || [ "$state" = CommitStarted ]; then
  jq '.statusDetails' <<<"$status"
  exit 1
fi
