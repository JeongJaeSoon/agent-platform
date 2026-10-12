import { describe, expect, test } from "bun:test";
import {
  hashWorkerToken,
  type LaunchIntent,
  LaunchOutcomeUnknownError,
  LaunchSpecMismatchError,
  launchNonceFingerprint,
  launchSpecFingerprint,
} from "@agent-platform/platform";
import {
  ExecutionConflictError,
  ImageReferenceError,
  KubernetesBackend,
  WorkspaceClaimError,
} from "./backend.ts";
import { KubernetesApiError } from "./client.ts";
import { FakeKubernetes } from "./fake-client.ts";
import { podNameFor, workspaceClaimNameFor } from "./specs.ts";
import { testConfig } from "./testing.ts";

const NS = "agents";
const INSTALLATION = "test";
const IMAGE = `registry.local:5000/worker@sha256:${"a".repeat(64)}`;
const RESOURCES = { cpus: 1, memoryBytes: 512 * 1024 * 1024, pidsLimit: 256 };

function setup() {
  const api = new FakeKubernetes();
  const backend = new KubernetesBackend(
    testConfig(NS, INSTALLATION),
    api.asClient(),
  );
  return { api, backend };
}

/** A registry that accepts exactly the nonce it issued last. */
function intentFor(overrides: Partial<LaunchIntent> = {}) {
  const issued: string[] = [];
  const intent: LaunchIntent = {
    bootstrapCredentialState: async () => {
      const last = issued.at(-1);
      return {
        claimed: false,
        fingerprint:
          last === undefined
            ? null
            : launchNonceFingerprint(hashWorkerToken(last)),
      };
    },
    executionId: "exec-1",
    generation: 1,
    image: IMAGE,
    issueBootstrapNonce: async () => {
      const nonce = `wln_secret-${issued.length + 1}`;
      issued.push(nonce);
      return nonce;
    },
    launchSpec: launchSpecFingerprint(IMAGE, RESOURCES),
    operationId: "op-1",
    resources: RESOURCES,
    sessionId: "6c1f8d0e-0000-4000-8000-000000000001",
    ...overrides,
  };
  return { intent, issued };
}

const podName = podNameFor(
  { executionId: "exec-1", generation: 1 },
  INSTALLATION,
);

describe("resolveImage", () => {
  test("returns a digest reference as it is", async () => {
    const { backend } = setup();
    expect(await backend.resolveImage(IMAGE)).toBe(IMAGE);
    const local = `localhost:5001/worker@sha256:${"b".repeat(64)}`;
    expect(await backend.resolveImage(local)).toBe(local);
  });

  test.each([
    "worker:1.0",
    "registry.local:5000/worker",
    `worker:1.0@sha256:${"a".repeat(64)}`,
    "worker@sha256:short",
  ])("refuses %s, naming the digest form", async (reference) => {
    const { backend } = setup();
    const refused = backend.resolveImage(reference);
    await expect(refused).rejects.toBeInstanceOf(ImageReferenceError);
    await expect(refused).rejects.toThrow("repository@sha256:<digest>");
  });
});

