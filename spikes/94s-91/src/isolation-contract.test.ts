import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createProbeContext,
  type FakeAnthropicServer,
  type ProbeContext,
  runSdkQuery,
  startFakeAnthropicServer,
  textReply,
} from "./harness";

const contexts: ProbeContext[] = [];
let server: FakeAnthropicServer | undefined;

afterEach(async () => {
  server?.stop();
  await Promise.all(contexts.splice(0).map((context) => context.dispose()));
  server = undefined;
});

describe.serial("tenant SDK filesystem and credential isolation", () => {
  test("isolates config homes but requires a tenant-private parent tree", async () => {
    const tenantA = await createProbeContext();
    const tenantB = await createProbeContext();
    contexts.push(tenantA, tenantB);
    await writeFile(
      join(tenantA.workspace, "CLAUDE.md"),
      "TENANT_A_PROJECT_SENTINEL_94S_91",
    );
    await writeFile(
      join(tenantB.workspace, "CLAUDE.md"),
      "TENANT_B_PROJECT_SENTINEL_94S_91",
    );
    await writeFile(
      join(tenantB.root, "CLAUDE.md"),
      "PARENT_DIRECTORY_SENTINEL_94S_91",
    );
    await writeFile(
      join(tenantA.claudeHome, "settings.json"),
      JSON.stringify({ env: { SENTINEL: "TENANT_A_SETTING_SENTINEL_94S_91" } }),
    );
    await writeFile(
      join(tenantA.claudeHome, ".credentials.json"),
      JSON.stringify({ marker: "TENANT_A_CREDENTIAL_SENTINEL_94S_91" }),
    );
    const foreignMemory = join(
      tenantA.claudeHome,
      "projects",
      projectKey(tenantB.workspace),
      "memory",
    );
    await mkdir(foreignMemory, { recursive: true });
    await writeFile(
      join(foreignMemory, "MEMORY.md"),
      "TENANT_A_MEMORY_SENTINEL_94S_91",
    );
    server = startFakeAnthropicServer(() => textReply("tenant B complete"));
    const priorCredential = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_AUTH_TOKEN = "HOST_CREDENTIAL_SENTINEL_94S_91";

    try {
      await runSdkQuery(tenantB, server.url, "Reply briefly.", { maxTurns: 1 });
    } finally {
      if (priorCredential === undefined)
        delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = priorCredential;
    }

    const request = JSON.stringify(server.requests[0]);
    expect(request).toContain("TENANT_B_PROJECT_SENTINEL_94S_91");
    expect(request).toContain("PARENT_DIRECTORY_SENTINEL_94S_91");
    expect(request).toContain("APPEND_SENTINEL_94S_91");
    for (const sentinel of [
      "TENANT_A_PROJECT_SENTINEL_94S_91",
      "TENANT_A_SETTING_SENTINEL_94S_91",
      "TENANT_A_CREDENTIAL_SENTINEL_94S_91",
      "TENANT_A_MEMORY_SENTINEL_94S_91",
      "HOST_CREDENTIAL_SENTINEL_94S_91",
    ]) {
      expect(request).not.toContain(sentinel);
    }
  }, 30_000);
});

function projectKey(workspace: string): string {
  return workspace.replaceAll("/", "-");
}
