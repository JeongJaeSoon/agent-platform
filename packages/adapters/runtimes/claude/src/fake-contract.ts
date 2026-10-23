import { CLAUDE_DESCRIPTOR } from "@werft-ai/runtime-claude-codec";
import type {
  AgentRun,
  AgentRuntime,
  RuntimeDescriptor,
  RuntimeStart,
} from "@werft-ai/runtime-core";

import { claudeContractRun } from "./contract.ts";
import type { FakeAgentRuntime } from "./fake-adapter.ts";

/**
 * The fake driver behind the runtime contract, declaring `descriptor` — the
 * Claude one unless a test needs a runtime that lacks something.
 */
export function fakeContractRuntime(
  fake: FakeAgentRuntime,
  descriptor: RuntimeDescriptor = CLAUDE_DESCRIPTOR,
): AgentRuntime & { readonly starts: RuntimeStart[] } {
  const starts: RuntimeStart[] = [];
  return {
    descriptor,
    starts,
    start(start: RuntimeStart): AgentRun {
      starts.push(start);
      return claudeContractRun(
        start.config.correlationId,
        (gate) => fake.start(start.config, gate),
        descriptor,
      );
    },
  };
}
