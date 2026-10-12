import { describe, expect, test } from "bun:test";
import {
  ENV as DOCKER_ENV,
  workerEnvironmentFor as dockerEnvironmentFor,
} from "@agent-platform/execution-local-docker";
import type { LaunchIntent } from "@agent-platform/platform";
import {
  cpuQuantity,
  ENV,
  isolationStampFor,
  nonceSecretFor,
  nonceSecretNameOf,
  podFor,
  podNameFor,
  workerEnvironmentFor,
  workspaceClaimFor,
} from "./specs.ts";
import { testConfig } from "./testing.ts";

const config = {
  ...testConfig("agents", "prod"),
  workerLimits: { maxTurnSeconds: 900, providerMaxRetries: 3 },
};
const NONCE = "wln_never-in-the-pod";
const intent: LaunchIntent = {
  bootstrapCredentialState: async () => ({ claimed: true }),
  executionId: "exec-1",
  generation: 3,
  image: `worker@sha256:${"c".repeat(64)}`,
  issueBootstrapNonce: async () => NONCE,
  launchSpec: "f".repeat(64),
  operationId: "op-1",
  resources: { cpus: 1.5, memoryBytes: 1024 * 1024 * 1024, pidsLimit: 512 },
  sessionId: "6c1f8d0e-0000-4000-8000-000000000001",
};

type PodShape = {
  metadata: {
    annotations: Record<string, string>;
    labels: Record<string, string>;
    name: string;
  };
  spec: {
    automountServiceAccountToken: boolean;
    containers: Array<{
      env: Array<{
        name: string;
        value?: string;
        valueFrom?: { secretKeyRef?: { key: string; name: string } };
      }>;
      resources: unknown;
      securityContext: unknown;
      args?: string[];
    }>;
    restartPolicy: string;
    securityContext: unknown;
    volumes: unknown;
    enableServiceLinks: boolean;
    terminationGracePeriodSeconds: number;
  };
};

const pod = podFor(config, intent, "secret-name", "fingerprint") as PodShape;
const [container] = pod.spec.containers;
if (container === undefined) throw new Error("no container");

