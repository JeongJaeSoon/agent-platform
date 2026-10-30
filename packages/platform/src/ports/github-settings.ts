import type {
  ApiErrorCode,
  GitHubAppRole,
  GitHubCeiling,
  GitHubFeatures,
  ReceiptActor,
} from "@werft-ai/contracts";

/** What a GA-1 image answered for a release with GitHub settings. */
export const GITHUB_SETTINGS_UNSUPPORTED: {
  code: ApiErrorCode;
  message: string;
} = {
  code: "GITHUB_REFUSED",
  message:
    "The session's release has GitHub settings this server cannot apply yet",
};

export type GitHubWorkspaceSettings = {
  ceiling: GitHubCeiling;
  /** 0 when no row was ever written. */
  revision: number;
};

export type PutGitHubCeilingResult =
  | { outcome: "stored"; settings: GitHubWorkspaceSettings }
  | { outcome: "revision_conflict" | "workspace_not_found" | "actor_inactive" };

/** The workspace GitHub settings row (`github_workspace_settings`). */
export interface GitHubSettingsStore {
  get(workspaceId: string): Promise<GitHubWorkspaceSettings>;
  /** Agents with GitHub on whose active release turns each feature on. */
  agentsUsing(
    workspaceId: string,
  ): Promise<Record<keyof GitHubFeatures, number>>;
  /** The permissions each App's row last read, or null when none is registered. */
  appPermissions(
    workspaceId: string,
  ): Promise<
    Record<
      GitHubAppRole,
      { permissions: Record<string, "read" | "write" | "admin"> | null } | null
    >
  >;
  /** CAS on `revision`; writes `set_github_ceiling` with it. */
  putCeiling(input: {
    workspaceId: string;
    ceiling: GitHubCeiling;
    revision: number;
    updatedBy: string;
    actor: ReceiptActor;
  }): Promise<PutGitHubCeilingResult>;
}
