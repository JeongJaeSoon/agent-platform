import type {
  CheckpointRef,
  WorkspaceDescriptor,
} from "@agent-platform/contracts";

/**
 * What a worker found at its workspace root before starting an engine. The
 * root itself is the launcher's business (`WORKER_WORKSPACE_DIR`); what
 * belongs in it comes from the claim's `workspace` descriptor. The volume
 * is named for the session (`workspaceVolumeFor`), so whatever is found
 * there was left by an earlier attempt of this same session.
 */
export type WorkspaceObservation =
  /** The root is absent or empty. */
  | { readonly kind: "empty" }
  /** A git checkout at the root. */
  | {
      readonly kind: "checkout";
      /** `origin` as configured. */
      readonly remoteUrl: string;
      /** The branch HEAD is on; null when detached. */
      readonly branch: string | null;
      /**
       * `git fsck`-level soundness: false for a partial clone that never
       * finished, a shallow history or a corrupt object store.
       */
      readonly healthy: boolean;
      /**
       * Anything that exists only here: uncommitted changes, untracked
       * files, or commits, branches and tags that no ref on `origin`
       * reaches. A clean working tree is not enough to call a checkout
       * disposable.
       */
      readonly localWork: boolean;
    }
  /** Non-empty, but not a git checkout at the root. */
  | { readonly kind: "foreign" };

export type WorkspacePlan =
  /**
   * A committed checkpoint pins the exact tree; the restorer (94S-246) owns
   * it. There is no fallback to a branch clone: the branch head is not the
   * state the transcript was written against.
   */
  | { readonly action: "restore"; readonly checkpoint: CheckpointRef }
  | { readonly action: "clone"; readonly branch: string; readonly url: string }
  /** Same origin, sound: fetch and check the branch out, keep the objects. */
  | { readonly action: "reuse"; readonly branch: string; readonly url: string }
  /** This session's own unsound checkout with nothing to keep: start over. */
  | {
      readonly action: "recreate";
      readonly branch: string;
      readonly reason: string;
      readonly url: string;
    }
  /** Something is here that this policy may not discard: stop and say why. */
  | { readonly action: "refuse"; readonly reason: string };

/**
 * The volume-reuse policy for a session workspace. A worker that comes back
 * to a volume an earlier attempt filled must not trust it blindly: a partial
 * clone, another repository or stray files would put the engine on a tree
 * the session never saw. Only a sound checkout of the same origin is kept, a
 * committed checkpoint always wins over whatever is on disk, and the only
 * thing ever deleted is this session's own unsound checkout that holds no
 * local work. Everything else is refused: a checkout of another repository
 * or a non-git tree is not this policy's to judge, and an explicit recovery
 * step has to decide what to keep.
 */
export function planWorkspacePreparation(input: {
  readonly workspace: WorkspaceDescriptor;
  readonly restore: CheckpointRef | null;
  readonly observed: WorkspaceObservation;
}): WorkspacePlan {
  const { url, branch } = input.workspace.repository;
  if (input.restore) return { action: "restore", checkpoint: input.restore };
  const observed = input.observed;
  switch (observed.kind) {
    case "empty":
      return { action: "clone", branch, url };
    case "foreign":
      return {
        action: "refuse",
        reason: "workspace root holds files that are not a git checkout",
      };
    case "checkout": {
      if (!sameRepository(observed.remoteUrl, url)) {
        return {
          action: "refuse",
          reason: "checkout belongs to another repository",
        };
      }
      if (observed.healthy) return { action: "reuse", branch, url };
      if (observed.localWork) {
        return {
          action: "refuse",
          reason: "checkout is unsound but holds work that exists nowhere else",
        };
      }
      return {
        action: "recreate",
        branch,
        reason: "checkout is incomplete or corrupt and holds no local work",
        url,
      };
    }
  }
}

/** Origin equality that ignores credentials, a trailing slash and `.git`. */
export function sameRepository(left: string, right: string): boolean {
  return canonicalRepositoryUrl(left) === canonicalRepositoryUrl(right);
}

function canonicalRepositoryUrl(url: string): string {
  let bare = url.trim();
  try {
    const parsed = new URL(bare);
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    parsed.search = "";
    bare = `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname}`;
  } catch {
    // scp-like syntax (git@host:path); compare the text as written.
  }
  return bare.replace(/\/+$/, "").replace(/\.git$/, "");
}
