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
};

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
  | { outcome: "generation_mismatch"; foundGeneration: number };

export type ManagedExecution = ExecutionRef & {
  providerRef: string;
  sessionId: string | null;
  state: ExecutionState;
};

export type ExecutionBackendCapabilities = {
  suspend: boolean;
};

export interface ExecutionBackend {
  readonly kind: ExecutionBackendKind;
  capabilities(): ExecutionBackendCapabilities;
  /** Idempotent: creates the resource for `intent` or finds the one it made. */
  ensureExecution(intent: LaunchIntent): Promise<EnsureExecutionResult>;
  inspect(ref: ExecutionRef): Promise<ExecutionObservation>;
  /** Every resource this backend created, whether or not a row still exists. */
  listManaged(): Promise<ManagedExecution[]>;
  /** Stops and removes the resource only when its generation matches. */
  terminate(ref: ExecutionRef): Promise<TerminateExecutionResult>;
}
