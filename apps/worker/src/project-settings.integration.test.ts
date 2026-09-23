import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeConfig } from "@agent-platform/contracts";
import { ClaudeSdkRuntime } from "@agent-platform/runtime-claude";
import type { AgentFrame } from "@agent-platform/runtime-core";
import {
  type FakeAnthropicServer,
  startFakeAnthropicServer,
  textReply,
} from "@agent-platform/testkit/fake-anthropic";
import {
  createIsolatedWorkspace,
  type IsolatedWorkspace,
} from "@agent-platform/testkit/workspace";

import type { RuntimeResumePlan, WorkerCheckpointPort } from "./checkpoint.ts";
import { claudeRuntimeRegistry } from "./composition.ts";
import type { WorkerConfig, WorkerTimeouts } from "./config.ts";
import { EngineProcesses } from "./engine-processes.ts";
import { FakeWorkerGateway } from "./fake-gateway.ts";
import { WorkerHost, type WorkerLogger } from "./worker-host.ts";
import { noWorkspace } from "./workspace.ts";

const MODEL = "claude-sonnet-4-5";
const INSTRUCTIONS = "REPOSITORY_RULE_94S_258: run bun test before committing.";

const silent: WorkerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const timeouts: WorkerTimeouts = {
  answerPollIntervalMs: 50,
  claimTimeoutMs: 5_000,
  drainTimeoutMs: 5_000,
  heartbeatIntervalMs: 60_000,
  idleTimeoutMs: 300,
  maxTurnMs: 60_000,
  nextInputWaitMs: 100,
  questionTimeoutMs: 5_000,
  requestTimeoutMs: 5_000,
};

/** Opens with `plan` and remembers the engine session a turn left behind. */
function checkpointsFrom(plan: RuntimeResumePlan): WorkerCheckpointPort & {
  resumeHandle?: string;
} {
  const port: WorkerCheckpointPort & { resumeHandle?: string } = {
    restorePlan: async () => plan,
    capture: async (preparation) => {
      if (preparation.status === "ready") {
        port.resumeHandle = preparation.checkpoint.resume;
      }
      return null;
    },
  };
  return port;
}

let isolated: IsolatedWorkspace | undefined;
let server: FakeAnthropicServer | undefined;

afterEach(async () => {
  server?.stop();
  await isolated?.dispose();
  isolated = undefined;
  server = undefined;
});

/**
 * A checkout that carries both halves of the repository's project settings:
 * a CLAUDE.md, and a settings.json whose hooks touch a marker file outside
 * the checkout the moment the engine would run them.
 */
async function repositoryWithProjectSettings(): Promise<{
  home: string;
  markers: string[];
  workspace: string;
}> {
  isolated = await createIsolatedWorkspace({ prefix: "94s-258-" });
  const { home, root, workspace } = isolated;
  const markers = ["session-start", "prompt-submit"].map((name) =>
    join(root, `${name}.marker`),
  );
  const command = (marker: string) => ({
    hooks: [{ type: "command", command: `touch '${marker}'` }],
  });
  await writeFile(join(workspace, "CLAUDE.md"), `${INSTRUCTIONS}\n`);
  await writeFile(
    join(workspace, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        SessionStart: [command(markers[0] ?? "")],
        UserPromptSubmit: [command(markers[1] ?? "")],
      },
    }),
  );
  return { home, markers, workspace };
}

function claimedConfig(endpoint: string, claudeMd: boolean): RuntimeConfig {
  return {
    model: MODEL,
    tools: [],
    permission_mode: "default",
    provider: {
      kind: "anthropic",
      endpoint,
      auth: { kind: "api_key", value: "placeholder-local" },
    },
    project_settings: { claude_md: claudeMd },
  };
}

/** One turn through the worker exactly as composition wires it. */
async function runOneTurn(
  paths: { home: string; workspace: string },
  runtimeConfig: RuntimeConfig,
  checkpoints = checkpointsFrom({ mode: "new" }),
  turn = 1,
): Promise<void> {
  const gateway = new FakeWorkerGateway({
    runtimeConfig,
    sessionId: "33333333-3333-4333-8333-333333333333",
    firstTurn: turn,
  });
  gateway.enqueue(`message ${turn}`);
  const config = {
    runtime: {
      claudeConfigDir: paths.home,
      cwd: paths.workspace,
      home: paths.home,
    },
  } as WorkerConfig;
  const engines = new EngineProcesses();
  const host = new WorkerHost({
    checkpoints,
    engines,
    execution: { bootstrapNonce: "wln_local", generation: 1, id: "exec-1" },
    gateway,
    logger: silent,
    runtimes: claudeRuntimeRegistry(config, engines),
    timeouts,
    // The fixture is already the checkout the workspace step would leave.
    workspace: noWorkspace,
  });
  const summary = await host.runLoop();
  expect(summary.turns).toEqual([
    { turnId: String(turn), status: "completed", reason: null },
  ]);
}

