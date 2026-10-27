import type { AgentRun, RuntimeKind } from "@werft-ai/runtime-core";
import type {
  ScriptedRuntime,
  ScriptedRuntimeOptions,
  ScriptedStep,
} from "@werft-ai/runtime-core/testing";
import { fakeRuntimeFor } from "@werft-ai/runtime-registry/testing";

import { runtimeStart } from "../composition.ts";
import type { WorkerConfig } from "../config.ts";
import type { RuntimeLaunch } from "../worker-host.ts";

/** The engine FakeWorkerGateway's sessions are created for. */
export const SCRIPTED_KIND: RuntimeKind = "claude_agent_sdk";

const scriptedHost: Pick<WorkerConfig, "egressCredentialUrl" | "runtime"> = {
  egressCredentialUrl: "http://egress-proxy.test:3129",
  runtime: {
    claudeConfigDir: "/tmp/fake/config",
    cwd: "/tmp/fake/workspace",
    home: "/tmp/fake/home",
    providerMaxRetries: 0,
  },
};

export function scriptedRuntime(
  steps: ScriptedStep[],
  options: ScriptedRuntimeOptions = {},
): ScriptedRuntime {
  return fakeRuntimeFor(SCRIPTED_KIND, steps, options);
}

/** Starts a scripted engine the way composition starts the real one. */
export function startScripted(
  runtime: ScriptedRuntime,
  launch: RuntimeLaunch,
): AgentRun {
  return runtime.start(runtimeStart(scriptedHost, runtime, launch));
}
