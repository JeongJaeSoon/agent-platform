// Scripted Claude engines for tests outside this package. Production code
// takes runs through `claudeRuntimeModule` alone.
import type { AgentRun } from "@werft-ai/runtime-core";

import type { ClaudeRuntimeConfig } from "./config.ts";
import { claudeContractRun } from "./contract.ts";
import type { ClaudeSdkRuntime } from "./runtime.ts";

export type { NativeSdkMessage } from "./driver.ts";
export {
  FakeAgentRuntime,
  type FakeRuntimeOptions,
  type FakeStep,
} from "./fake-adapter.ts";

/** A contract run over the SDK driver with a configuration of the test's own. */
export function sdkRun(
  runtime: ClaudeSdkRuntime,
  config: ClaudeRuntimeConfig,
  options: { toolCallWaitMs?: number } = {},
): AgentRun {
  return claudeContractRun((hooks) => runtime.start(config, hooks), options);
}