describe("the repository's own Claude project settings, under the claim's profile", () => {
  test("the fixture's hooks are live when the engine loads the project source itself", async () => {
    // Negative control: without it, a marker that never appears would prove
    // only that these hooks cannot fire, not that the worker stops them.
    const paths = await repositoryWithProjectSettings();
    server = startFakeAnthropicServer(() => textReply("ok"));
    const run = new ClaudeSdkRuntime({
      endpoints: [server.url],
      models: [MODEL],
    }).start(
      {
        claudeConfigDir: paths.home,
        correlationId: "control",
        cwd: paths.workspace,
        home: paths.home,
        maxTurns: 2,
        mode: "new",
        model: MODEL,
        profile: {
          kind: "anthropic",
          endpoint: server.url,
          auth: { kind: "api_key", value: "placeholder-local" },
          principal: { ownerScope: "owner-a" },
        },
        settingSources: ["project"],
        tools: [],
      },
      {
        onPermission: async () => ({ behavior: "deny", message: "none" }),
      },
    );
    const frames: AgentFrame[] = [];
    const consume = (async () => {
      for await (const frame of run) frames.push(frame);
    })();
    run.send({ message: "hello", uuid: crypto.randomUUID() });
    run.finishInput();
    await consume;

    expect(server.requests.length).toBeGreaterThan(0);
    expect(paths.markers.filter((marker) => existsSync(marker))).toEqual(
      paths.markers,
    );
    expect(JSON.stringify(server.requests[0]?.body)).toContain(INSTRUCTIONS);
  }, 60_000);

  test("a profile that keeps CLAUDE.md out runs no repository hook and sends no repository text", async () => {
    const paths = await repositoryWithProjectSettings();
    server = startFakeAnthropicServer(() => textReply("ok"));

    await runOneTurn(paths, claimedConfig(server.url, false));

    expect(server.requests).toHaveLength(1);
    expect(paths.markers.filter((marker) => existsSync(marker))).toEqual([]);
    expect(JSON.stringify(server.requests[0]?.body)).not.toContain(
      INSTRUCTIONS,
    );
  }, 60_000);

  test("a profile that lets CLAUDE.md in puts it in the system prompt and still runs no hook", async () => {
    const paths = await repositoryWithProjectSettings();
    server = startFakeAnthropicServer(() => textReply("ok"));

    await runOneTurn(paths, claimedConfig(server.url, true));

    expect(server.requests).toHaveLength(1);
    expect(paths.markers.filter((marker) => existsSync(marker))).toEqual([]);
    const system = JSON.stringify(server.requests[0]?.body.system);
    expect(system).toContain("Contents of CLAUDE.md at the root");
    expect(system).toContain(INSTRUCTIONS);
    // Once, in the system prompt: nothing else loaded it alongside.
    expect(JSON.stringify(server.requests[0]?.body.messages)).not.toContain(
      INSTRUCTIONS,
    );
  }, 60_000);

  test("a resumed session keeps the instructions it started with, whatever the checkout says now", async () => {
    // The fingerprint deliberately ignores the text; this is why that is
    // safe: the engine replays the system prompt it recorded.
    const paths = await repositoryWithProjectSettings();
    server = startFakeAnthropicServer(() => textReply("ok"));
    const first = checkpointsFrom({ mode: "new" });
    await runOneTurn(paths, claimedConfig(server.url, true), first);
    const resume = first.resumeHandle;
    if (resume === undefined) throw new Error("No engine session was captured");

    await writeFile(
      join(paths.workspace, "CLAUDE.md"),
      "EDITED_RULE_94S_258\n",
    );
    await runOneTurn(
      paths,
      claimedConfig(server.url, true),
      checkpointsFrom({ mode: "resume", resume, localTranscriptResume: true }),
      2,
    );

    expect(server.requests).toHaveLength(2);
    // It is the same conversation, not a fresh one that happened to agree.
    expect(JSON.stringify(server.requests[1]?.body.messages)).toContain(
      "message 1",
    );
    const system = JSON.stringify(server.requests[1]?.body.system);
    expect(system).toContain(INSTRUCTIONS);
    expect(system).not.toContain("EDITED_RULE_94S_258");
    expect(paths.markers.filter((marker) => existsSync(marker))).toEqual([]);
  }, 90_000);
});
