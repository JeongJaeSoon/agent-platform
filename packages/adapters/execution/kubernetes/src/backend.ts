import type { ExecutionState } from "@agent-platform/contracts";
import {
  type EnsureExecutionResult,
  type ExecutionBackend,
  type ExecutionBackendCapabilities,
  type ExecutionObservation,
  type ExecutionRef,
  type LaunchIntent,
  LaunchOutcomeUnknownError,
  LaunchSpecMismatchError,
  type ManagedExecution,
  type ManagedWorkspace,
  type TerminateExecutionResult,
  type TerminateOptions,
  type WorkspaceRemovalResult,
} from "@agent-platform/platform";
import {
  KubernetesApiError,
  KubernetesClient,
  KubernetesTimeoutError,
  kubernetesConnectionFromEnv,
  type PersistentVolumeClaim,
  type Pod,
} from "./client.ts";
import {
  type KubernetesBackendConfig,
  type KubernetesBackendEnvironment,
  kubernetesConfigFromEnv,
  validateKubernetesConfig,
} from "./config.ts";
import {
  ANNOTATIONS,
  bootstrapFingerprintOf,
  COMPONENTS,
  ISOLATION_CONTRACT,
  isolationStampFor,
  LABELS,
  nonceSecretFor,
  nonceSecretNameFor,
  nonceSecretNameOf,
  PART_OF,
  podFor,
  podNameFor,
  selectorFor,
  workspaceClaimFor,
  workspaceClaimNameFor,
} from "./specs.ts";

/** How long `terminate` without `waitForExit` waits for the Pod to go. */
const STOP_WAIT_MS = 5_000;
/** Beyond the grace period, for the kubelet to report the Pod gone. */
const DELETE_SLACK_MS = 60_000;
const POLL_MS = 250;

/**
 * `repository@sha256:<digest>`, nothing else: the chart pins every image by
 * digest, and the scheduler never asks a registry what a tag means.
 */
const DIGEST_REFERENCE = /^([^@\s]+)@sha256:[a-f0-9]{64}$/;

export class ImageReferenceError extends Error {
  constructor(readonly reference: string) {
    super(
      `Image ${reference} is not pinned by digest. In kubernetes mode WORKER_IMAGE must be repository@sha256:<digest>; a tag can move under a running session and the scheduler resolves none`,
    );
    this.name = "ImageReferenceError";
  }
}

export class ExecutionConflictError extends Error {
  constructor(
    readonly ref: ExecutionRef,
    readonly expected: string,
    readonly found: string | undefined,
  ) {
    super(
      `Pod for execution ${ref.executionId} generation ${ref.generation} belongs to ${found ?? "<none>"}, not ${expected}`,
    );
    this.name = "ExecutionConflictError";
  }
}

/** See the Docker backend's error of the same name. */
export class IsolationContractError extends Error {
  constructor(
    readonly ref: ExecutionRef,
    readonly found: string,
  ) {
    super(
      `Pod for execution ${ref.executionId} generation ${ref.generation} carries isolation ${found}, newer than this control host's ${ISOLATION_CONTRACT}; roll forward or remove it deliberately`,
    );
    this.name = "IsolationContractError";
  }
}

/**
 * The PVC under this session's workspace name is not one this host would
 * mount. Reported, not fixed: it carries the session's working tree.
 */
export class WorkspaceClaimError extends Error {
  constructor(
    readonly claim: string,
    readonly reason: string,
  ) {
    super(`Workspace claim ${claim} ${reason}`);
    this.name = "WorkspaceClaimError";
  }
}

/**
 * Worker Pods, one per launch, each with a nonce Secret it owns and the
 * session's workspace PVC mounted. Mirrors `LocalDockerBackend`'s rules
 * with the Pod UID as `providerRef`; see README.md for the RBAC it needs.
 */
export class KubernetesBackend implements ExecutionBackend {
  // The contracts enum has no "kubernetes" yet; 94S-524 settles the name.
  readonly kind = "eks_job" as const;
  private readonly config: KubernetesBackendConfig;
  /**
   * The workspace `assertReplaceable` found, per session; see the Docker
   * backend's `replacementWorkspaces`. A replacement whose workspace went
   * missing after the check fails rather than starting on an empty tree.
   */
  private readonly replacementWorkspaces = new Map<string, string>();

