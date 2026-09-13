/**
 * Workspace scope-guard client (US-22).
 *
 * `checkScope` asks the Rust backend (`check_scope` command) whether a path
 * is confined to the current workspace. US-18 (`@`-mentions) consumes this:
 * `in_scope: false` maps to its ask/deny permission step.
 *
 * No static Tauri import: the backend is reached through an injectable
 * `invoke` (dynamic import only inside a Tauri webview), so this module stays
 * testable on the plain node:test runner. Without a backend the guard fails
 * closed — `in_scope: false` with an explicit reason — so callers prompt
 * instead of silently allowing an unchecked path.
 */

export interface ScopeVerdict {
  in_scope: boolean;
  reason: string;
}

/** Minimal `invoke` shape (`@tauri-apps/api/core`), injectable for tests. */
export type ScopeInvoke = (
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

function isScopeVerdict(v: unknown): v is ScopeVerdict {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.in_scope === "boolean" && typeof o.reason === "string";
}

/**
 * Backend `invoke`, or null outside a Tauri webview (plain browser / tests).
 * The dynamic import never runs outside Tauri, so bundlers and node:test
 * never need the Tauri runtime.
 */
function defaultInvoke(): ScopeInvoke | null {
  if (
    typeof window === "undefined" ||
    !("__TAURI_INTERNALS__" in window)
  ) {
    return null;
  }
  return async (cmd, args) => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke(cmd, args);
  };
}

/**
 * Ask whether `path` is confined to the current workspace.
 * Fail-closed: no backend, backend error, or malformed reply all yield
 * `in_scope: false` with an explicit reason.
 */
export async function checkScope(
  path: string,
  invokeFn?: ScopeInvoke,
): Promise<ScopeVerdict> {
  const inv = invokeFn ?? defaultInvoke();
  if (inv === null) {
    return {
      in_scope: false,
      reason: `scope unchecked: no backend available for "${path}" — treat as out-of-scope`,
    };
  }
  let raw: unknown;
  try {
    raw = await inv("check_scope", { path });
  } catch (e) {
    return {
      in_scope: false,
      reason: `scope check failed for "${path}": ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (isScopeVerdict(raw)) return raw;
  return {
    in_scope: false,
    reason: `scope check returned a malformed verdict for "${path}" — treat as out-of-scope`,
  };
}
