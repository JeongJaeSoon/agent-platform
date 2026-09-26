import { describe, expect, test } from "bun:test";
import {
  bootstrapClaimResponseSchema,
  runtimeConfigSchema,
} from "@agent-platform/contracts";
import { acceptAllCheckpoints } from "../ports/checkpoint-verifier.ts";
import type {
  ClaimInput,
  EgressAuthorization,
  FailResumeInput,
  NextInputInput,
  ReadyInput,
  RestoreBaseInput,
  RestoreBaseResult,
  WorkerUnitOfWork,
} from "../ports/worker-unit-of-work.ts";
import {
  type CatalogProfile,
  type CatalogRepository,
  profileFingerprint,
  repositoryBinding,
  type SessionCatalog,
} from "../sessions/catalog.ts";
import {
  type CheckpointProtocol,
  createWorkerGateway,
  hashWorkerToken,
  WorkerGatewayError,
} from "./worker-gateway.ts";

const scope = {
  session_id: "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d",
  turn_id: null,
  attempt_id: "att_1",
  lease_epoch: 1,
  execution_generation: 1,
  auth_revision: 0,
};
const fingerprint = {
  engine: "claude",
  sdk_version: "0.3.270",
  cli_version: "2.1.270",
  profile_sha256: "c".repeat(64),
};
const principal = {
  kind: "session",
  attemptId: "att_1",
  sessionId: scope.session_id,
  leaseEpoch: scope.lease_epoch,
  executionGeneration: scope.execution_generation,
  authRevision: scope.auth_revision,
} as const;

function unimplemented(): never {
  throw new Error("not reached");
}

function work(overrides: Partial<WorkerUnitOfWork>): WorkerUnitOfWork {
  return {
    registerLaunchAtomic: unimplemented,
    claimAtomic: unimplemented,
    resolveCredential: unimplemented,
    authorizeEgressAtomic: unimplemented,
    recordProviderUsageAtomic: unimplemented,
    nextInputAtomic: unimplemented,
    heartbeatAtomic: unimplemented,
    commitEventsAtomic: unimplemented,
    peekFinalizeAtomic: async () => ({ outcome: "open" }),
    finalizeAtomic: unimplemented,
    checkpointStateAtomic: unimplemented,
    recordRestoreBaseAtomic: unimplemented,
    releaseAtomic: unimplemented,
    readyAtomic: unimplemented,
    failResumeAtomic: unimplemented,
    confirmExecutionGoneAtomic: unimplemented,
    countReservedSlots: unimplemented,
    ...overrides,
  };
}

function gateway(
  overrides: Partial<WorkerUnitOfWork>,
  clock: { now: Date } = { now: new Date("2026-09-22T00:00:00Z") },
) {
  const slept: number[] = [];
  const instance = createWorkerGateway({
    work: work(overrides),
    catalog: { profiles: {}, repositories: {} },
    checkpoints: acceptAllCheckpoints,
    options: {
      sessionCostLimitUsd: 1_000,
      leaseTtlMs: 30_000,
      maxWaitMs: 1_000,
      pollIntervalMs: 100,
      now: () => clock.now,
      sleep: async (ms) => {
        slept.push(ms);
        clock.now = new Date(clock.now.getTime() + ms);
      },
    },
  });
  return { instance, slept };
}