  constructor(
    config: KubernetesBackendConfig,
    private readonly client: KubernetesClient,
  ) {
    this.config = validateKubernetesConfig(config);
  }

  capabilities(): ExecutionBackendCapabilities {
    return { suspend: false };
  }

  /** The reference itself, once it is known to name content by digest. */
  async resolveImage(reference: string): Promise<string> {
    const match = DIGEST_REFERENCE.exec(reference);
    const repository = match?.[1] ?? "";
    // `name:tag@sha256:…` runs the digest, but reads as the tag.
    if (match === null || repository.split("/").at(-1)?.includes(":")) {
      throw new ImageReferenceError(reference);
    }
    return reference;
  }

  async ensureExecution(intent: LaunchIntent): Promise<EnsureExecutionResult> {
    const { config, client } = this;
    const name = podNameFor(intent, config.installationId);
    await this.resolveImage(intent.image);
    // Refuses limits this host would refuse before a nonce is spent on them.
    podFor(config, intent, "", "");
    await this.ensureWorkspace(intent.sessionId);
    // Two passes at most, as in the Docker backend: the second follows a
    // lost create race and judges the winner by the same rules.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = await client.get(config.namespace, "pods", name);
      if (existing !== null) {
        if (existing.metadata.deletionTimestamp === undefined) {
          const verdict = this.contractVerdictOf(existing);
          if (verdict === "newer") {
            throw new IsolationContractError(
              intent,
              existing.metadata.annotations?.[ANNOTATIONS.isolation] ??
                "<none>",
            );
          }
          // Ownership first: another launch's Pod is never ours to delete.
          this.assertSameLaunch(intent, existing);
          if (
            verdict === "current" &&
            (await this.holdsAcceptedCredential(intent, existing)) &&
            (await this.canReadItsNonce(existing))
          ) {
            const spec =
              existing.metadata.annotations?.[ANNOTATIONS.launchSpec];
            if (
              intent.launchSpec !== null &&
              spec !== undefined &&
              spec !== intent.launchSpec
            ) {
              throw new LaunchSpecMismatchError(intent, spec);
            }
            return {
              created: false,
              providerRef: uidOf(existing),
              state: stateOf(existing),
            };
          }
          // Older isolation, a credential the registry no longer accepts,
          // or a Pod still waiting on a Secret that never landed: none of
          // them can bind, so it goes and the create path mints anew.
          await this.deleteAndWait(existing, config.stopTimeoutSeconds);
        } else {
          await this.untilGone(
            name,
            uidOf(existing),
            config.stopTimeoutSeconds * 1_000 + DELETE_SLACK_MS,
          );
        }
      }
      const secretName = nonceSecretNameFor(name);
      // Minted here and nowhere else; it reaches only the Secret below.
      const nonce = await intent.issueBootstrapNonce();
      let pod: Pod;
      try {
        pod = await outcomeUnknownOnTimeout(intent, () =>
          client.create(
            config.namespace,
            "pods",
            podFor(config, intent, secretName, bootstrapFingerprintOf(nonce)),
          ),
        );
      } catch (error) {
        if (error instanceof KubernetesApiError && error.status === 409) {
          continue;
        }
        throw error;
      }
      const ref = { name, uid: uidOf(pod) };
      try {
        // The Pod exists before its Secret so the Secret can be owned by
        // it. Until the Secret lands the kubelet holds the container in
        // CreateContainerConfigError and retries; a Secret that never
        // lands leaves a Pending Pod the next pass replaces.
        await outcomeUnknownOnTimeout(intent, () =>
          client.create(
            config.namespace,
            "secrets",
            nonceSecretFor(config, intent, ref, secretName, nonce),
          ),
        );
      } catch (error) {
        if (!(error instanceof LaunchOutcomeUnknownError)) {
          await client
            .delete(config.namespace, "pods", name, {
              gracePeriodSeconds: 0,
              uid: ref.uid,
            })
            .catch(() => undefined);
        }
        throw redact(error, nonce);
      }
      return { created: true, providerRef: ref.uid, state: stateOf(pod) };
    }
    throw new Error(
      `Pod ${name} was taken by another launcher on every attempt`,
    );
  }

  async inspect(ref: ExecutionRef): Promise<ExecutionObservation> {
    const pod = await this.client.get(
      this.config.namespace,
      "pods",
      podNameFor(ref, this.config.installationId),
    );
    const observedAt = new Date();
    if (pod === null) {
      return { found: false, observedAt, providerRef: null, state: "unknown" };
    }
    // Fail closed: a same-named Pod that is not ours is never this
    // execution's healthy resource.
    this.assertOwned(ref, pod);
    const verdict = this.contractVerdictOf(pod);
    if (verdict === "newer") {
      throw new IsolationContractError(
        ref,
        pod.metadata.annotations?.[ANNOTATIONS.isolation] ?? "<none>",
      );
    }
    const state = stateOf(pod);
    const exitCode =
      pod.status?.containerStatuses?.[0]?.state?.terminated?.exitCode;
    const annotations = pod.metadata.annotations ?? {};
    return {
      ...(state === "terminated" && exitCode !== undefined ? { exitCode } : {}),
      credentialFingerprint:
        annotations[ANNOTATIONS.bootstrapFingerprint] ?? null,
      found: true,
      launchSpec: annotations[ANNOTATIONS.launchSpec] ?? null,
      observedAt,
      providerRef: uidOf(pod),
      state,
      ...(verdict === "current" ? {} : { stale: true }),
    };
  }

  /** Nothing but the image and the workspace can refuse a create ahead of time. */
  async assertReplaceable(intent: LaunchIntent): Promise<void> {
    await this.resolveImage(intent.image);
    podFor(this.config, intent, "", "");
    const claim = await this.existingWorkspace(intent.sessionId);
    if (claim !== null) {
      this.replacementWorkspaces.set(intent.sessionId, claim);
    }
  }

  async listManaged(): Promise<ManagedExecution[]> {
    const pods = await this.client.list(
      this.config.namespace,
      "pods",
      selectorFor("worker", this.config.installationId),
    );
    const managed: ManagedExecution[] = [];
    for (const pod of pods) {
      const labels = pod.metadata.labels ?? {};
      const executionId = labels[LABELS.executionId];
      const generation = Number(labels[LABELS.generation]);
      if (!executionId || !Number.isInteger(generation)) continue;
      managed.push({
        executionId,
        generation,
        providerRef: uidOf(pod),
        sessionId: labels[LABELS.sessionId] ?? null,
        state: stateOf(pod),
      });
    }
    return managed;
  }

  async terminate(
    ref: ExecutionRef,
    options: TerminateOptions = {},
  ): Promise<TerminateExecutionResult> {
    const { config, client } = this;
    const name = podNameFor(ref, config.installationId);
    const pod = await client.get(config.namespace, "pods", name);
    if (pod === null) {
      // The name encodes the generation; another one lives under another
      // name. Found only to report it.
      const siblings = await client.list(
        config.namespace,
        "pods",
        selectorFor("worker", config.installationId, {
          [LABELS.executionId]: ref.executionId,
        }),
      );
      const other = siblings
        .map((p) => Number(p.metadata.labels?.[LABELS.generation]))
        .find((g) => Number.isInteger(g) && g !== ref.generation);
      return other === undefined
        ? { outcome: "absent" }
        : { foundGeneration: other, outcome: "generation_mismatch" };
    }
    const labels = pod.metadata.labels ?? {};
    if (labels[LABELS.installation] !== config.installationId) {
      throw new ExecutionConflictError(
        ref,
        config.installationId,
        labels[LABELS.installation],
      );
    }
    const labelled = Number(labels[LABELS.generation]);
    if (labelled !== ref.generation) {
      return { foundGeneration: labelled, outcome: "generation_mismatch" };
    }
    const uid = uidOf(pod);
    if (options.providerRef !== undefined && uid !== options.providerRef) {
      return { foundProviderRef: uid, outcome: "provider_mismatch" };
    }
    if (pod.metadata.deletionTimestamp === undefined) {
      try {
        await client.delete(config.namespace, "pods", name, {
          gracePeriodSeconds: config.stopTimeoutSeconds,
          uid,
        });
      } catch (error) {
        // The precondition held the line: the name now means a replacement.
        if (error instanceof KubernetesApiError && error.status === 409) {
          const now = await client.get(config.namespace, "pods", name);
          return now === null
            ? { outcome: "absent" }
            : { foundProviderRef: uidOf(now), outcome: "provider_mismatch" };
        }
        throw error;
      }
    }
    // The cluster would collect it with the Pod anyway; removing it now
    // keeps the nonce from outliving the terminate.
    await this.removeNonceSecrets(ref, uid).catch(() => undefined);
    const gone = await this.untilGone(
      name,
      uid,
      options.waitForExit === false
        ? Math.min(STOP_WAIT_MS, config.requestTimeoutMs)
        : config.stopTimeoutSeconds * 1_000 + DELETE_SLACK_MS,
    );
    if (!gone) {
      if (options.waitForExit === false) {
        return { outcome: "stopping", providerRef: uid };
      }
      throw new Error(
        `Pod ${name} (${uid}) was deleted but is still there after its grace period`,
      );
    }
    return { outcome: "terminated", providerRef: uid };
  }

  async listWorkspaces(): Promise<ManagedWorkspace[]> {
    const claims = await this.client.list(
      this.config.namespace,
      "persistentvolumeclaims",
      selectorFor("workspace", this.config.installationId),
    );
    // The age gate keeps a launch in flight — claim created, Pod not yet —
    // from being reaped between the two calls.
    const youngerThan = Date.now() - this.config.workspaceGcMinAgeMs;
    const workspaces: ManagedWorkspace[] = [];
    for (const claim of claims) {
      if (claim.metadata.deletionTimestamp !== undefined) continue;
      const createdAt = new Date(claim.metadata.creationTimestamp ?? "");
      if (Number.isNaN(createdAt.getTime())) continue;
      if (createdAt.getTime() > youngerThan) continue;
      workspaces.push({
        createdAt,
        id: claim.metadata.name,
        sessionId: claim.metadata.labels?.[LABELS.sessionId] ?? null,
      });
    }
    return workspaces;
  }

  async removeWorkspace(
    id: string,
    owner?: { sessionId: string },
  ): Promise<WorkspaceRemovalResult> {
    const { config, client } = this;
    // Re-read rather than trusted from the listing: the name may carry
    // another session's claim by now.
    const claim = await client.get(
      config.namespace,
      "persistentvolumeclaims",
      id,
    );
    if (claim === null || claim.metadata.deletionTimestamp !== undefined) {
      return { outcome: "absent" };
    }
    const labels = claim.metadata.labels ?? {};
    if (
      labels[LABELS.partOf] !== PART_OF ||
      labels[LABELS.component] !== COMPONENTS.workspace ||
      labels[LABELS.installation] !== config.installationId ||
      (owner !== undefined && labels[LABELS.sessionId] !== owner.sessionId)
    ) {
      return { outcome: "not_ours" };
    }
    // Any Pod in the namespace, ours or not: the cluster would only hold
    // the claim in Terminating under it, and a new Pod could not mount it.
    const pods = await client.list(config.namespace, "pods");
    if (
      pods.some((pod) =>
        (pod.spec.volumes ?? []).some(
          (volume) => volume.persistentVolumeClaim?.claimName === id,
        ),
      )
    ) {
      return { outcome: "in_use" };
    }
    try {
      const deleted = await client.delete(
        config.namespace,
        "persistentvolumeclaims",
        id,
        { uid: uidOf(claim) },
      );
      if (deleted === null) return { outcome: "absent" };
    } catch (error) {
      // Recreated since the read; judged again on the next pass.
      if (error instanceof KubernetesApiError && error.status === 409) {
        return { outcome: "in_use" };
      }
      throw error;
    }
    return { outcome: "removed" };
  }

  /**
   * The session's claim, created on first use and checked either way. A
   * claim on its way out is refused: a Pod could not mount it, and the
   * tree it held is going with it.
   */
  private async ensureWorkspace(sessionId: string): Promise<void> {
    const { config, client } = this;
    if ((await this.existingWorkspace(sessionId)) !== null) {
      this.replacementWorkspaces.delete(sessionId);
      return;
    }
    const promised = this.replacementWorkspaces.get(sessionId);
    if (promised !== undefined) {
      throw new WorkspaceClaimError(
        promised,
        "is gone since the replacement was checked against it; a new one would start the session on an empty tree",
      );
    }
    try {
      await client.create(
        config.namespace,
        "persistentvolumeclaims",
        workspaceClaimFor(config, sessionId),
      );
    } catch (error) {
      // Lost a create race; the winner is judged like any existing claim.
      if (!(error instanceof KubernetesApiError) || error.status !== 409) {
        throw error;
      }
      if ((await this.existingWorkspace(sessionId)) === null) {
        throw new WorkspaceClaimError(
          workspaceClaimNameFor(sessionId, config.installationId),
          "vanished as it was created",
        );
      }
    }
  }

  /** The session's claim name once it is known to be fit to mount; null when none. */
  private async existingWorkspace(sessionId: string): Promise<string | null> {
    const name = workspaceClaimNameFor(sessionId, this.config.installationId);
    const claim = await this.client.get(
      this.config.namespace,
      "persistentvolumeclaims",
      name,
    );
    if (claim === null) return null;
    const problem = workspaceClaimProblem(claim, sessionId, this.config);
    if (problem !== null) throw new WorkspaceClaimError(name, problem);
    return name;
  }

  private async removeNonceSecrets(
    ref: ExecutionRef,
    podUid: string,
  ): Promise<void> {
    const secrets = await this.client.list(
      this.config.namespace,
      "secrets",
      selectorFor("bootstrap", this.config.installationId, {
        [LABELS.executionId]: ref.executionId,
        [LABELS.generation]: String(ref.generation),
      }),
    );
    for (const secret of secrets) {
      if (!secret.metadata.ownerReferences?.some((o) => o.uid === podUid)) {
        continue;
      }
      await this.client.delete(
        this.config.namespace,
        "secrets",
        secret.metadata.name,
        { uid: uidOf(secret) },
      );
    }
  }

  /** Deletes exactly this Pod, then waits for it to be gone. */
  private async deleteAndWait(pod: Pod, graceSeconds: number): Promise<void> {
    const uid = uidOf(pod);
    try {
      await this.client.delete(
        this.config.namespace,
        "pods",
        pod.metadata.name,
        {
          gracePeriodSeconds: graceSeconds,
          uid,
        },
      );
    } catch (error) {
      // Already replaced by someone else; the next attempt judges that one.
      if (error instanceof KubernetesApiError && error.status === 409) return;
      throw error;
    }
    if (
      !(await this.untilGone(
        pod.metadata.name,
        uid,
        graceSeconds * 1_000 + DELETE_SLACK_MS,
      ))
    ) {
      throw new Error(
        `Pod ${pod.metadata.name} (${uid}) was deleted for replacement but is still there`,
      );
    }
  }

  /** Whether the Pod `uid` names is gone from under `name` within `ms`. */
  private async untilGone(
    name: string,
    uid: string,
    ms: number,
  ): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (;;) {
      const now = await this.client.get(this.config.namespace, "pods", name);
      if (now === null || now.metadata.uid !== uid) return true;
      if (Date.now() >= deadline) return false;
      await Bun.sleep(POLL_MS);
    }
  }

  /**
   * A Pod that has started read its env already; one still Pending needs
   * its Secret to exist and be its own, or it can never start.
   */
  private async canReadItsNonce(pod: Pod): Promise<boolean> {
    if (pod.status?.phase !== undefined && pod.status.phase !== "Pending") {
      return true;
    }
    const name = nonceSecretNameOf(pod);
    if (name === null) return false;
    const secret = await this.client.get(
      this.config.namespace,
      "secrets",
      name,
    );
    return (
      secret !== null &&
      secret.metadata.deletionTimestamp === undefined &&
      (secret.metadata.ownerReferences ?? []).some(
        (owner) => owner.uid === pod.metadata.uid,
      )
    );
  }

  /** Same rule as the Docker backend: judged by label against the registry. */
  private async holdsAcceptedCredential(
    intent: LaunchIntent,
    pod: Pod,
  ): Promise<boolean> {
    const held = pod.metadata.annotations?.[ANNOTATIONS.bootstrapFingerprint];
    if (held === undefined) return true;
    const accepted = await intent.bootstrapCredentialState();
    if (accepted.claimed) return true;
    return accepted.fingerprint !== null && held === accepted.fingerprint;
  }

  private assertSameLaunch(intent: LaunchIntent, pod: Pod): void {
    const operationId = pod.metadata.annotations?.[ANNOTATIONS.operationId];
    if (
      operationId !== intent.operationId ||
      pod.metadata.labels?.[LABELS.installation] !== this.config.installationId
    ) {
      throw new ExecutionConflictError(intent, intent.operationId, operationId);
    }
  }

  private assertOwned(ref: ExecutionRef, pod: Pod): void {
    const labels = pod.metadata.labels ?? {};
    if (
      labels[LABELS.installation] !== this.config.installationId ||
      labels[LABELS.executionId] !== ref.executionId ||
      Number(labels[LABELS.generation]) !== ref.generation
    ) {
      throw new ExecutionConflictError(
        ref,
        `${this.config.installationId}/${ref.executionId}/g${ref.generation}`,
        `${labels[LABELS.installation]}/${labels[LABELS.executionId]}/g${labels[LABELS.generation]}`,
      );
    }
  }

  private contractVerdictOf(pod: Pod): "current" | "newer" | "stale" {
    const stamp = pod.metadata.annotations?.[ANNOTATIONS.isolation];
    if (stamp === undefined) return "stale";
    const version = Number(stamp.split(":")[0]);
    if (!Number.isInteger(version) || version < 1) return "stale";
    if (version > ISOLATION_CONTRACT) return "newer";
    return stamp === isolationStampFor(this.config) ? "current" : "stale";
  }
}

