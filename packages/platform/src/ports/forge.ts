// The repository host behind a catalog repository, as the API talks to it:
// the credential the egress proxy logs in with, and the host's own API.
// Only GitHub has an adapter; a repository without one (Gitea, a bearer
// token, a public repository) keeps the catalog's static credential.

export type ForgeKind = "github";

/** A repository on its forge: the `<owner>/<name>` of the catalog URL. */
export type RepoRef = { owner: string; name: string };

/** What a credential may do: `read` clones, `write` pushes. */
export type ForgeAccess = "read" | "write";

/** A Basic login for git over HTTP, scoped to one repository and access. */
export type GitCredential = {
  username: string;
  password: string;
  /** Absent for a credential that does not expire (a PAT). */
  expiresAt?: Date;
};

export type ForgeRepository = {
  id: number;
  defaultBranch: string;
  private: boolean;
};

/** A pull request as the forge reports it; `head` and `base` are branch names. */
export type ForgePullRequest = {
  number: number;
  url: string;
  state: "open" | "closed";
  head: string;
  base: string;
};

export type ForgeComment = {
  id: number;
  url: string;
  /** False when a comment carrying the marker was edited instead. */
  created: boolean;
};

/**
 * A forge call that failed. The message names what failed and the status,
 * never a token, JWT, key or the forge's response body.
 */
export class ForgeCredentialError extends Error {
  override readonly name = "ForgeCredentialError";
}

/**
 * `https://github.com/<owner>/<name>(.git)` → `{ owner, name }`; the same path
 * on a GHES host. Null for any other path shape.
 */
export function repoRefOf(url: string): RepoRef | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const match = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(
    path,
  );
  if (!match?.[1] || !match[2] || match[2] === "." || match[2] === "..") {
    return null;
  }
  return { owner: match[1], name: match[2] };
}
