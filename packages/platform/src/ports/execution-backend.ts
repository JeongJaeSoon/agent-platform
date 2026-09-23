import type {
  ExecutionBackend as ExecutionBackendKind,
  ExecutionState,
} from "@agent-platform/contracts";

export type ExecutionResources = {
  /** Fractional CPUs, e.g. 1.5. */
  cpus: number;
  memoryBytes: number;
  pidsLimit: number;
};

/**
 * A durable launch intent: the row committed before any provider call. The
 * same intent handed to `ensureExecution` twice must yield one provider
 * resource, so every field the provider needs is derived from it.
 */
export type LaunchIntent = {
  executionId: string;
  /** Idempotency key for the provider create call; unique per intent. */
  operationId: string;
  sessionId: string;
  generation: number;
  image: string;
  resources: ExecutionResources;
  /**
   * Mints the one-time bootstrap credential for a resource that is about to
   * be created, and returns the plaintext. Only the resource ever holds it;
   * the registry keeps a hash. A backend calls this from the create path
   * alone — issuing invalidates whatever the launch held before, so adopting
   * a resource that already exists must not cut its worker off.
   */
  issueBootstrapNonce: () => Promise<string>;
  /**
   * Which credential the registry accepts for this launch right now. A
   * backend asks before adopting a resource it did not create in this call:
   * one that holds any other credential can never bind, so it is replaced
   * instead of adopted (94S-231). Reading never issues anything, and rejects
   * a launch the registry no longer holds, so nothing is torn down for a
   * launch that could not be created again.
   */
  bootstrapCredentialState: () => Promise<LaunchCredentialState>;
};

/**
 * `claimed`: a worker already traded the credential for a binding, so the
 * resource is bound and its fingerprint no longer matters. Otherwise
 * `fingerprint` is `launchNonceFingerprint` of the stored hash, or null when
 * the launch holds no credential (never issued, or revoked).
 */
export type LaunchCredentialState =
  | { claimed: true }
  | { claimed: false; fingerprint: string | null };

export type ExecutionRef = {
  executionId: string;
  generation: number;
};

export type ExecutionObservation = {
  /** `unknown` with `found: false` means the provider has no such resource. */
  state: ExecutionState;
  found: boolean;
  providerRef: string | null;
  observedAt: Date;
  exitCode?: number;
  /**
   * The resource exists but was created under an older isolation contract,
   * so it does not have the guarantees this control host now promises. The
   * scheduler replaces it rather than reporting it healthy.
   */
  stale?: boolean;
  /**
   * The fingerprint the resource was labelled with at creation, for the
   * scheduler to hold against `ActiveExecution.nonceFingerprint`: a running
   * resource whose credential the registry no longer accepts can never bind
   * and is replaced. Null when the resource carries no label (it predates
   * the label, and cannot be judged); absent when the backend has no such
   * label at all.
   */
  credentialFingerprint?: string | null;
};

export type EnsureExecutionResult = {
  /** false when an earlier call already created the resource. */
  created: boolean;
  providerRef: string;
  state: ExecutionState;
};

export type TerminateExecutionResult =
  | { outcome: "terminated"; providerRef: string }
  | { outcome: "absent" }
  // A resource with that execution id exists but belongs to another
  // generation; it was left untouched.
  | { outcome: "generation_mismatch"; foundGeneration: number }
  // The name resolves to a resource other than the one the caller inspected
  // (`TerminateOptions.providerRef`): something replaced it in between, and
  // it was left untouched.
  | { outcome: "provider_mismatch"; foundProviderRef: string };

export type TerminateOptions = {
  /**
   * The provider's own id of the resource the caller decided to terminate.
   * The name a ref resolves to is deterministic, so between an inspect and
   * the terminate it can come to name a replacement — one another pass
   * built, whose worker may already have bound. Given, the terminate
   * refuses anything but that exact resource.
   */
  providerRef?: string;
};

export type ManagedExecution = ExecutionRef & {
  providerRef: string;
  sessionId: string | null;
  state: ExecutionState;
};

export type ExecutionBackendCapabilities = {
  suspend: boolean;
};

/**
 * A per-session workspace resource the backend created and is responsible
 * for reclaiming — a Docker volume, not a Kubernetes PVC whose lifetime the
 * cluster already owns.
 */
export type ManagedWorkspace = {
  /** What `removeWorkspace` takes; for Docker, the volume name. */
  id: string;
  /** null when the resource carries no session label and cannot be judged. */
  sessionId: string | null;
  createdAt: Date;
};

export type WorkspaceRemovalResult = {
  /**
   * `in_use` and `not_ours` are both "left alone on purpose": something still
   * holds the resource, or it is not this installation's to remove.
   */
  outcome: "removed" | "absent" | "in_use" | "not_ours";
};

export interface ExecutionBackend {
  readonly kind: ExecutionBackendKind;
  capabilities(): ExecutionBackendCapabilities;
  /** Idempotent: creates the resource for `intent` or finds the one it made. */
  ensureExecution(intent: LaunchIntent): Promise<EnsureExecutionResult>;
  inspect(ref: ExecutionRef): Promise<ExecutionObservation>;
  /** Every resource this backend created, whether or not a row still exists. */
  listManaged(): Promise<ManagedExecution[]>;
  /**
   * Stops and removes the resource only when its generation matches, and,
   * when `options.providerRef` is given, only that very resource.
   */
  terminate(
    ref: ExecutionRef,
    options?: TerminateOptions,
  ): Promise<TerminateExecutionResult>;
  /**
   * Refuses unless this intent could be created right now. Replacing a
   * resource destroys the running one first, so the scheduler asks before
   * the teardown rather than discovering at create time that there is
   * nothing to replace it with. Optional: a backend with nothing to check
   * ahead of time leaves it out.
   */
  assertReplaceable?(intent: LaunchIntent): Promise<void>;
  /**
   * Workspaces this backend created and still holds. Optional as a pair: a
   * backend whose workspaces are reclaimed by the platform underneath it
   * leaves both out, and the scheduler then runs no workspace GC at all.
   * Implementations may drop resources too young to judge.
   */
  listWorkspaces?(): Promise<ManagedWorkspace[]>;
  /** Removes it only if it is still this installation's and unused. */
  removeWorkspace?(id: string): Promise<WorkspaceRemovalResult>;
}
