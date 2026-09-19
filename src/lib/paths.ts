/**
 * Display form of a filesystem path.
 *
 * The native layer canonicalizes workspaces, which on Windows yields the
 * verbatim `\\?\` form (`\\?\C:\…`, `\\?\UNC\…`). That form is correct for
 * identity and filesystem calls but unreadable in the UI, so human-facing
 * renders strip the prefix. Storage and routing keep the stored value.
 */
export function displayPath(path: string): string {
  const unc = /^\\\\\?\\UNC\\([^\\]+)\\([^\\]+)(\\.*)?$/;
  const uncMatch = unc.exec(path);
  if (uncMatch) {
    return `\\\\${uncMatch[1]}\\${uncMatch[2]}${uncMatch[3] ?? ""}`;
  }
  const drive = /^\\\\\?\\([A-Za-z]:\\)/;
  if (drive.test(path)) {
    return path.slice(4);
  }
  return path;
}
