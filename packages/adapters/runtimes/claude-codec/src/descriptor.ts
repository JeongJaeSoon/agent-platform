import {
  RUNTIME_CONTRACT_VERSION,
  type RuntimeDescriptor,
} from "@werft-ai/runtime-core";
import { z } from "zod";

import { CLAUDE_AGENT_SDK_VERSION } from "./versions.ts";

/**
 * What the Claude adapter supports, readable without the SDK so the control
 * plane can refuse a profile before a session exists.
 */
export const CLAUDE_DESCRIPTOR: RuntimeDescriptor = {
  capabilities: {
    checkpoint: true,
    interrupt: true,
    // The relay in remote-mcp.ts, one remote server per release.
    mcp: "native",
    permissionModes: {
      acceptEdits: "native",
      auto: "native",
      bypassPermissions: "native",
      default: "native",
      dontAsk: "native",
      plan: "native",
    },
    resume: true,
    // Not until a local plugin is shown to load under `settingSources: []`.
    skills: "none",
  },
  contractVersion: RUNTIME_CONTRACT_VERSION,
  extraFeatures: { subagents: "native" },
  kind: "claude_agent_sdk",
  optionsNamespace: "claude",
  process: "subprocess",
  runtimeVersion: CLAUDE_AGENT_SDK_VERSION,
  // Every tool the engine runs inherits its environment (profile.ts).
  toolEnv: "engine_inherited",
};

/** `runtime_options.claude`: no profile sets an engine knob yet. */
export const claudeOptionsSchema = z.object({}).strict();
export type ClaudeOptions = z.infer<typeof claudeOptionsSchema>;