/** The backend as the scheduler builds it: settings and credentials from env. */
export async function kubernetesBackendFromEnv(
  environment: KubernetesBackendEnvironment,
  overrides: Partial<KubernetesBackendConfig> = {},
): Promise<KubernetesBackend> {
  const config = { ...kubernetesConfigFromEnv(environment), ...overrides };
  const client = new KubernetesClient(
    await kubernetesConnectionFromEnv(environment),
    { timeoutMs: config.requestTimeoutMs },
  );
  return new KubernetesBackend(config, client);
}

/** What is wrong with the claim under this session's name, or null. */
export function workspaceClaimProblem(
  claim: PersistentVolumeClaim,
  sessionId: string,
  config: KubernetesBackendConfig,
): string | null {
  if (claim.metadata.deletionTimestamp !== undefined) {
    return "is being deleted; the session's tree is going with it";
  }
  const labels = claim.metadata.labels ?? {};
  if (
    labels[LABELS.partOf] !== PART_OF ||
    labels[LABELS.component] !== COMPONENTS.workspace ||
    labels[LABELS.installation] !== config.installationId ||
    labels[LABELS.sessionId] !== sessionId
  ) {
    return (
      `is not this session's workspace (installation=${labels[LABELS.installation] ?? "<none>"}, ` +
      `session=${labels[LABELS.sessionId] ?? "<none>"})`
    );
  }
  const size = claim.metadata.annotations?.[ANNOTATIONS.workspaceSize];
  if (size !== String(config.workspaceSizeBytes)) {
    return (
      `was created with ${size ?? "<no size>"} bytes, not ${config.workspaceSizeBytes}; ` +
      "this session keeps it until the claim is resized or retired deliberately, or the previous setting is restored"
    );
  }
  return null;
}

