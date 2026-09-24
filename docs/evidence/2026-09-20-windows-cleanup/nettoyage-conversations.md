# Cleaning up test conversations — method and traps (20 September 2026)

This campaign created dozens of test conversations in the application. Deleting them took **four attempts**, three of which failed for different reasons. This document keeps what works and why the rest did not.

## Result

| Measurement | Before | After |
|---|---|---|
| Conversations in the sidebar | **41** | **1** |
| Displayed counter | 10 (after resurrections) | **1** |
| Log keys | 13 | **1** |

Exactly the user's real conversation is left: *"Explain the project structure and its main…"*, 15 entries, intact at every step.

**The deletion survives a page reload** — that is the check that separates the right method from the wrong ones.

## The three failures, and what they taught

### 1. Rewriting `localStorage` with the app open: the application writes back over it

First pass: 41 → 6 sessions, 15 log keys deleted. **Looked conclusive.**

Then the application **rewrote its own copy** — it kept the list in memory — and 5 deleted conversations **came back as empty shells**, with the generic title `Session <id>` and zero entries.

**Lesson:** for an object the application manages, changing its storage while it is running does not stick.

### 2. Rewriting `localStorage` with the app closed: the native side reintroduces them

Second pass, application stopped: 10 → 1. **Stable over 12 seconds**, verified by polling.

Then a **page reload** brought back **the same 9 sessions**, with the same identifiers. They did not come from `localStorage` then, but from a **native-side registry** (Tauri). Search on disk (`.config\muse`, `.muse`, `%LOCALAPPDATA%\muse`, `%APPDATA%\muse`): **no trace** of the identifiers.

**Lesson:** deleting from web storage does not kill the session. The button's tooltip says so explicitly: *"Kill session and delete its local history"*.

### 3. Driving the button over CDP: three obstacles in one

- The **"Delete…"** button is not in the sidebar: it lives in a **modal dialog** opened by a button with **`aria-label="Actions for …"`** (`dialog.current?.showModal()`). An earlier version looked for a context menu and a double-click, neither of which exists.
- An **asynchronous** page evaluation came back with an empty object — a CDP limitation already met on the queue race test.
- A `Runtime.evaluate` call **without `returnByValue`** returns a remote object reference: the caller reads `undefined` and cannot distinguish it from a failure.

**Lesson:** the right path is `Actions for …` → `Delete…` → `Delete conversation`, in **separate synchronous calls**.

## The method that works

```powershell
# Dry run: proves the path by deleting ONE row
node scripts/cdp-delete-conversations.mjs

# Delete all remaining shells
node scripts/cdp-delete-conversations.mjs --apply
```

**Safety rule:** only rows whose label is `Actions for New conversation` or `Actions for Session <id>` are touched. A session that produced a real turn carries a **descriptive title** and is never selected — verified at every step, the real title appears intact in every reading.

**Guard rail:** if the number of shells does not decrease after a deletion, the script **stops** instead of carrying on blind.

## Backup

`%USERPROFILE%\muse-localstorage-backup-2026-09-20.json` — 215 KB, 61 keys, the complete state **before** any deletion. It contains the deleted conversations and allows a rollback.

## What this cleanup revealed about the product

- **A conversation with no completed turn keeps a generic title** and presents itself as "New conversation" in the sidebar, while its stored title is `Session <id>`. That is what makes the distinction reliable… and it is also a display inconsistency between storage and interface.
- **Sessions are reintroduced by the native side on reload** although they no longer exist in web storage. After a `localStorage` deletion, the application and its native registry diverge silently — the interface kept showing 10 entries for a storage holding 1.
- **Observability is weak**: the conversation is deleted, but nothing in the interface indicates that a native session outlives it.

These three points are not defects of the current ticket, but they would deserve a roadmap entry if the subject comes back.
