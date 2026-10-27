import type { PermissionMode } from "@werft-ai/contracts";

import type { AgentRun } from "./agent-run.ts";
import type { TranscriptMirror } from "./checkpoint-manifest.ts";
import type { RuntimeDescriptor } from "./descriptor.ts";

export type AgentInput = {
  message: string;
  uuid: string;
};

/**
 * A run either starts a fresh engine session or resumes one from the handle
 * a previous checkpoint produced. There is deliberately no separate open()
 * entry point: the mode travels with the config.
 */
export type RuntimeMode =
  | { mode: "new"; resume?: undefined }
  | {
      mode: "resume";
      resume: string;
      /**
       * Resume from the transcript on this container's own disk instead of
       * from a checkpoint; only a local tool sets it.
       */
      localTranscriptResume?: true;
    };

export type RuntimeStartConfig = RuntimeMode & {
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
  permissionMode: PermissionMode;
  tools: readonly string[];
};

/**
 * What a worker holds in place of a provider credential: a token the egress
 * proxy at `transport` exchanges for the real one.
 */
export type EgressTokenAuth = {
  kind: "egress_token";
  token: string;
  transport: string;
};

export type ProviderAuth =
  | { kind: "api_key"; value: string }
  | { kind: "bearer"; value: string }
  | EgressTokenAuth;

/**
 * Who and what a run acts against. `principal` is the session's owner
 * partition, never a credential: it is hashed into every checkpoint
 * fingerprint, so it must survive credential rotation.
 */
export type RuntimeBindings = {
  principal: { ownerScope: string };
  provider: {
    auth: ProviderAuth;
    endpoint: string;
    kind: "anthropic" | "litellm";
  };
  /** Where the engine mirrors its transcript; without one no checkpoint outlives the container. */
  transcript?: TranscriptMirror;
};

export type InstructionPart = { scope: "platform"; text: string };

/** A remote MCP server, reached through the egress proxy with the attempt's token. */
export type PlatformMcpServer = {
  name: string;
  /** What the server is for the fingerprint: its release binding. */
  binding: string;
  url: string;
  token: string;
  /** The tool allowlist; the run exposes only this server's share of it. */
  tools: readonly string[];
};

export type RuntimeBundle = {
  instructions: readonly InstructionPart[];
  /**
   * The repository's own instructions file as committed, let in by the
   * profile; `text` is null when the repository has none. Null when the
   * profile keeps it out.
   */
  repoInstructions: { file: string; text: string | null } | null;
  mcpServers: readonly PlatformMcpServer[];
};

export type RuntimeStart = {
  config: RuntimeStartConfig;
  bindings: RuntimeBindings;
  bundle: RuntimeBundle;
};

export interface AgentRuntime {
  readonly descriptor: RuntimeDescriptor;
  start(start: RuntimeStart): AgentRun;
}
