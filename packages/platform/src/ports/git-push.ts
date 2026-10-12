// Pushing one checkpoint commit to its remote branch with git. The platform
// decides what may be pushed where (push-executor.ts); this is only the git.

export type GitPushInput = {
  /** Owned by the caller, empty but for `bundles`, removed by the caller. */
  directory: string;
  /** The checkpoint's bundle chain, oldest first; the last lands `commit`. */
  bundles: readonly string[];
  commit: string;
  remoteUrl: string;
  /** `refs/heads/<branch>`, the only ref the push may write. */
  ref: string;
  /**
   * Request headers that authenticate to `remoteUrl`, sent to that URL only.
   * They never reach an argument list, a URL, a config file or the disk.
   */
  headers: ReadonlyArray<readonly [string, string]>;
};

export type GitPushResult =
  | {
      status: "pushed";
      /** What `ref` held before, or null when the push created it. */
      previousCommit: string | null;
    }
  | {
      status: "refused";
      refusal: "default_branch" | "non_fast_forward" | "push_failed";
      /** Safe to log: no header, no remote output. */
      detail: string;
    };

export interface GitPusher {
  push(input: GitPushInput): Promise<GitPushResult>;
}
