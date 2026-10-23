import type { SessionRepository } from "@werft-ai/contracts";

const NAME_SEGMENT = /^[A-Za-z0-9._~-]+$/;

/**
 * An http(s) URL's path without host, userinfo, query or a trailing `.git`
 * (`owner/repo`, or `group/sub/repo` on a forge with groups), or null when a
 * segment is not a plain name.
 */
function pathNameOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const path = parsed.pathname;
  const segments = path
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .slice(1);
  const plain =
    segments.length >= 2 &&
    segments.every(
      (segment) =>
        NAME_SEGMENT.test(segment) && segment !== "." && segment !== "..",
    );
  return plain ? segments.join("/") : null;
}

/**
 * The repository a session shows, from the session row alone, so a later
 * catalog change or removal never alters it. A row from before the catalog
 * refused credentials may hold one in its URL; only the path is read.
 */
export function sessionRepositoryOf(row: {
  repositoryMode: "repository" | "none";
  repositoryId: string | null;
  repoUrl: string | null;
  branch: string | null;
}): SessionRepository | null {
  if (row.repositoryMode === "none" || row.branch === null) return null;
  return {
    id: row.repositoryId,
    full_name:
      (row.repoUrl === null ? null : pathNameOf(row.repoUrl)) ??
      row.repositoryId,
    branch: row.branch,
  };
}