/** Pod phase → the platform's execution state. */
export function stateOf(pod: Pod): ExecutionState {
  if (pod.metadata.deletionTimestamp !== undefined) return "terminating";
  switch (pod.status?.phase) {
    case undefined:
    case "Pending":
      return "pending";
    case "Running":
      return "running";
    case "Succeeded":
    case "Failed":
      return "terminated";
    default:
      return "unknown";
  }
}

function uidOf(object: { metadata: { name: string; uid?: string } }): string {
  const uid = object.metadata.uid;
  if (!uid) throw new Error(`${object.metadata.name} carries no uid`);
  return uid;
}

async function outcomeUnknownOnTimeout<T>(
  ref: ExecutionRef,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof KubernetesTimeoutError) {
      throw new LaunchOutcomeUnknownError(ref, { cause: error });
    }
    throw error;
  }
}

/**
 * An API error can quote the request it refused, and the scheduler logs the
 * message: the nonce is blanked out of it first.
 */
function redact(error: unknown, secret: string): unknown {
  if (!(error instanceof Error) || secret === "") return error;
  error.message = error.message.split(secret).join("[redacted]");
  if (error instanceof KubernetesApiError) {
    Object.assign(error, { body: error.body.split(secret).join("[redacted]") });
  }
  return error;
}
