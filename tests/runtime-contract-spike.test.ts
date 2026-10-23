import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { RuntimeConfig } from "@werft-ai/contracts";
import { readCatalogConfig } from "@werft-ai/control-host/src/api/catalog-config.ts";
import {
  ProfileFeatureGate,
  UnsupportedRuntimeFeature,
} from "@werft-ai/platform";
import {
  CLAUDE_DESCRIPTOR,
  FakeAgentRuntime,
  fakeContractRuntime,
} from "@werft-ai/runtime-claude";
import {
  type AgentRuntime,
  ApprovalChannel,
  approvalInputHash,
  runtimeRequirementsOf,
  unmetFeatures,
} from "@werft-ai/runtime-core";
import { PI_STUB_DESCRIPTOR, PiStubRuntime } from "@werft-ai/runtime-pi-stub";
import { unwiredCheckpoints } from "../apps/worker/src/checkpoint.ts";
import type { WorkerTimeouts } from "../apps/worker/src/config.ts";
import { FakeWorkerGateway } from "../apps/worker/src/testing/fake-gateway.ts";
import {
  type RuntimeLaunch,
  type RuntimeRegistry,
  WorkerHost,
  type WorkerLogger,
} from "../apps/worker/src/worker-host.ts";
import { noWorkspace } from "../apps/worker/src/workspace.ts";

const root = join(import.meta.dir, "..");
const silent: WorkerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
const timeouts: WorkerTimeouts = {
  answerPollIntervalMs: 2,
  claimTimeoutMs: 200,
  drainTimeoutMs: 50,
  heartbeatIntervalMs: 10_000,
  idleTimeoutMs: 60,
  maxTurnMs: 60_000,
  nextInputRetryTimeoutMs: 60_000,
  nextInputWaitMs: 15,
  questionTimeoutMs: 2_000,
  requestTimeoutMs: 1_000,
  startupTimeoutMs: 60_000,
};
const descriptors = {
  claude_agent_sdk: CLAUDE_DESCRIPTOR,
  pi_coding_agent: PI_STUB_DESCRIPTOR,
};
const mcpServer: NonNullable<RuntimeConfig["mcp_servers"]>[number] = {
  name: "docs",
  endpoint: "https://mcp.example.invalid/mcp",
  binding: `sha256:${"0".repeat(64)}`,
  access: { kind: "egress_token", token: "egress-token-for-test" },
};

/** A registry whose one launcher builds the contract start as composition does. */
function registryFor(runtime: AgentRuntime): RuntimeRegistry {
  return {
    launcherFor: () => ({
      start: (launch: RuntimeLaunch) =>
        runtime.start({
          bindings: {
            principal: { ownerScope: launch.principal.owner_scope },
            provider: {
              auth: { kind: "egress_token", token: "t", transport: "http://x" },
              endpoint: launch.runtimeConfig.provider.endpoint,
              kind: launch.runtimeConfig.provider.kind,
            },
          },
          bundle: {
            instructions: [],
            mcpServers: [],
            skills: [],
            tools: launch.runtimeConfig.tools,
          },
          config: {
            correlationId: launch.correlationId,
            cwd: "/tmp/spike/workspace",
            home: "/tmp/spike/home",
            mode: "new",
            model: launch.runtimeConfig.model,
            permissionMode: launch.runtimeConfig.permission_mode,
          },
          env: { vars: [] },
          options: {},
          requirements: runtimeRequirementsOf(launch.runtimeConfig),
        }),
    }),
  };
}

function host(gateway: FakeWorkerGateway, runtime: AgentRuntime): WorkerHost {
  return new WorkerHost({
    checkpoints: unwiredCheckpoints,
    execution: { bootstrapNonce: "wln_test", generation: 1, id: "exec-1" },
    gateway,
    logger: silent,
    runtimes: registryFor(runtime),
    timeouts,
    workspace: noWorkspace,
  });
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let waited = 0; waited < 2_000; waited += 5) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("ProfileFeatureGate", () => {
  const gate = new ProfileFeatureGate(descriptors);

  test("passes every shipped profile on Claude and on the pi stub", async () => {
    for (const dir of ["config", "config/fake-model", "config/local-model"]) {
      const catalog = await readCatalogConfig(join(root, dir));
      for (const profile of Object.values(catalog.profiles)) {
        gate.atCatalogLoad("claude_agent_sdk", profile);
        // No shipped profile asks for auto mode, so pi takes them too.
        gate.atCatalogLoad("pi_coding_agent", profile);
      }
    }
  });

  test("refuses auto mode on pi at catalog load, and an MCP release at session create", () => {
    expect(() =>
      gate.atCatalogLoad("pi_coding_agent", { permission_mode: "auto" }),
    ).toThrow(UnsupportedRuntimeFeature);
    expect(() =>
      gate.atSessionCreate("pi_coding_agent", {
        mcp_servers: [mcpServer],
        permission_mode: "default",
      }),
    ).toThrow("does not support mcp (session create)");
    gate.atSessionCreate("claude_agent_sdk", {
      mcp_servers: [mcpServer],
      permission_mode: "auto",
    });
  });

  test("derives features from the table, and extra keys default to none", () => {
    expect(
      unmetFeatures(
        PI_STUB_DESCRIPTOR.capabilities,
        {},
        {
          features: [
            "approval_park",
            "classifier_review",
            "mcp",
            "session_resume",
            "subagents",
            "user_hooks",
          ],
        },
      ),
    ).toEqual([
      "approval_park",
      "classifier_review",
      "mcp",
      "session_resume",
      "subagents",
      "user_hooks",
    ]);
    expect(
      unmetFeatures(
        CLAUDE_DESCRIPTOR.capabilities,
        CLAUDE_DESCRIPTOR.extraFeatures,
        {
          features: [
            "approval_park",
            "mcp",
            "session_resume",
            "subagents",
            "user_hooks",
          ],
        },
      ),
    ).toEqual(["user_hooks"]);
  });
});

