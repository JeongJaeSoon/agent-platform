import { describe, expect, test } from "bun:test";
import { kubernetesConfigFromEnv } from "./config.ts";

const BASE = {
  AWS_REGION: "ap-northeast-1",
  EXECUTION_EGRESS_PROXY_URL: "http://ap-egress-proxy:3128",
  S3_BUCKET: "sessions",
  WORKER_GATEWAY_URL: "http://ap-api:3000",
};
const noFile = () => null;

describe("kubernetesConfigFromEnv", () => {
  test("defaults the namespace to the scheduler's own and fills the rest", () => {
    const config = kubernetesConfigFromEnv(BASE, () => "agents");
    expect(config).toEqual({
      egressCredentialPort: 3129,
      egressProxyUrl: "http://ap-egress-proxy:3128",
      ephemeralStorageBytes: 1024 * 1024 * 1024,
      gatewayUrl: "http://ap-api:3000",
      homeDir: "/home/worker",
      imagePullSecrets: [],
      installationId: "local",
      namespace: "agents",
      nodeSelector: {},
      objectStore: { bucket: "sessions", region: "ap-northeast-1" },
      requestTimeoutMs: 30_000,
      stopTimeoutSeconds: 120,
      storageClass: null,
      tmpfsSizeBytes: 256 * 1024 * 1024,
      tolerations: [],
      user: "1000:1000",
      workerServiceAccount: null,
      workspaceDir: "/workspace",
      workspaceGcMinAgeMs: 3_600_000,
      workspaceSizeBytes: 4096 * 1024 * 1024,
    });
  });

  test("reads every kubernetes-only setting", () => {
    const config = kubernetesConfigFromEnv(
      {
        ...BASE,
        EXECUTION_INSTALLATION_ID: "prod-1",
        EXECUTION_K8S_IMAGE_PULL_SECRETS: "ecr, other ,",
        EXECUTION_K8S_NAMESPACE: "workers",
        EXECUTION_K8S_STORAGE_CLASS: "gp3",
        EXECUTION_K8S_WORKER_EPHEMERAL_STORAGE_MB: "512",
        EXECUTION_K8S_WORKER_NODE_SELECTOR: '{"pool":"workers"}',
        EXECUTION_K8S_WORKER_SERVICE_ACCOUNT: "ap-worker",
        EXECUTION_K8S_WORKER_TOLERATIONS:
          '[{"key":"workers","operator":"Exists","effect":"NoSchedule"}]',
        EXECUTION_WORKSPACE_GC_MIN_AGE_SEC: "0",
        EXECUTION_WORKSPACE_QUOTA_MB: "2048",
      },
      () => "ignored",
    );
    expect(config).toMatchObject({
      ephemeralStorageBytes: 512 * 1024 * 1024,
      imagePullSecrets: ["ecr", "other"],
      installationId: "prod-1",
      namespace: "workers",
      nodeSelector: { pool: "workers" },
      storageClass: "gp3",
      tolerations: [
        { effect: "NoSchedule", key: "workers", operator: "Exists" },
      ],
      workerServiceAccount: "ap-worker",
      workspaceGcMinAgeMs: 0,
      workspaceSizeBytes: 2048 * 1024 * 1024,
    });
  });

  test.each([
    [{}, "EXECUTION_K8S_NAMESPACE is required outside a cluster"],
    [{ EXECUTION_K8S_NAMESPACE: "Workers" }, "is not a namespace name"],
    [
      { EXECUTION_K8S_NAMESPACE: "w", EXECUTION_INSTALLATION_ID: "Prod_1" },
      "must be a lowercase DNS label",
    ],
    [
      { EXECUTION_K8S_NAMESPACE: "w", EXECUTION_K8S_WORKER_NODE_SELECTOR: "{" },
      "EXECUTION_K8S_WORKER_NODE_SELECTOR is not valid JSON",
    ],
    [
      {
        EXECUTION_K8S_NAMESPACE: "w",
        EXECUTION_K8S_WORKER_NODE_SELECTOR: '{"a":1}',
      },
      "must be a JSON object of strings",
    ],
    [
      {
        EXECUTION_K8S_NAMESPACE: "w",
        EXECUTION_K8S_WORKER_TOLERATIONS: '{"a":"b"}',
      },
      "must be a JSON array of objects",
    ],
    [
      {
        EXECUTION_K8S_NAMESPACE: "w",
        EXECUTION_K8S_IMAGE_PULL_SECRETS: "Bad_Name",
      },
      "EXECUTION_K8S_IMAGE_PULL_SECRETS Bad_Name is not a Kubernetes object name",
    ],
    [
      { EXECUTION_K8S_NAMESPACE: "w", EXECUTION_WORKSPACE_QUOTA_MB: "512" },
      "under the 1024",
    ],
    [
      {
        EXECUTION_K8S_NAMESPACE: "w",
        EXECUTION_K8S_WORKER_EPHEMERAL_STORAGE_MB: "0",
      },
      "EXECUTION_K8S_WORKER_EPHEMERAL_STORAGE_MB",
    ],
    [
      {
        EXECUTION_K8S_NAMESPACE: "w",
        EXECUTION_EGRESS_PROXY_URL: "http://10.0.0.1:3128",
      },
      "must name the proxy Service by a host name",
    ],
  ])("refuses %j", (extra, message) => {
    expect(() =>
      kubernetesConfigFromEnv({ ...BASE, ...extra }, noFile),
    ).toThrow(message);
  });

  test("requires the shared worker settings", () => {
    expect(() =>
      kubernetesConfigFromEnv(
        { ...BASE, EXECUTION_K8S_NAMESPACE: "w", WORKER_GATEWAY_URL: "" },
        noFile,
      ),
    ).toThrow("WORKER_GATEWAY_URL is required");
  });
});