describe("ensureExecution", () => {
  test("creates the PVC, then the Pod, then the Secret it owns", async () => {
    const { api, backend } = setup();
    const { intent, issued } = intentFor();
    const result = await backend.ensureExecution(intent);

    expect(
      api.calls.filter((c) => c.verb === "create").map((c) => c.kind),
    ).toEqual(["persistentvolumeclaims", "pods", "secrets"]);
    const pod = await api.get(NS, "pods", podName);
    expect(result).toEqual({
      created: true,
      providerRef: pod?.metadata.uid as string,
      state: "pending",
    });
    const [secret] = await api.list(NS, "secrets");
    expect(secret?.metadata.ownerReferences).toEqual([
      { apiVersion: "v1", kind: "Pod", name: podName, uid: result.providerRef },
    ]);
    expect(issued).toHaveLength(1);
  });

  test("adopts its own Pod without a new nonce", async () => {
    const { api, backend } = setup();
    const { intent, issued } = intentFor();
    const first = await backend.ensureExecution(intent);
    api.setPhase(NS, podName, "Running");
    expect(await backend.ensureExecution(intent)).toEqual({
      created: false,
      providerRef: first.providerRef,
      state: "running",
    });
    expect(issued).toHaveLength(1);
  });

  test("replaces a Pending Pod whose Secret never landed, with a new nonce", async () => {
    const { api, backend } = setup();
    const { intent, issued } = intentFor();
    const first = await backend.ensureExecution(intent);
    const [secret] = await api.list(NS, "secrets");
    api.removeRaw(NS, "secrets", secret?.metadata.name as string);

    const again = await backend.ensureExecution(intent);
    expect(again.created).toBe(true);
    expect(again.providerRef).not.toBe(first.providerRef);
    expect(issued).toHaveLength(2);
    expect(await api.list(NS, "secrets")).toHaveLength(1);
  });

  test("replaces a Pod holding a credential the registry no longer accepts", async () => {
    const { backend } = setup();
    const { intent, issued } = intentFor();
    const first = await backend.ensureExecution(intent);
    issued.push("rotated-elsewhere");
    const again = await backend.ensureExecution(intent);
    expect(again.created).toBe(true);
    expect(again.providerRef).not.toBe(first.providerRef);
  });

  test("refuses a Pod of another launch spec and leaves it in place", async () => {
    const { api, backend } = setup();
    const { intent } = intentFor();
    const { providerRef } = await backend.ensureExecution(intent);
    const resources = { ...RESOURCES, pidsLimit: 1 };
    await expect(
      backend.ensureExecution({
        ...intent,
        launchSpec: launchSpecFingerprint(IMAGE, resources),
        resources,
      }),
    ).rejects.toBeInstanceOf(LaunchSpecMismatchError);
    expect((await api.get(NS, "pods", podName))?.metadata.uid).toBe(
      providerRef,
    );
  });

  test("refuses another operation's Pod under the name, without deleting it", async () => {
    const { api, backend } = setup();
    await backend.ensureExecution(intentFor().intent);
    await expect(
      backend.ensureExecution(intentFor({ operationId: "op-other" }).intent),
    ).rejects.toBeInstanceOf(ExecutionConflictError);
    expect(api.calls.filter((c) => c.verb === "delete")).toEqual([]);
  });

  test("a Secret create that is refused takes the Pod back and keeps the nonce out of the error", async () => {
    const { api, backend } = setup();
    const { intent } = intentFor();
    api.failures.push({
      error: new KubernetesApiError(
        422,
        "POST",
        "secrets",
        "invalid: wln_secret-1",
      ),
      kind: "secrets",
      verb: "create",
    });
    const refused = await backend
      .ensureExecution(intent)
      .catch((e: Error) => e);
    expect(refused).toBeInstanceOf(KubernetesApiError);
    expect((refused as Error).message).not.toContain("wln_secret-1");
    expect((refused as KubernetesApiError).body).not.toContain("wln_secret-1");
    expect(await api.list(NS, "pods")).toEqual([]);
  });

  test("a Secret create with no answer is an unknown outcome, and the Pod stays for the next pass", async () => {
    const { api, backend } = setup();
    const { intent } = intentFor();
    api.timeoutNext("create", "secrets");
    await expect(backend.ensureExecution(intent)).rejects.toBeInstanceOf(
      LaunchOutcomeUnknownError,
    );
    expect(await api.list(NS, "pods")).toHaveLength(1);
  });

  test("a Pod create with no answer is an unknown outcome", async () => {
    const { api, backend } = setup();
    api.timeoutNext("create", "pods");
    await expect(
      backend.ensureExecution(intentFor().intent),
    ).rejects.toBeInstanceOf(LaunchOutcomeUnknownError);
  });

  test("refuses a tag before spending a nonce", async () => {
    const { backend } = setup();
    const { intent, issued } = intentFor({ image: "worker:latest" });
    await expect(backend.ensureExecution(intent)).rejects.toBeInstanceOf(
      ImageReferenceError,
    );
    expect(issued).toEqual([]);
  });

  test("refuses a workspace claim created with another size", async () => {
    const { api, backend } = setup();
    const { intent } = intentFor();
    await backend.ensureExecution(intent);
    const other = new KubernetesBackend(
      { ...testConfig(NS, INSTALLATION), workspaceSizeBytes: 1 },
      api.asClient(),
    );
    await expect(
      other.ensureExecution({ ...intent, generation: 2 }),
    ).rejects.toBeInstanceOf(WorkspaceClaimError);
  });

  test("a replacement whose workspace vanished after the check is refused, not started empty", async () => {
    const { api, backend } = setup();
    const { intent } = intentFor();
    await backend.ensureExecution(intent);
    await backend.assertReplaceable(intent);
    api.removeRaw(
      NS,
      "persistentvolumeclaims",
      workspaceClaimNameFor(intent.sessionId, INSTALLATION),
    );
    await expect(
      backend.ensureExecution({ ...intent, generation: 2 }),
    ).rejects.toBeInstanceOf(WorkspaceClaimError);
  });
});