describe("worker on the runtime contract", () => {
  test("refuses before the first input when ready() lacks a required feature", async () => {
    const fake = new FakeAgentRuntime([{ type: "await-input" }]);
    const gateway = new FakeWorkerGateway({
      runtimeConfig: {
        model: "m",
        tools: ["mcp__docs__search"],
        permission_mode: "default",
        provider: {
          kind: "anthropic",
          endpoint: "https://api.anthropic.example",
          auth: { kind: "egress_token", token: "t" },
        },
        mcp_servers: [mcpServer],
      },
    });
    gateway.enqueue("never sent");

    const summary = await host(
      gateway,
      fakeContractRuntime(fake, PI_STUB_DESCRIPTOR),
    ).runLoop();

    expect(summary.outcome).toBe("failed");
    expect(summary.reason).toContain("mcp unsupported");
    expect(fake.inputs).toEqual([]);
  });

  test("runs a pi-shaped runtime end to end, approval included", async () => {
    const pi = new PiStubRuntime();
    const gateway = new FakeWorkerGateway();
    gateway.enqueue("hello");
    gateway.enqueue("run ls");
    const loop = host(gateway, pi).runLoop();

    await waitFor(() => gateway.questions().length === 1, "the approval");
    gateway.answer({
      request_id: gateway.requestIdFor("pi_call_0"),
      kind: "permission",
      decision: "allow",
    });
    const summary = await loop;

    expect(summary.turns).toEqual([
      { turnId: "1", status: "completed", reason: null },
      { turnId: "2", status: "completed", reason: null },
    ]);
    expect(pi.starts).toHaveLength(1);
    const texts = gateway.events
      .filter((event) => event.event === "assistant")
      .map(
        (event) =>
          (
            event.data as unknown as {
              message: { content: Array<{ text: string }> };
            }
          ).message.content[0]?.text,
      );
    expect(texts).toEqual(["echo: hello", "ran: ls"]);
    expect(gateway.registered()[0]?.input_hash).toBe(
      approvalInputHash("bash", { command: "ls" }),
    );
  });
});

describe("ApprovalChannel.answer", () => {
  test("applies once, then answers stale; unknown ids and other arguments change nothing", async () => {
    const channel = new ApprovalChannel();
    const signal = new AbortController().signal;
    const decided = channel.request(
      {
        kind: "permission",
        nativeRef: { id: "n1", method: "test" },
        tool: { input: { command: "ls" }, name: "bash" },
        toolCallId: "call-1",
      },
      signal,
    );
    const [requested] = channel.drain();
    if (requested?.type !== "approval.requested") throw new Error("no request");
    const base = { decidedBy: "user" as const, localId: requested.localId };

    expect(
      channel.answer({
        ...base,
        inputHash: approvalInputHash("bash", { command: "rm -rf /" }),
        optionKind: "allow_once",
        outcome: "selected",
      }),
    ).toBe("stale");
    const allow = {
      ...base,
      inputHash: requested.inputHash,
      optionKind: "allow_once" as const,
      outcome: "selected" as const,
    };
    expect(channel.answer(allow)).toBe("applied");
    expect(channel.answer(allow)).toBe("stale");
    expect(channel.answer({ ...allow, localId: "approval:99" })).toBe(
      "unknown",
    );
    expect((await decided).outcome).toBe("selected");
    expect(channel.drain()).toEqual([
      {
        type: "approval.resolved",
        decidedBy: "user",
        localId: requested.localId,
        outcome: "selected",
      },
    ]);
  });
});