describe("WorkerGateway", () => {
  test("nextInput polls until input arrives and caps wait_ms at maxWaitMs", async () => {
    let calls = 0;
    const seen: NextInputInput[] = [];
    const { instance, slept } = gateway({
      async nextInputAtomic(input) {
        seen.push(input);
        calls += 1;
        return {
          outcome: "ok",
          leaseExpiresAt: new Date(input.now.getTime() + 30_000),
          input:
            calls === 3
              ? {
                  turnId: "1",
                  inputId: "7",
                  message: "go",
                  deliveryStartedAt: input.now,
                }
              : null,
        };
      },
    });
    const response = await instance.nextInput(principal, {
      ...scope,
      wait_ms: 60_000,
    });
    expect(response.input?.turn_id).toBe("1");
    expect(slept).toEqual([100, 100]);
    expect(seen[0]?.fence).toEqual({
      sessionId: scope.session_id,
      attemptId: "att_1",
      leaseEpoch: 1,
      executionGeneration: 1,
      authRevision: 0,
    });

    calls = 0;
    const empty = gateway({
      async nextInputAtomic(input) {
        calls += 1;
        return {
          outcome: "ok",
          input: null,
          leaseExpiresAt: new Date(input.now.getTime() + 30_000),
        };
      },
    });
    const none = await empty.instance.nextInput(principal, {
      ...scope,
      wait_ms: 60_000,
    });
    expect(none.input).toBeNull();
    // 1s cap at 100ms per poll: ten sleeps, eleven attempts.
    expect(empty.slept).toHaveLength(10);
    expect(calls).toBe(11);
  });

  test("nextInput without wait_ms asks once", async () => {
    let calls = 0;
    const { instance, slept } = gateway({
      async nextInputAtomic(input) {
        calls += 1;
        return {
          outcome: "ok",
          input: null,
          leaseExpiresAt: new Date(input.now.getTime() + 30_000),
        };
      },
    });
    await instance.nextInput(principal, scope);
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
  });

  test("fence rejections map to 409 LEASE_EXPIRED / STALE_EPOCH", async () => {
    const { instance } = gateway({
      async heartbeatAtomic() {
        return { outcome: "lease_expired" };
      },
      async commitEventsAtomic() {
        return { outcome: "stale_epoch" };
      },
    });
    await expect(
      instance.heartbeat(principal, { ...scope, attempt_state: "running" }),
    ).rejects.toMatchObject({ status: 409, code: "LEASE_EXPIRED" });
    await expect(
      instance.appendEvents(principal, {
        ...scope,
        batch_key: "b",
        events: [
          {
            event: "status",
            data: { phase: "running" },
            source_sequence: 1,
            occurred_at: "2026-09-22T00:00:00.000Z",
          },
        ],
      }),
    ).rejects.toMatchObject({ status: 409, code: "STALE_EPOCH" });
  });

  test("finalize consults the checkpoint verifier before the transaction", async () => {
    let committed = 0;
    // The verifier has to be able to prove the manifest belongs to *this*
    // attempt, so it gets the whole fence and the turn, not just the session.
    const asked: unknown[] = [];
    const instance = createWorkerGateway({
      work: work({
        async finalizeAtomic() {
          committed += 1;
          return unimplemented();
        },
      }),
      catalog: { profiles: {}, repositories: {} },
      checkpoints: {
        async verify(input) {
          asked.push(input);
          return { status: "rejected", reason: "sha mismatch" };
        },
      },
      options: { sessionCostLimitUsd: 1_000, leaseTtlMs: 30_000 },
    });
    await expect(
      instance.finalize(principal, {
        ...scope,
        turn_id: "1",
        finalize_key: "f",
        final_source_sequence: 0,
        terminal: {
          status: "completed",
          reason: null,
          result: null,
          usage: null,
        },
        checkpoint: {
          revision: 1,
          manifest_ref: "ref",
          manifest_sha256: "0".repeat(64),
        },
      }),
    ).rejects.toMatchObject({ status: 409, code: "CHECKPOINT_UNAVAILABLE" });
    expect(committed).toBe(0);
    expect(asked).toEqual([
      {
        fence: {
          sessionId: scope.session_id,
          attemptId: scope.attempt_id,
          leaseEpoch: scope.lease_epoch,
          executionGeneration: scope.execution_generation,
          authRevision: scope.auth_revision,
        },
        turnId: "1",
        checkpoint: {
          revision: 1,
          manifest_ref: "ref",
          manifest_sha256: "0".repeat(64),
        },
        at: expect.any(Date),
      },
    ]);
  });

  test("a committed finalize replays without asking the verifier again", async () => {
    let verified = 0;
    let committed = 0;
    const instance = createWorkerGateway({
      work: work({
        async peekFinalizeAtomic() {
          return {
            outcome: "replayed",
            result: {
              turnId: "1",
              status: "completed",
              checkpointRevision: 3,
            },
          };
        },
        async finalizeAtomic() {
          committed += 1;
          throw new Error("not reached");
        },
      }),
      catalog: { profiles: {}, repositories: {} },
      checkpoints: {
        async verify() {
          verified += 1;
          return { status: "rejected", reason: "storage is unreachable" };
        },
      },
      options: { sessionCostLimitUsd: 1_000, leaseTtlMs: 30_000 },
    });
    // The turn is already terminal, so a verifier that happens to be down
    // must not hide a result the worker has no other way to learn.
    expect(
      await instance.finalize(principal, {
        ...scope,
        turn_id: "1",
        finalize_key: "f",
        final_source_sequence: 0,
        terminal: {
          status: "completed",
          reason: null,
          result: null,
          usage: null,
        },
        checkpoint: {
          revision: 3,
          manifest_ref: "ref",
          manifest_sha256: "0".repeat(64),
        },
      }),
    ).toEqual({ turn_id: "1", status: "completed", checkpoint_revision: 3 });
    expect([verified, committed]).toEqual([0, 0]);
  });

  test("a short wait_ms is not rounded up to a whole poll interval", async () => {
    const slept: number[] = [];
    let at = new Date("2026-09-22T00:00:00.000Z");
    const instance = createWorkerGateway({
      work: work({
        async nextInputAtomic() {
          return {
            outcome: "ok",
            input: null,
            leaseExpiresAt: new Date(at.getTime() + 30_000),
          };
        },
      }),
      catalog: { profiles: {}, repositories: {} },
      checkpoints: {
        async verify() {
          return { status: "verified" };
        },
      },
      options: {
        sessionCostLimitUsd: 1_000,
        leaseTtlMs: 30_000,
        pollIntervalMs: 250,
        now: () => at,
        sleep: async (ms: number) => {
          slept.push(ms);
          at = new Date(at.getTime() + ms);
        },
      },
    });
    await instance.nextInput(principal, { ...scope, wait_ms: 1 });
    expect(slept).toEqual([1]);
  });

  test("registerLaunch refuses a backend the session contract cannot name", async () => {
    let persisted = 0;
    const { instance } = gateway({
      async registerLaunchAtomic() {
        persisted += 1;
        return { outcome: "registered" };
      },
    });
    await expect(
      instance.registerLaunch({
        executionId: "e-1",
        generation: 1,
        // A caller outside TypeScript can still send this, and the value is
        // read back through the public session contract.
        backend: "kubernetes" as never,
      }),
    ).rejects.toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect(persisted).toBe(0);
  });

  test("authenticate hashes the bearer token and rejects unknown ones", async () => {
    const seen: Uint8Array[] = [];
    const { instance } = gateway({
      async resolveCredential(hash) {
        seen.push(hash);
        return null;
      },
    });
    await expect(instance.authenticate("wsc_x")).rejects.toBeInstanceOf(
      WorkerGatewayError,
    );
    await expect(instance.authenticate(null)).rejects.toMatchObject({
      status: 401,
    });
    expect(seen).toEqual([hashWorkerToken("wsc_x")]);
  });

  test("bootstrapClaim answers the row's repository and the catalog's resolved profile", async () => {
    const binding = {
      sessionId: scope.session_id,
      attemptId: "att_1",
      leaseEpoch: 1,
      executionGeneration: 1,
      authRevision: 0,
      leaseExpiresAt: new Date("2026-09-22T00:00:30Z"),
      leaseRemainingMs: 29_950,
      profileId: "claude-coding-v1",
      ownerScope: "owner-a",
      repository: {
        id: "gone-from-catalog",
        url: "https://example.invalid/team/app.git",
        branch: "release",
      },
      restore: null,
      costUsd: 250.5,
    };
    const profile = {
      runtime_kind: "claude_agent_sdk" as const,
      runtime_version: "0.3.270",
      model: "claude-sonnet-5",
      tools: ["Read"],
      permission_mode: "plan" as const,
      provider: {
        kind: "anthropic" as const,
        endpoint: "https://api.anthropic.invalid",
        auth: {
          kind: "api_key" as const,
          value: "provider-key",
          ref: { value_env: "PROVIDER_KEY" },
        },
      },
      project_settings: { claude_md: true },
    };
    const runnable: unknown[] = [];
    const issued: ClaimInput["egress"][] = [];
    const instance = createWorkerGateway({
      work: work({
        claimAtomic: async (input) => {
          runnable.push(input.runnable);
          issued.push(input.egress);
          return { outcome: "claimed", binding };
        },
      }),
      catalog: {
        profiles: { "claude-coding-v1": profile, other: profile },
        repositories: {
          "sample-app": {
            url: "https://example.invalid/app.git",
            branch: "main",
            profiles: ["claude-coding-v1", "other"],
          },
          docs: {
            url: "https://example.invalid/docs.git",
            branch: "trunk",
            profiles: ["other"],
          },
        },
      },
      checkpoints: acceptAllCheckpoints,
      options: { sessionCostLimitUsd: 1_000, leaseTtlMs: 30_000 },
    });
    const request = {
      execution_id: "e",
      execution_generation: 1,
      credential: { kind: "launch_nonce" as const, nonce: "n" },
    };
    const claimed = await instance.bootstrapClaim(
      { kind: "bootstrap" },
      request,
    );
    // The repository comes from the row, with the attempt's token for the
    // proxy's read-only route beside it — never a credential for the host.
    expect(claimed.workspace).toEqual({
      repository: {
        ...binding.repository,
        access: { kind: "egress_token", token: expect.stringMatching(/^wer_/) },
      },
    });
    // The worker tracks the remainder the store measured, not the deadline.
    expect(claimed.lease_remaining_ms).toBe(29_950);
    // The claim may bind only what the catalog pairs, at the URL and branch
    // it registers now (94S-258), with the profile's settings as hashed now
    // (94S-253): one entry per allowed pair, nothing else.
    const fingerprint = profileFingerprint(profile);
    expect(runnable).toEqual([
      [
        {
          profileId: "claude-coding-v1",
          profileFingerprint: fingerprint,
          repositoryId: "sample-app",
          url: "https://example.invalid/app.git",
          branch: "main",
        },
        {
          profileId: "other",
          profileFingerprint: fingerprint,
          repositoryId: "sample-app",
          url: "https://example.invalid/app.git",
          branch: "main",
        },
        {
          profileId: "other",
          profileFingerprint: fingerprint,
          repositoryId: "docs",
          url: "https://example.invalid/docs.git",
          branch: "trunk",
        },
      ],
    ]);
    // The row's owner partition, not anything from the shared catalog: it is
    // the checkpoint principal the worker hashes (94S-209 / 94S-261).
    expect(claimed.principal).toEqual({ owner_scope: "owner-a" });
    expect(claimed.runtime).toEqual({
      kind: "claude_agent_sdk",
      version: "0.3.270",
      profile_id: "claude-coding-v1",
    });
    // Neither the provider key nor where the catalog found it rides
    // (94S-252): the worker gets the upstream to name and a token for the
    // proxy, whose hash is what the claim stored.
    expect(claimed.runtime_config).toEqual({
      model: "claude-sonnet-5",
      tools: ["Read"],
      permission_mode: "plan",
      provider: {
        kind: "anthropic",
        endpoint: "https://api.anthropic.invalid",
        auth: { kind: "egress_token", token: expect.stringMatching(/^wep_/) },
      },
      project_settings: { claude_md: true },
    });
    expect(JSON.stringify(claimed)).not.toContain("provider-key");
    const [egress] = issued;
    if (!egress) throw new Error("claim was not asked to issue egress tokens");
    expect(egress.providerHash).toEqual(
      hashWorkerToken(claimed.runtime_config.provider.auth.token),
    );
    expect(egress.repositoryHash).toEqual(
      hashWorkerToken(claimed.workspace.repository.access?.token ?? ""),
    );
    expect(egress.objectStoreHash).toEqual(
      hashWorkerToken(claimed.object_store.access.token),
    );
    expect(claimed.object_store.access.token).toMatch(/^weo_/);
    expect(
      egress.bindingsOf({
        id: "s-1",
        profileId: "claude-coding-v1",
        repositoryId: "sample-app",
      }),
    ).toEqual({
      object_store: "sessions/s-1/",
      provider: profileFingerprint(profile),
      repository: repositoryBinding("sample-app", {
        url: "https://example.invalid/app.git",
        branch: "main",
        profiles: ["claude-coding-v1", "other"],
      }),
    });
    expect(claimed.profile_fingerprint).toBe(profileFingerprint(profile));
    expect(claimed.profile_fingerprint).not.toContain("provider-key");
    // The engine's own budget is what the session has left (94S-279).
    expect(claimed.remaining_budget_usd).toBe(749.5);
    // Off leaves the field out, so the answer is one a worker built before it
    // still reads: its schema was this one without the field, and strict.
    const beforeTheField = bootstrapClaimResponseSchema.extend({
      runtime_config: runtimeConfigSchema.omit({ project_settings: true }),
    });
    expect(beforeTheField.safeParse(claimed).success).toBe(false);
    const off = createWorkerGateway({
      work: work({
        claimAtomic: async () => ({ outcome: "claimed", binding }),
      }),
      catalog: {
        profiles: {
          "claude-coding-v1": {
            ...profile,
            project_settings: { claude_md: false },
          },
        },
        repositories: {},
      },
      checkpoints: acceptAllCheckpoints,
      options: { sessionCostLimitUsd: 1_000, leaseTtlMs: 30_000 },
    });
    const offClaim = await off.bootstrapClaim({ kind: "bootstrap" }, request);
    expect("project_settings" in offClaim.runtime_config).toBe(false);
    expect(
      beforeTheField.safeParse(bootstrapClaimResponseSchema.parse(offClaim))
        .success,
    ).toBe(true);
    // A profile the catalog lost between the row's binding and this replay
    // is refused rather than answered with a guess.
    const stranger = createWorkerGateway({
      work: work({
        claimAtomic: async () => ({ outcome: "replayed", binding }),
      }),
      catalog: { profiles: {}, repositories: {} },
      checkpoints: acceptAllCheckpoints,
      options: { sessionCostLimitUsd: 1_000, leaseTtlMs: 30_000 },
    });
    await expect(
      stranger.bootstrapClaim({ kind: "bootstrap" }, request),
    ).rejects.toMatchObject({ status: 409, code: "BACKEND_UNAVAILABLE" });
    // A replay does not check the budget, so a session that spent past it
    // in between is answered with nothing left rather than a negative.
    const spent = createWorkerGateway({
      work: work({
        claimAtomic: async () => ({
          outcome: "replayed",
          binding: { ...binding, costUsd: 1_000.25 },
        }),
      }),
      catalog: { profiles: { "claude-coding-v1": profile }, repositories: {} },
      checkpoints: acceptAllCheckpoints,
      options: { sessionCostLimitUsd: 1_000, leaseTtlMs: 30_000 },
    });
    const spentClaim = await spent.bootstrapClaim(
      { kind: "bootstrap" },
      request,
    );
    expect(spentClaim.remaining_budget_usd).toBe(0);
    expect(bootstrapClaimResponseSchema.safeParse(spentClaim).success).toBe(
      true,
    );
  });

  test("bootstrapClaim answers a launch whose session was failed for a catalog mismatch with a final 409 (94S-280)", async () => {
    const { instance } = gateway({
      claimAtomic: async () => ({ outcome: "catalog_mismatch" }),
    });
    await expect(
      instance.bootstrapClaim(
        { kind: "bootstrap" },
        {
          execution_id: "exec-1",
          execution_generation: 1,
          credential: { kind: "launch_nonce", nonce: "nonce" },
        },
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "CATALOG_MISMATCH",
      retryable: false,
    });
  });

  test("bootstrapClaim refuses workload_identity and non-bootstrap principals", async () => {
    const { instance } = gateway({});
    await expect(
      instance.bootstrapClaim(
        { kind: "bootstrap" },
        {
          execution_id: "e",
          execution_generation: 1,
          credential: { kind: "workload_identity", job_uid: "j" },
        },
      ),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(
      instance.bootstrapClaim(principal, {
        execution_id: "e",
        execution_generation: 1,
        credential: { kind: "launch_nonce", nonce: "n" },
      }),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  test("requestCheckpoint records the runtime's durable refusal, then answers from the fenced pointer", async () => {
    const stateCalls: unknown[] = [];
    const protocolCalls: unknown[] = [];
    const pointer = {
      committedAt: new Date("2026-09-22T00:00:00Z"),
      manifestRef: "sessions/s/checkpoints/0000000003/att_1/manifest.json",
      manifestSha256: "a".repeat(64),
      revision: 3,
      turnId: "4",
    };
    const instance = createWorkerGateway({
      work: work({
        async checkpointStateAtomic(input) {
          stateCalls.push(input);
          return {
            outcome: "ok",
            pointer,
            restorable: true,
            pendingReason: null,
          };
        },
      }),
      catalog: { profiles: {}, repositories: {} },
      checkpoints: acceptAllCheckpoints,
      checkpointProtocol: {
        async requestCheckpoint(input) {
          protocolCalls.push(input);
          return {
            status: "ready",
            request: {
              manifestRef:
                "sessions/s/checkpoints/0000000004/att_1/manifest.json",
              revision: 4,
              sessionId: input.sessionId,
            },
          };
        },
        async getRestorePlan() {
          return unimplemented();
        },
      },
      options: { sessionCostLimitUsd: 1_000, leaseTtlMs: 30_000 },
    });
    expect(
      await instance.requestCheckpoint(principal, {
        ...scope,
        preparation: { status: "ready" },
      }),
    ).toEqual({
      status: "ready",
      revision: 4,
      manifest_ref: "sessions/s/checkpoints/0000000004/att_1/manifest.json",
    });
    // The pointer the protocol sees is the one the fenced read returned.
    expect(protocolCalls).toEqual([
      {
        attemptId: "att_1",
        preparation: { status: "ready" },
        sessionId: scope.session_id,
        pointer,
      },
    ]);
    // A ready preparation records nothing.
    expect(stateCalls).toHaveLength(1);
    expect(stateCalls[0]).not.toHaveProperty("pendingReason");

    // A mirror failure is the one refusal that outlives the turn: it is
    // written before the answer, so a crash in between cannot lose it.
    expect(
      await instance.requestCheckpoint(principal, {
        ...scope,
        preparation: {
          status: "rejected",
          reason: "mirror_error",
          detail: "batch 7 dropped",
        },
      }),
    ).toEqual({
      status: "blocked",
      reason: "mirror_error",
      detail: "batch 7 dropped",
    });
    expect(stateCalls[1]).toMatchObject({ pendingReason: "mirror_error" });
    // A turn in flight is an ordinary state and leaves nothing behind.
    await instance.requestCheckpoint(principal, {
      ...scope,
      preparation: {
        status: "rejected",
        reason: "turn_in_flight",
        detail: "input pending",
      },
    });
    expect(stateCalls[2]).not.toHaveProperty("pendingReason");
    // The protocol was consulted for the ready request only: a refusal is
    // answered without reading the pointer.
    expect(protocolCalls).toHaveLength(1);
  });

  test("checkpoint protocol calls are fenced and refused outright without an object store", async () => {
    const fenced = createWorkerGateway({
      work: work({
        async checkpointStateAtomic() {
          return { outcome: "stale_epoch" };
        },
      }),
      catalog: { profiles: {}, repositories: {} },
      checkpoints: acceptAllCheckpoints,
      checkpointProtocol: {
        requestCheckpoint: unimplemented,
        getRestorePlan: unimplemented,
      },
      options: { sessionCostLimitUsd: 1_000, leaseTtlMs: 30_000 },
    });
    await expect(
      fenced.requestCheckpoint(principal, {
        ...scope,
        preparation: { status: "ready" },
      }),
    ).rejects.toMatchObject({ status: 409, code: "STALE_EPOCH" });
    await expect(
      fenced.restorePlan(principal, { ...scope, runtime: fingerprint }),
    ).rejects.toMatchObject({ status: 409, code: "STALE_EPOCH" });

    const { instance } = gateway({});
    for (const call of [
      () =>
        instance.requestCheckpoint(principal, {
          ...scope,
          preparation: { status: "ready" },
        }),
      () => instance.restorePlan(principal, { ...scope, runtime: fingerprint }),
    ]) {
      await expect(call()).rejects.toMatchObject({
        status: 409,
        code: "CHECKPOINT_UNAVAILABLE",
      });
    }
  });

  test("restorePlan never plans a restore from a pointer that is not a restore point (94S-288)", async () => {
    // A start_fresh decision retired this pointer: the claim handed out no
    // restore, and a worker asking anyway must not be given the old engine
    // session's transcript either.
    const seen: unknown[] = [];
    const instance = createWorkerGateway({
      work: work({
        async checkpointStateAtomic() {
          return {
            outcome: "ok",
            pointer: {
              committedAt: new Date("2026-09-23T00:00:00Z"),
              manifestRef: "sessions/s/checkpoints/0000000000/att_1/m.json",
              manifestSha256: "a".repeat(64),
              revision: 0,
              turnId: "1",
            },
            restorable: false,
            pendingReason: null,
          };
        },
        // The refusal a missing plan leads to reaches the resume check,
        // which leaves a session that is not resuming alone.
        async failResumeAtomic() {
          return { outcome: "ok", failed: false };
        },
      }),
      catalog: { profiles: {}, repositories: {} },
      checkpoints: acceptAllCheckpoints,
      checkpointProtocol: {
        requestCheckpoint: unimplemented,
        async getRestorePlan(input) {
          seen.push(input.pointer);
          return { status: "none" };
        },
      },
      options: { sessionCostLimitUsd: 1_000, leaseTtlMs: 30_000 },
    });
    expect(
      await instance.restorePlan(principal, { ...scope, runtime: fingerprint }),
    ).toEqual({ status: "none" });
    expect(seen).toEqual([null]);
  });

  test("restorePlan puts the service's plan on the wire and passes refusals through", async () => {
    const seen: unknown[] = [];
    const recorded: RestoreBaseInput[] = [];
    let base: RestoreBaseResult = { outcome: "ok" };
    const failed: FailResumeInput[] = [];
    let resuming = false;
    let answer: Awaited<ReturnType<CheckpointProtocol["getRestorePlan"]>> = {
      status: "none",
    };
    const instance = createWorkerGateway({
      work: work({
        async checkpointStateAtomic() {
          return {
            outcome: "ok",
            pointer: null,
            restorable: false,
            pendingReason: null,
          };
        },
        async recordRestoreBaseAtomic(input) {
          recorded.push(input);
          return base;
        },
        async failResumeAtomic(input) {
          failed.push(input);
          return { outcome: "ok", failed: resuming };
        },
      }),
      catalog: { profiles: {}, repositories: {} },
      checkpoints: acceptAllCheckpoints,
      checkpointProtocol: {
        requestCheckpoint: unimplemented,
        async getRestorePlan(input) {
          seen.push(input);
          return answer;
        },
      },
      options: { sessionCostLimitUsd: 1_000, leaseTtlMs: 30_000 },
    });
    expect(
      await instance.restorePlan(principal, { ...scope, runtime: fingerprint }),
    ).toEqual({ status: "none" });
    expect(seen).toEqual([
      {
        runtime: {
          cliVersion: "2.1.270",
          engine: "claude",
          profileSha256: "c".repeat(64),
          sdkVersion: "0.3.270",
        },
        sessionId: scope.session_id,
        pointer: null,
      },
    ]);

    const object = {
      key: "sessions/s/mirror/root-0.jsonl",
      bytes: 3,
      sha256: "b".repeat(64),
    };
    const bundle = {
      key: "sessions/s/checkpoints/0000000000/att_1/workspace.bundle",
      bytes: 9,
      sha256: "d".repeat(64),
    };
    answer = {
      status: "ready",
      plan: {
        artifacts: [
          { kind: "transcript_root", label: "", objects: [object] },
          { kind: "workspace_bundle", label: "", objects: [bundle] },
          {
            kind: "workspace_untracked",
            label: "",
            objects: [
              { ...object, path: "notes.md" },
              { ...object, executable: true, path: "bin/tool" },
            ],
          },
        ],
        cwd: "/workspace",
        engine: "claude",
        gitCommit: "e".repeat(40),
        manifestRef: "sessions/s/checkpoints/0000000000/att_1/manifest.json",
        manifestSha256: "f".repeat(64),
        objectKeys: [object.key, bundle.key],
        resume: "sdk-session",
        revision: 0,
      },
    };
    expect(
      await instance.restorePlan(principal, { ...scope, runtime: fingerprint }),
    ).toEqual({
      status: "ready",
      plan: {
        revision: 0,
        manifest_ref: "sessions/s/checkpoints/0000000000/att_1/manifest.json",
        manifest_sha256: "f".repeat(64),
        engine: "claude",
        resume: "sdk-session",
        cwd: "/workspace",
        git_commit: "e".repeat(40),
        artifacts: [
          { kind: "transcript_root", label: "", objects: [object] },
          { kind: "workspace_bundle", label: "", objects: [bundle] },
          {
            kind: "workspace_untracked",
            label: "",
            objects: [
              { ...object, path: "notes.md" },
              { ...object, executable: true, path: "bin/tool" },
            ],
          },
        ],
        object_keys: [object.key, bundle.key],
      },
    });

    // An earlier revision restored in the pointer's place says so on the
    // wire too (94S-204).
    if (answer.status !== "ready") throw new Error("expected a plan");
    answer = {
      status: "ready",
      plan: {
        ...answer.plan,
        fallback: {
          pointerRevision: 1,
          skipped: [{ revision: 1, reason: "manifest object is missing" }],
        },
      },
    };
    expect(
      await instance.restorePlan(principal, { ...scope, runtime: fingerprint }),
    ).toMatchObject({
      status: "ready",
      plan: {
        revision: 0,
        fallback: {
          pointer_revision: 1,
          skipped: [{ revision: 1, reason: "manifest object is missing" }],
        },
      },
    });
    // Each ready plan is recorded before it is handed out: the plain one
    // clears any earlier fallback, this one records its own.
    expect(recorded.map((input) => input.fallback)).toEqual([
      null,
      {
        revision: 0,
        skipped: [{ revision: 1, reason: "manifest object is missing" }],
      },
    ]);
    for (const [result, expected] of [
      [
        { outcome: "pointer_moved", currentRevision: 2 },
        { status: 409, code: "REVISION_CONFLICT" },
      ],
      [
        { outcome: "base_changed", recordedRevision: 3 },
        { status: 409, code: "CHECKPOINT_UNAVAILABLE" },
      ],
      [{ outcome: "stale_epoch" }, { status: 409, code: "STALE_EPOCH" }],
    ] as const) {
      base = result;
      await expect(
        instance.restorePlan(principal, { ...scope, runtime: fingerprint }),
      ).rejects.toMatchObject(expected);
    }
    base = { outcome: "ok" };

    // A resume from `paused` promised the pointer's state: a fallback ends
    // it for an operator instead of quietly resuming older state, and is not
    // recorded as the session's base (94S-138 with 94S-204).
    resuming = true;
    const before = recorded.length;
    await expect(
      instance.restorePlan(principal, { ...scope, runtime: fingerprint }),
    ).rejects.toMatchObject({ status: 409, code: "CHECKPOINT_UNAVAILABLE" });
    expect(recorded).toHaveLength(before);
    resuming = false;

    answer = {
      status: "incompatible",
      code: "INCOMPATIBLE_CHECKPOINT",
      mismatches: [
        { field: "sdkVersion", expected: "0.3.270", found: "0.3.1" },
      ],
    };
    expect(
      await instance.restorePlan(principal, { ...scope, runtime: fingerprint }),
    ).toEqual({
      status: "incompatible",
      code: "INCOMPATIBLE_CHECKPOINT",
      mismatches: [
        { field: "sdkVersion", expected: "0.3.270", found: "0.3.1" },
      ],
    });
    answer = {
      status: "incompatible",
      code: "INCOMPATIBLE_CHECKPOINT",
      mismatches: [
        { field: "sdkVersion", expected: "0.3.270", found: "0.3.1" },
      ],
      fallback: {
        pointerRevision: 1,
        revision: 0,
        skipped: [{ revision: 1, reason: "manifest object is missing" }],
      },
    };
    expect(
      await instance.restorePlan(principal, { ...scope, runtime: fingerprint }),
    ).toMatchObject({
      status: "incompatible",
      fallback: {
        pointer_revision: 1,
        revision: 0,
        skipped: [{ revision: 1, reason: "manifest object is missing" }],
      },
    });
    answer = {
      status: "unavailable",
      code: "CHECKPOINT_UNAVAILABLE",
      reason: "manifest object is missing",
    };
    expect(
      await instance.restorePlan(principal, { ...scope, runtime: fingerprint }),
    ).toEqual({
      status: "unavailable",
      code: "CHECKPOINT_UNAVAILABLE",
      reason: "manifest object is missing",
    });
    // Every refusal and every fallback is offered to a resume from `paused`
    // standing on that pointer (94S-138); a plain plan is not.
    const fellBack = [
      1,
      "CHECKPOINT_UNAVAILABLE",
      "the resume could not restore its checkpoint: revision 1 is damaged and only revision 0 verifies",
    ];
    const incompatible = [
      null,
      "CHECKPOINT_UNAVAILABLE",
      "the resume could not restore its checkpoint: the checkpoint is incompatible with this worker: sdkVersion 0.3.270 != 0.3.1",
    ];
    expect(
      failed.map((input) => [
        input.pointerRevision,
        input.error.code,
        input.error.message,
      ]),
    ).toEqual([
      [
        null,
        "CHECKPOINT_UNAVAILABLE",
        "the resume could not restore its checkpoint: no committed checkpoint to restore",
      ],
      // The fallback plan, the three recording outcomes, and the resume.
      fellBack,
      fellBack,
      fellBack,
      fellBack,
      fellBack,
      incompatible,
      incompatible,
      [
        null,
        "CHECKPOINT_UNAVAILABLE",
        "the resume could not restore its checkpoint: manifest object is missing",
      ],
    ]);
  });

  test("ready reports the restored revision and maps a failed resume to 409 CHECKPOINT_UNAVAILABLE", async () => {
    const seen: ReadyInput[] = [];
    let answer: Awaited<ReturnType<WorkerUnitOfWork["readyAtomic"]>> = {
      outcome: "ok",
      activated: true,
    };
    const { instance } = gateway({
      async readyAtomic(input) {
        seen.push(input);
        return answer;
      },
    });
    expect(
      await instance.ready(principal, { ...scope, restored_revision: 3 }),
    ).toEqual({ activated: true });
    expect(seen[0]?.restoredRevision).toBe(3);
    expect(seen[0]?.fence.attemptId).toBe(scope.attempt_id);

    answer = { outcome: "restore_mismatch" };
    await expect(
      instance.ready(principal, { ...scope, restored_revision: 3 }),
    ).rejects.toMatchObject({ status: 409, code: "CHECKPOINT_UNAVAILABLE" });
    answer = { outcome: "stale_epoch" };
    await expect(
      instance.ready(principal, { ...scope, restored_revision: null }),
    ).rejects.toMatchObject({ status: 409, code: "STALE_EPOCH" });
  });

  test("a restore refusal from an attempt that lost the session answers STALE_EPOCH", async () => {
    const instance = createWorkerGateway({
      work: work({
        async checkpointStateAtomic() {
          return {
            outcome: "ok",
            pointer: null,
            pendingReason: null,
            restorable: false,
          };
        },
        async failResumeAtomic() {
          return { outcome: "stale_epoch" };
        },
      }),
      catalog: { profiles: {}, repositories: {} },
      checkpoints: acceptAllCheckpoints,
      checkpointProtocol: {
        requestCheckpoint: unimplemented,
        async getRestorePlan() {
          return { status: "none" };
        },
      },
      options: { sessionCostLimitUsd: 1_000, leaseTtlMs: 30_000 },
    });
    await expect(
      instance.restorePlan(principal, { ...scope, runtime: fingerprint }),
    ).rejects.toMatchObject({ status: 409, code: "STALE_EPOCH" });
  });

  test("heartbeat forwards the transcript report as dates and leaves it out when absent", async () => {
    const seen: unknown[] = [];
    const { instance } = gateway({
      async heartbeatAtomic(input) {
        seen.push(input);
        return {
          outcome: "ok",
          leaseExpiresAt: new Date(input.now.getTime() + 30_000),
          leaseRemainingMs: 29_990,
          authRevision: 0,
        };
      },
    });
    const beat = await instance.heartbeat(principal, {
      ...scope,
      attempt_state: "running",
    });
    expect(beat.lease_remaining_ms).toBe(29_990);
    expect(seen[0]).not.toHaveProperty("transcript");
    await instance.heartbeat(principal, {
      ...scope,
      attempt_state: "running",
      transcript: {
        persisted_at: "2026-09-22T00:00:05.000Z",
        mirror_error: "batch 3 dropped",
      },
    });
    expect(seen[1]).toMatchObject({
      transcript: {
        persistedAt: new Date("2026-09-22T00:00:05.000Z"),
        mirrorError: "batch 3 dropped",
      },
    });
  });

  test("a checkpoint store that throws is a retryable 503, a verdict stays a 409", async () => {
    const outage = new Error("S3 answered 503 SlowDown");
    const throwing = createWorkerGateway({
      work: work({
        async checkpointStateAtomic() {
          return {
            outcome: "ok",
            pointer: null,
            restorable: false,
            pendingReason: null,
          };
        },
      }),
      catalog: { profiles: {}, repositories: {} },
      checkpoints: {
        async verify() {
          throw outage;
        },
      },
      checkpointProtocol: {
        async requestCheckpoint() {
          throw outage;
        },
        async getRestorePlan() {
          throw outage;
        },
      },
      options: { sessionCostLimitUsd: 1_000, leaseTtlMs: 30_000 },
    });
    const finalizeRequest = {
      ...scope,
      turn_id: "1",
      finalize_key: "f",
      final_source_sequence: 0,
      terminal: {
        status: "completed" as const,
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: {
        revision: 0,
        manifest_ref: "sessions/s/checkpoints/0000000000/att_1/manifest.json",
        manifest_sha256: "a".repeat(64),
      },
    };
    for (const call of [
      () => throwing.finalize(principal, finalizeRequest),
      () =>
        throwing.requestCheckpoint(principal, {
          ...scope,
          preparation: { status: "ready" },
        }),
      () => throwing.restorePlan(principal, { ...scope, runtime: fingerprint }),
    ]) {
      await expect(call()).rejects.toMatchObject({
        status: 503,
        code: "BACKEND_UNAVAILABLE",
        retryable: true,
      });
    }

    const { instance } = gateway({
      async finalizeAtomic() {
        return { outcome: "checkpoint_conflict", currentRevision: 4 };
      },
    });
    await expect(
      instance.finalize(principal, finalizeRequest),
    ).rejects.toMatchObject({ status: 409, code: "REVISION_CONFLICT" });
  });

  test("a completed turn the session cannot checkpoint is answered 409 CHECKPOINT_UNAVAILABLE", async () => {
    const { instance } = gateway({
      async finalizeAtomic() {
        return { outcome: "checkpoint_required", reason: "mirror_error" };
      },
    });
    await expect(
      instance.finalize(principal, {
        ...scope,
        turn_id: "1",
        finalize_key: "f",
        final_source_sequence: 0,
        terminal: {
          status: "completed",
          reason: null,
          result: null,
          usage: null,
        },
        checkpoint: null,
      }),
    ).rejects.toMatchObject({ status: 409, code: "CHECKPOINT_UNAVAILABLE" });
  });

  test("a gateway without a pending store refuses registration and never reports answers waiting", async () => {
    const { instance } = gateway({
      heartbeatAtomic: async () => ({
        outcome: "ok",
        leaseExpiresAt: new Date("2026-09-22T00:01:00Z"),
        leaseRemainingMs: 60_000,
        authRevision: 0,
      }),
    });
    const refused = await instance
      .registerPending(principal, {
        ...scope,
        turn_id: "1",
        request_id: "req_1",
        input_hash: "a".repeat(64),
        request: { kind: "permission", tool: "Bash", input: {} },
      })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(WorkerGatewayError);
    expect((refused as WorkerGatewayError).status).toBe(404);
    const beat = await instance.heartbeat(principal, {
      ...scope,
      attempt_state: "running",
    });
    expect(beat.control_pending).toBe(false);
  });
});

describe("heartbeat control_pending (94S-392)", () => {
  test("a hint that cannot be read does not fail a beat whose lease already renewed", async () => {
    const instance = createWorkerGateway({
      work: work({
        heartbeatAtomic: async () => ({
          outcome: "ok",
          leaseExpiresAt: new Date("2026-09-22T00:01:00Z"),
          leaseRemainingMs: 60_000,
          authRevision: 0,
        }),
      }),
      catalog: { profiles: {}, repositories: {} },
      checkpoints: acceptAllCheckpoints,
      pending: {
        hasUndelivered: async () => {
          throw Object.assign(new Error("deadlock detected"), {
            code: "40P01",
          });
        },
      } as unknown as NonNullable<
        Parameters<typeof createWorkerGateway>[0]["pending"]
      >,
      options: { sessionCostLimitUsd: 1_000, leaseTtlMs: 30_000 },
    });
    const beat = await instance.heartbeat(principal, {
      ...scope,
      attempt_state: "running",
    });
    expect(beat.lease_remaining_ms).toBe(60_000);
    expect(beat.control_pending).toBe(false);
  });
});

describe("authorizeEgress (94S-252)", () => {
  const profile: CatalogProfile = {
    runtime_kind: "claude_agent_sdk",
    runtime_version: "0.3.270",
    model: "claude-sonnet-5",
    tools: ["Read"],
    permission_mode: "default",
    provider: {
      kind: "litellm",
      endpoint: "https://litellm.invalid/anthropic",
      auth: {
        kind: "bearer",
        value: "provider-key",
        ref: { value_env: "PROVIDER_KEY" },
      },
    },
  };
  const repository: CatalogRepository = {
    url: "https://git.invalid/team/app.git",
    branch: "main",
    profiles: ["p"],
    auth: {
      kind: "basic",
      username: "reader",
      value: "repo-token",
      ref: { secret_id: "repo" },
    },
  };
  const granted = (binding: string, costUsd = 0): EgressAuthorization => ({
    outcome: "ok",
    sessionId: scope.session_id,
    attemptId: "att_1",
    binding,
    profileId: "p",
    costUsd,
    repository: { id: "app", url: repository.url, branch: "main" },
  });

  function authorizer(
    answer: EgressAuthorization,
    catalog: SessionCatalog = {
      profiles: { p: profile },
      repositories: { app: repository },
    },
  ) {
    const asked: Array<{ tokenHash: Uint8Array; purpose: string }> = [];
    const instance = createWorkerGateway({
      work: work({
        authorizeEgressAtomic: async (input) => {
          asked.push(input);
          return answer;
        },
      }),
      catalog,
      checkpoints: acceptAllCheckpoints,
      options: { sessionCostLimitUsd: 1_000, leaseTtlMs: 30_000 },
    });
    return { asked, instance };
  }

  test("a provider token is answered with the endpoint and the key to inject", async () => {
    const { asked, instance } = authorizer(
      granted(profileFingerprint(profile)),
    );
    const grant = await instance.authorizeEgress({
      token: "wep_x",
      purpose: "provider",
    });
    expect(asked).toEqual([
      { tokenHash: hashWorkerToken("wep_x"), purpose: "provider" },
    ]);
    expect(grant).toEqual({
      session_id: scope.session_id,
      attempt_id: "att_1",
      upstream: {
        url: "https://litellm.invalid/anthropic",
        headers: [["authorization", "Bearer provider-key"]],
      },
    });
    const apiKey: CatalogProfile = {
      ...profile,
      provider: {
        kind: "anthropic",
        endpoint: "https://api.anthropic.invalid",
        auth: {
          kind: "api_key",
          value: "anthropic-key",
          ref: { value_env: "K" },
        },
      },
    };
    const anthropic = authorizer(granted(profileFingerprint(apiKey)), {
      profiles: { p: apiKey },
      repositories: { app: repository },
    });
    expect(
      (
        await anthropic.instance.authorizeEgress({
          token: "wep_x",
          purpose: "provider",
        })
      ).upstream.headers,
    ).toEqual([["x-api-key", "anthropic-key"]]);
  });

  test("a repository token is answered with the row's repository and its login", async () => {
    const { instance } = authorizer(
      granted(repositoryBinding("app", repository)),
    );
    const grant = await instance.authorizeEgress({
      token: "wer_x",
      purpose: "repository",
    });
    expect(grant.upstream).toEqual({
      url: repository.url,
      headers: [
        [
          "authorization",
          `Basic ${Buffer.from("reader:repo-token").toString("base64")}`,
        ],
      ],
    });
    // A repository anyone may read gets nothing injected.
    const { auth: _auth, ...open } = repository;
    const public_ = authorizer(granted(repositoryBinding("app", open)), {
      profiles: { p: profile },
      repositories: { app: open },
    });
    expect(
      (
        await public_.instance.authorizeEgress({
          token: "wer_x",
          purpose: "repository",
        })
      ).upstream.headers,
    ).toEqual([]);
  });

  test("an unknown token is 401 and an attempt that lost its session is 403", async () => {
    await expect(
      authorizer({ outcome: "invalid_token" }).instance.authorizeEgress({
        token: "wep_x",
        purpose: "provider",
      }),
    ).rejects.toMatchObject({ status: 401 });
    for (const outcome of ["stale_epoch", "lease_expired"] as const) {
      await expect(
        authorizer({ outcome }).instance.authorizeEgress({
          token: "wep_x",
          purpose: "provider",
        }),
      ).rejects.toMatchObject({ status: 403 });
    }
  });

  test("a session at its cost limit gets no provider grant, and still its repository (94S-394)", async () => {
    const binding = profileFingerprint(profile);
    const under = await authorizer(
      granted(binding, 999.99),
    ).instance.authorizeEgress({ token: "tok", purpose: "provider" });
    expect(under.session_id).toBe(scope.session_id);
    await expect(
      authorizer(granted(binding, 1_000)).instance.authorizeEgress({
        token: "tok",
        purpose: "provider",
      }),
    ).rejects.toMatchObject({ status: 403, code: "BUDGET_EXCEEDED" });
    // The checkout a recovery needs is not a provider call.
    const repositoryGrant = await authorizer(
      granted(repositoryBinding("app", repository), 1_000),
    ).instance.authorizeEgress({ token: "tok", purpose: "repository" });
    expect(repositoryGrant.session_id).toBe(scope.session_id);
  });

  test("a catalog that moved since the claim is refused, a rotated value is not", async () => {
    const binding = profileFingerprint(profile);
    const moved: CatalogProfile = {
      ...profile,
      provider: { ...profile.provider, endpoint: "https://elsewhere.invalid" },
    };
    await expect(
      authorizer(granted(binding), {
        profiles: { p: moved },
        repositories: { app: repository },
      }).instance.authorizeEgress({ token: "wep_x", purpose: "provider" }),
    ).rejects.toMatchObject({ status: 409, code: "BACKEND_UNAVAILABLE" });
    const rotated: CatalogProfile = {
      ...profile,
      provider: {
        ...profile.provider,
        auth: { ...profile.provider.auth, value: "rotated-key" },
      },
    } as CatalogProfile;
    expect(
      (
        await authorizer(granted(binding), {
          profiles: { p: rotated },
          repositories: { app: repository },
        }).instance.authorizeEgress({ token: "wep_x", purpose: "provider" })
      ).upstream.headers,
    ).toEqual([["authorization", "Bearer rotated-key"]]);

    const repoBinding = repositoryBinding("app", repository);
    for (const repositories of [
      // Re-pointed at another URL, or another branch.
      { app: { ...repository, url: "https://git.invalid/other.git" } },
      { app: { ...repository, branch: "dev" } },
      // The pair is no longer allowed.
      { app: { ...repository, profiles: ["someone-else"] } },
      // Another credential reference behind the same id.
      {
        app: {
          ...repository,
          auth: {
            kind: "bearer" as const,
            value: "repo-token",
            ref: { value_env: "OTHER" },
          },
        },
      },
      // Gone.
      {},
    ]) {
      await expect(
        authorizer(granted(repoBinding), {
          profiles: { p: profile },
          repositories,
        }).instance.authorizeEgress({ token: "wer_x", purpose: "repository" }),
      ).rejects.toMatchObject({ status: 409 });
    }
  });
});
