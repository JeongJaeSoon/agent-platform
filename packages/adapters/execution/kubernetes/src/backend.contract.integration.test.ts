import { describeExecutionBackendContract } from "@agent-platform/platform/testing";
import { KubernetesBackend } from "./backend.ts";
import {
  createNamespace,
  deleteNamespace,
  drainInstallation,
  removePodOutOfBand,
  TEST_ENABLED,
  TEST_IMAGE,
  testClient,
  testConfig,
} from "./testing.ts";

describeExecutionBackendContract("KubernetesBackend", {
  create: async () => {
    const client = await testClient();
    const installationId = `ct-${crypto.randomUUID().slice(0, 8)}`;
    const namespace = `ap-${installationId}`;
    await createNamespace(client, namespace);
    const backend = new KubernetesBackend(
      testConfig(namespace, installationId),
      client,
    );
    return {
      backend,
      removeOutOfBand: (providerRef) =>
        removePodOutOfBand(client, namespace, installationId, providerRef),
      tearDown: async () => {
        const left = await drainInstallation(
          backend,
          client,
          namespace,
          installationId,
        );
        console.log(
          `installation ${installationId} in ${namespace} after drain: ${left.length === 0 ? "nothing left" : left.join(", ")}`,
        );
        await deleteNamespace(client, namespace);
      },
    };
  },
  enabled: TEST_ENABLED,
  image: TEST_IMAGE,
  // A Pod is scheduled, its claim bound and its image pulled before it runs.
  timeoutMs: 120_000,
});