describe("terminate", () => {
  test("deletes with the inspected Pod's UID as a precondition, and its Secret", async () => {
    const { api, backend } = setup();
    const { intent } = intentFor();
    const { providerRef } = await backend.ensureExecution(intent);
    expect(await backend.terminate(intent, { providerRef })).toEqual({
      outcome: "terminated",
      providerRef,
    });
    const deletes = api.calls.filter((c) => c.verb === "delete");
    expect(deletes[0]).toMatchObject({
      body: { gracePeriodSeconds: 1, uid: providerRef },
      kind: "pods",
    });
    expect(await api.list(NS, "secrets")).toEqual([]);
  });

  test("a Pod replaced after the inspect is reported and left running", async () => {
    const { api, backend } = setup();
    const { intent } = intentFor();
    const { providerRef } = await backend.ensureExecution(intent);
    const replacement = api.replace(NS, "pods", podName);
    expect(await backend.terminate(intent, { providerRef })).toEqual({
      foundProviderRef: replacement,
      outcome: "provider_mismatch",
    });
    expect((await api.get(NS, "pods", podName))?.metadata.uid).toBe(
      replacement,
    );
  });

  test("a Pod replaced between the read and the delete is saved by the precondition", async () => {
    const { api, backend } = setup();
    const { intent } = intentFor();
    await backend.ensureExecution(intent);
    let replacement = "";
    const get = api.get.bind(api);
    let reads = 0;
    api.get = async (namespace, kind, name) => {
      const found = await get(namespace, kind, name);
      if (kind === "pods") reads += 1;
      if (kind === "pods" && reads === 1) {
        replacement = api.replace(NS, "pods", podName);
      }
      return found;
    };
    expect(await backend.terminate(intent)).toEqual({
      foundProviderRef: replacement,
      outcome: "provider_mismatch",
    });
    expect((await get(NS, "pods", podName))?.metadata.uid).toBe(replacement);
  });

  test("another generation is reported and left alone", async () => {
    const { api, backend } = setup();
    const { intent } = intentFor();
    await backend.ensureExecution({ ...intent, generation: 2 });
    expect(await backend.terminate(intent)).toEqual({
      foundGeneration: 2,
      outcome: "generation_mismatch",
    });
    expect(await api.list(NS, "pods")).toHaveLength(1);
  });
});

describe("workspaces", () => {
  test("lists by label, and removes only an unused claim of the named session", async () => {
    const { api, backend } = setup();
    const { intent } = intentFor();
    await backend.ensureExecution(intent);
    const [workspace] = await backend.listWorkspaces();
    expect(workspace).toMatchObject({
      id: workspaceClaimNameFor(intent.sessionId, INSTALLATION),
      sessionId: intent.sessionId,
    });
    const id = workspace?.id as string;
    expect(
      await backend.removeWorkspace(id, { sessionId: "someone-else" }),
    ).toEqual({ outcome: "not_ours" });
    expect(await backend.removeWorkspace(id)).toEqual({ outcome: "in_use" });
    await backend.terminate(intent);
    expect(await backend.removeWorkspace(id)).toEqual({ outcome: "removed" });
    expect(await backend.removeWorkspace(id)).toEqual({ outcome: "absent" });
    expect(await api.list(NS, "persistentvolumeclaims")).toEqual([]);
  });

  test("a young claim is not listed while the age gate is on", async () => {
    const api = new FakeKubernetes();
    const backend = new KubernetesBackend(
      { ...testConfig(NS, INSTALLATION), workspaceGcMinAgeMs: 3_600_000 },
      api.asClient(),
    );
    await backend.ensureExecution(intentFor().intent);
    expect(await backend.listWorkspaces()).toEqual([]);
  });
});
