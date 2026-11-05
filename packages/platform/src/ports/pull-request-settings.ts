import type { PullRequestSettings, ReceiptActor } from "@werft-ai/contracts";

/** The workspace's pull request layout and the revision that guards it. */
export type PullRequestSettingsRead = {
  settings: PullRequestSettings;
  /** 0 until first saved. */
  revision: number;
};

export type PutPullRequestSettingsResult =
  | {
      outcome: "stored";
      settings: PullRequestSettings;
      revision: number;
      /** Null when the values already held and nothing was written. */
      receiptId: string | null;
    }
  | { outcome: "revision_conflict" | "actor_inactive" };

/**
 * `pull_request` and `pull_request_revision` on `github_workspace_settings`.
 * Apart from the ceiling's store: a save here never moves the ceiling's
 * revision, and a row that holds only these reads as no ceiling.
 */
export interface PullRequestSettingsStore {
  /** The defaults for a workspace with none saved, or a value this image cannot read. */
  get(workspaceId: string): Promise<PullRequestSettingsRead>;
  /** CAS on `revision`; writes `set_github_pull_request_settings`. */
  put(input: {
    workspaceId: string;
    settings: PullRequestSettings;
    revision: number;
    updatedBy: string;
    actor: ReceiptActor;
  }): Promise<PutPullRequestSettingsResult>;
}
