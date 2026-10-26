import { expect, test } from "bun:test";
import { join } from "node:path";
import type { RuntimeConfig } from "@werft-ai/contracts";

import { claudeClaimFingerprint } from "./composition.ts";
import type { WorkerConfig } from "./config.ts";

// The fingerprint a worker stamps a claim's checkpoints with, and the one a
// restore plan asks for, pinned to the bytes main produced before the
// runtime contract refactor (94S-827).
// Regenerate only for an intended change: UPDATE_GOLDEN=1 bun test <file>.

const GOLDEN = join(
  import.meta.dir,
  "../../../tests/fixtures/golden/worker/claim-fingerprint.json",
);

const config: Pick<WorkerConfig, "egressCredentialUrl" | "runtime"> = {
  egressCredentialUrl: "http://egress-proxy:3129",
  runtime: {
    claudeConfigDir: "/home/worker/.claude",
    cwd: "/workspace",
    home: "/home/worker",
    providerMaxRetries: 2,
  },
};

const access = { kind: "egress_token" as const, token: "golden-token" };

const base: RuntimeConfig = {
  model: "claude-sonnet-5",
  tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
  permission_mode: "default",
  provider: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.com",
    auth: access,
  },
};

const claims: Record<string, RuntimeConfig> = {
  default: base,
  "claude-md": { ...base, project_settings: { claude_md: true } },
  "claude-md-off": { ...base, project_settings: { claude_md: false } },
  mcp: {
    ...base,
    tools: [...base.tools, "mcp__notion__search"],
    mcp_servers: [
      {
        name: "notion",
        endpoint: "https://mcp.notion.test/mcp",
        binding: `sha256:${"b".repeat(64)}`,
        access,
      },
    ],
  },
  litellm: {
    ...base,
    model: "gemma4-local",
    permission_mode: "acceptEdits",
    provider: {
      kind: "litellm",
      endpoint: "http://litellm:4000",
      auth: access,
    },
    project_settings: { claude_md: true },
  },
};

test("claim fingerprints match main (golden)", async () => {
  const fingerprint = claudeClaimFingerprint(config);
  const principal = { owner_scope: "owner-a" };
  const repository = {
    id: "sample-app",
    url: "https://example.invalid/team/app.git",
    branch: "main",
  };
  const actual = Object.fromEntries(
    Object.entries(claims).map(([name, runtime_config]) => [
      name,
      {
        repository: fingerprint({
          principal,
          runtime_config,
          workspace: { repository },
        }),
        repositoryless: fingerprint({
          principal,
          runtime_config,
          workspace: { repository: null },
        }),
      },
    ]),
  );
  const text = `${JSON.stringify(actual, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN === "1") {
    await Bun.write(GOLDEN, text);
    return;
  }
  expect(text).toBe(await Bun.file(GOLDEN).text());
});