describe("worker Pod", () => {
  test("runs non-root on a read-only rootfs with nothing to escalate to", () => {
    expect(container.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
      privileged: false,
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(pod.spec.securityContext).toEqual({
      fsGroup: 1000,
      runAsGroup: 1000,
      runAsNonRoot: true,
      runAsUser: 1000,
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(pod.spec.restartPolicy).toBe("Never");
    expect(pod.spec.automountServiceAccountToken).toBe(false);
    expect(pod.spec.enableServiceLinks).toBe(false);
    expect(pod.spec.terminationGracePeriodSeconds).toBe(
      config.stopTimeoutSeconds,
    );
  });

  test("takes its limits from the intent, requests equal to limits", () => {
    const limits = { cpu: "1500m", memory: String(1024 * 1024 * 1024) };
    expect(container.resources).toEqual({ limits, requests: limits });
  });

  test("carries the contract labels and the launch's identity", () => {
    expect(pod.metadata.name).toBe("ap-worker-prod-exec-1-g3");
    expect(pod.metadata.labels).toEqual({
      "agent-platform.generation": "3",
      "agent-platform.installation": "prod",
      "agent-platform.session-execution-id": "exec-1",
      "agent-platform.session-id": intent.sessionId,
      "app.kubernetes.io/component": "worker",
      "app.kubernetes.io/part-of": "agent-platform",
    });
    expect(pod.metadata.annotations).toEqual({
      "agent-platform.bootstrap-fingerprint": "fingerprint",
      "agent-platform.isolation": isolationStampFor(config),
      "agent-platform.launch-spec": "f".repeat(64),
      "agent-platform.operation-id": "op-1",
    });
  });

  test("mounts the session's claim and memory-backed /tmp and HOME", () => {
    expect(pod.spec.volumes).toEqual([
      {
        name: "workspace",
        persistentVolumeClaim: { claimName: `ap-ws-prod-${intent.sessionId}` },
      },
      {
        emptyDir: { medium: "Memory", sizeLimit: String(16 * 1024 * 1024) },
        name: "tmp",
      },
      {
        emptyDir: { medium: "Memory", sizeLimit: String(16 * 1024 * 1024) },
        name: "home",
      },
    ]);
  });

  test("reads the nonce from its Secret and never holds it", () => {
    expect(JSON.stringify(pod)).not.toContain(NONCE);
    expect(container.env[0]).toEqual({
      name: "WORKER_BOOTSTRAP_NONCE",
      valueFrom: { secretKeyRef: { key: "nonce", name: "secret-name" } },
    });
    expect(nonceSecretNameOf(pod)).toBe("secret-name");
  });

  test("tells the worker exactly what the Docker backend tells it, under the same names", () => {
    expect(ENV).toEqual(DOCKER_ENV);
    const docker = dockerEnvironmentFor(
      {
        apiVersion: "v1.44",
        dockerHost: "unix:///var/run/docker.sock",
        egressCredentialPort: config.egressCredentialPort,
        egressProxyUrl: config.egressProxyUrl,
        gatewayUrl: config.gatewayUrl,
        homeDir: config.homeDir,
        installationId: "prod",
        objectStore: config.objectStore,
        requestTimeoutMs: 1,
        stopTimeoutSeconds: config.stopTimeoutSeconds,
        tmpfsSizeBytes: 1,
        user: config.user,
        workerLimits: config.workerLimits,
        workspaceDir: config.workspaceDir,
        workspaceGcMinAgeMs: 0,
        workspaceQuota: { mode: "off" },
      },
      intent,
      NONCE,
    );
    const ours = workerEnvironmentFor(config, intent, "secret-name").map((e) =>
      "value" in e ? `${e.name}=${e.value}` : `${e.name}=${NONCE}`,
    );
    expect(ours).toEqual(docker);
  });

  test("refuses a CPU limit that rounds to none and limits that are not positive", () => {
    expect(() => cpuQuantity(0.0004)).toThrow("rounds to no CPU limit");
    expect(() =>
      podFor(
        config,
        { ...intent, resources: { ...intent.resources, memoryBytes: 0 } },
        "s",
        "f",
      ),
    ).toThrow("memoryBytes");
  });

  test("refuses ids that cannot be part of a Kubernetes name", () => {
    expect(() =>
      podNameFor({ executionId: "Exec_1", generation: 1 }, "prod"),
    ).toThrow("cannot be used in a Kubernetes name");
  });
});

describe("nonce Secret and workspace claim", () => {
  test("the Secret is owned by its Pod and labelled as bootstrap", () => {
    expect(
      nonceSecretFor(
        config,
        intent,
        { name: "pod-a", uid: "uid-a" },
        "pod-a-1234",
        NONCE,
      ),
    ).toEqual({
      apiVersion: "v1",
      immutable: true,
      kind: "Secret",
      metadata: {
        labels: {
          "agent-platform.generation": "3",
          "agent-platform.installation": "prod",
          "agent-platform.session-execution-id": "exec-1",
          "app.kubernetes.io/component": "bootstrap",
          "app.kubernetes.io/part-of": "agent-platform",
        },
        name: "pod-a-1234",
        namespace: "agents",
        ownerReferences: [
          { apiVersion: "v1", kind: "Pod", name: "pod-a", uid: "uid-a" },
        ],
      },
      stringData: { nonce: NONCE },
      type: "Opaque",
    });
  });

  test("the claim asks for the quota and names its StorageClass only when set", () => {
    const claim = workspaceClaimFor(config, intent.sessionId) as {
      metadata: { labels: Record<string, string> };
      spec: Record<string, unknown>;
    };
    expect(claim.metadata.labels).toEqual({
      "agent-platform.installation": "prod",
      "agent-platform.session-id": intent.sessionId,
      "app.kubernetes.io/component": "workspace",
      "app.kubernetes.io/part-of": "agent-platform",
    });
    expect(claim.spec).toEqual({
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: String(64 * 1024 * 1024) } },
      volumeMode: "Filesystem",
    });
    expect(
      (
        workspaceClaimFor(
          { ...config, storageClass: "gp3" },
          intent.sessionId,
        ) as {
          spec: { storageClassName?: string };
        }
      ).spec.storageClassName,
    ).toBe("gp3");
  });
});
