/**
 * Where a link in an agent message leads. Web links go to the user's
 * browser; a file inside the conversation's folder opens in the Files panel
 * (the agent names files it wrote: `review.md`, `src/a.ts:12`, an absolute
 * path, a `file://` URL). Anything else is not followed.
 */
export type LinkTarget =
  | { kind: "web"; url: string }
  | { kind: "file"; path: string }
  | { kind: "none" };

export function classifyLink(href: string, workspace: string | null): LinkTarget {
  const raw = href.trim();
  if (/^(https?:|mailto:)/i.test(raw)) return { kind: "web", url: raw };

  let path = raw;
  if (/^file:/i.test(path)) path = path.replace(/^file:\/\//i, "").replace(/^\/([A-Za-z]:)/, "$1");
  else if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[A-Za-z]:[\\/]/.test(path)) return { kind: "none" };
  try {
    path = decodeURIComponent(path);
  } catch {
    // Not percent-encoded after all: keep it as written.
  }
  path = path.replace(/[?#].*$/, "").replace(/(:\d+){1,2}$/, "").replace(/\\/g, "/");

  if (/^[A-Za-z]:\//.test(path) || path.startsWith("/")) {
    const root = workspace?.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!root || !path.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return { kind: "none" };
    path = path.slice(root.length + 1);
  }
  path = path.replace(/^(\.\/)+/, "");
  return path === "" || path.split("/").includes("..") ? { kind: "none" } : { kind: "file", path };
}
