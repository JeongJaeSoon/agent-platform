import type { AgentRun } from "./agent-run.ts";
import type { RuntimeCapabilities } from "./capabilities.ts";

export type AgentInput = {
  message: string;
  uuid: string;
};

export type PermissionRequest = {
  input: Record<string, unknown>;
  requestId: string;
  signal: AbortSignal;
  tool: string;
  toolUseId: string;
};

export type PermissionDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string; interrupt?: boolean };

export type RuntimeHooks = {
  onPermission(request: PermissionRequest): Promise<PermissionDecision>;
};

/**
 * A run either starts a fresh engine session or resumes one from the handle
 * a previous checkpoint produced. There is deliberately no separate open()
 * entry point: the mode travels with the config.
 */
export type RuntimeMode =
  | { mode: "new"; resume?: undefined }
  | { mode: "resume"; resume: string };

export type RuntimeConfig = RuntimeMode & {
  correlationId: string;
  cwd: string;
  home: string;
  /**
   * The most this run may spend, in USD, as the engine estimates it. The
   * engine ends the turn that crosses it. It counts from zero for every run,
   * resumed ones included, so a caller holding a longer budget passes what
   * is left of it.
   */
  maxBudgetUsd?: number;
  maxTurns?: number;
  model: string;
  tools: string[];
};

export interface AgentRuntime<TConfig extends RuntimeConfig = RuntimeConfig> {
  readonly capabilities: RuntimeCapabilities;
  start(config: TConfig, hooks: RuntimeHooks): AgentRun;
}
