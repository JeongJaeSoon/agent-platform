import { createHash } from "node:crypto";
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
  /**
   * What `resolveImage` pinned when the launch was reserved, so the same
   * execution and generation never runs other content after a rollout. A
   * launch reserved before the pin existed carries the host's configured
   * reference instead, and `launchSpec` is then null.
   */
  image: string;
  resources: ExecutionResources;
  /**
   * `launchSpecFingerprint` of the stored image and resources, for the
   * backend to label the resource with and to hold an existing one against
   * before adopting it. Null for a launch reserved before the spec was
   * stored: nothing durable says what it should run, so nothing is judged.
   */
  launchSpec: string | null;
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
  /**
   * The `launchSpec` the resource was labelled with at creation, for the
   * scheduler to hold against the stored spec. Null when it carries no such
   * label; absent when the backend has no such label at all.
   */
  launchSpec?: string | null;
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
  /**
   * A reference to exactly the content `reference` names right now, which
   * this backend can launch again later and get the same thing — for Docker,
   * the image id. Refuses an image it would refuse to launch. Called before
   * a launch is reserved, and the result is stored with it.
   */
  resolveImage(reference: string): Promise<string>;
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
  /**
   * Brings the per-execution isolation resources the backend created back in
   * line with the executions that still exist: removes the ones whose
   * execution is gone, repairs the ones whose attachments were lost.
   * Optional: a backend with no such resources leaves it out. Throws only
   * when it could not even list them.
   */
  reconcileNetworks?(): Promise<NetworkReconcileResult>;
}

export type NetworkReconcileResult = {
  /** Resources removed because nothing uses them any more. */
  removed: string[];
  /** Resources whose attachments had to be restored. */
  repaired: string[];
  /** Resources left as they are because the repair or removal failed. */
  failed: Array<{ id: string; error: string }>;
};

const LAUNCH_SPEC_VERSION = "launch-spec/v1";

/**
 * What a launch was reserved to run, as one value a label can carry and a
 * row can recompute. Versioned so a change to what goes in never makes an
 * old label look like a new one.
 */
export function launchSpecFingerprint(
  image: string,
  resources: ExecutionResources,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        LAUNCH_SPEC_VERSION,
        image,
        resources.cpus,
        resources.memoryBytes,
        resources.pidsLimit,
      ]),
    )
    .digest("hex");
}

/**
 * `value` as launch limits, or a throw naming what is wrong. Every limit has
 * to be a real bound: Docker reads 0 (and for pids, -1) as "no limit".
 */
export function parseExecutionResources(value: unknown): ExecutionResources {
  if (typeof value !== "object" || value === null) {
    throw new Error(
      `Execution resources ${JSON.stringify(value)} are not an object`,
    );
  }
  const { cpus, memoryBytes, pidsLimit } = value as Record<string, unknown>;
  if (typeof cpus !== "number" || !Number.isFinite(cpus) || cpus <= 0) {
    throw new Error(
      `Execution resources cpus ${String(cpus)} is not a positive number`,
    );
  }
  for (const [name, limit] of [
    ["memoryBytes", memoryBytes],
    ["pidsLimit", pidsLimit],
  ] as const) {
    if (!Number.isSafeInteger(limit) || (limit as number) < 1) {
      throw new Error(
        `Execution resources ${name} ${String(limit)} is not a positive integer`,
      );
    }
  }
  return {
    cpus,
    memoryBytes: memoryBytes as number,
    pidsLimit: pidsLimit as number,
  };
}

/**
 * The resource under this launch's name was built from another image or
 * other limits than the launch was reserved with. It is refused rather than
 * adopted, and not removed here: it may hold a credential a worker is
 * presenting right now, and only the scheduler's fenced replacement can
 * take it away without racing that claim.
 */
export class LaunchSpecMismatchError extends Error {
  constructor(
    readonly ref: ExecutionRef,
    readonly found: string,
  ) {
    super(
      `Resource for execution ${ref.executionId} generation ${ref.generation} carries launch spec ${found}, not the one its launch was reserved with; left for the scheduler to replace`,
    );
    this.name = "LaunchSpecMismatchError";
  }
}
