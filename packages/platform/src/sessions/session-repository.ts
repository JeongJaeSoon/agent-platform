import type { SessionRepository } from "@werft-ai/contracts";
import { repoRefOf } from "../ports/forge.ts";

/**
 * The repository a session shows, from the session row alone, so a later
 * catalog change or removal never alters it. The stored URL is read only
 * through repoRefOf, whose owner and name cannot hold userinfo, a host or a
 * query: a row from before the catalog refused credentials may carry one.
 */
export function sessionRepositoryOf(row: {
  repositoryMode: "repository" | "none";
  repositoryId: string | null;
  repoUrl: string | null;
  branch: string | null;
}): SessionRepository | null {
  if (row.repositoryMode === "none" || row.branch === null) return null;
  const ref = row.repoUrl === null ? null : repoRefOf(row.repoUrl);
  return {
    id: row.repositoryId,
    full_name: ref ? `${ref.owner}/${ref.name}` : row.repositoryId,
    branch: row.branch,
  };
}
