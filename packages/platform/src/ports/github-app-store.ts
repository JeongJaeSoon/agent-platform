import type { GitHubAppCheckFailure, GitHubAppRole } from "@werft-ai/contracts";
import type { RepoRef } from "./forge.ts";
import type { SecretAudit } from "./secret-store.ts";

/** What GitHub says the App is, read with the App's own JWT. */
export type GitHubAppProfile = {
  appId: number;
  slug: string;
  name: string;
  htmlUrl: string;
};

/** The workspace's GitHub App as stored, without its private key. */
export type GitHubAppRecord = GitHubAppProfile & {
  /** The row's own id; the private key is sealed under it. */
  id: string;
  workspaceId: string;
  apiBase: string;
  createdAt: Date;
  updatedAt: Date;
  privateKey: {
    updatedAt: Date;
    updatedBy: { userId: string; displayName: string } | null;
  };
};

/** What the server signs with: for its own GitHub calls only. */
export type GitHubAppCredential = {
  id: string;
  workspaceId: string;
  appId: number;
  apiBase: string;
  privateKey: string;
  /** Changes whenever the App or its key is replaced. */
  updatedAt: Date;
};

export type PutGitHubAppResult =
  | { outcome: "stored"; app: GitHubAppRecord }
  | { outcome: "actor_inactive" | "outranked" | "workspace_not_found" };

export type DeleteGitHubAppResult =
  | { outcome: "deleted"; appId: number }
  | { outcome: "not_found" | "actor_inactive" | "outranked" };

/**
 * One GitHub App per workspace and role. Every call names its role, so a
 * caller that only knows the author App never reads, replaces or deletes
 * the reviewer's row or key.
 */
export interface GitHubAppStore {
  find(
    workspaceId: string,
    role: GitHubAppRole,
  ): Promise<GitHubAppRecord | null>;
  /** Registers or replaces the App; the receipt is written with it. */
  put(
    workspaceId: string,
    role: GitHubAppRole,
    app: GitHubAppProfile & { apiBase: string },
    privateKey: string,
    audit: SecretAudit,
  ): Promise<PutGitHubAppResult>;
  delete(
    workspaceId: string,
    role: GitHubAppRole,
    audit: SecretAudit,
  ): Promise<DeleteGitHubAppResult>;
  /** Every registered App of `role` with its key, or one workspace's. */
  credentials(
    role: GitHubAppRole,
    workspaceId?: string,
  ): Promise<GitHubAppCredential[]>;
}

export type GitHubAppInstallationView = {
  id: number;
  account: string;
  repositorySelection: "all" | "selected";
  htmlUrl: string | null;
};

/** GitHub's side of a registered App, asked with the App's JWT. */
export interface GitHubAppDirectory {
  describe(
    app: Pick<GitHubAppCredential, "appId" | "apiBase" | "privateKey">,
  ): Promise<GitHubAppProfile>;
  installations(
    app: Pick<GitHubAppCredential, "appId" | "apiBase" | "privateKey">,
  ): Promise<GitHubAppInstallationView[]>;
  /** The installation that covers `repo`, or null when there is none. */
  installationFor(
    app: Pick<GitHubAppCredential, "appId" | "apiBase" | "privateKey">,
    repo: RepoRef,
  ): Promise<number | null>;
}

/** A GitHub answer that says nothing about the request's own values. */
export class GitHubAppCheckError extends Error {
  override readonly name = "GitHubAppCheckError";
  constructor(readonly reason: GitHubAppCheckFailure) {
    super(`GitHub App check failed: ${reason}`);
  }
}
