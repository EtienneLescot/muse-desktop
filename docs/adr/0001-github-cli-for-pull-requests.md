# ADR 0001 — Use the GitHub CLI to create pull requests

- **Status:** accepted for M1-04
- **Date:** 2026-09-16
- **Context:** Muse has to create a pull request from the conversation's repository without copying a token into the webview. The MSP engine provides no forge operation, and the application must not assume a host or a default branch.

## Decision

The Tauri backend calls `gh pr create` as a separate process, in the workspace resolved by `sessionId`. The command always receives `--base`, `--head`, `--title` and `--body`. Authentication is whatever the user already configured in the GitHub CLI; no credential is read, persisted or passed to the frontend. The output must contain an HTTP(S) URL, otherwise the action is treated as unverified.

Pushing stays an independent Git operation: remote and branch are given explicitly and the refspec is `HEAD:refs/heads/<branch>`. Muse never tries to merge automatically.

## Alternatives rejected

- **The GitHub API directly:** would require token handling, scopes and secure storage before delivering any benefit in the current desktop target.
- **Inferring remote/base/head:** risks pushing to an unexpected destination, especially in a multi-remote repository.
- **Shelling out through a concatenated string:** forbidden, to avoid flag injection and loss of traceability; every argument is passed separately to the process.

## Consequences

Creating a PR depends on `gh` being installed and authenticated; a missing CLI, an expired session, an existing PR or a network refusal are surfaced as actionable errors. CI stays credential-free and covers the local validations; a live scenario against a test repository must complete the M1-04 qualification.
