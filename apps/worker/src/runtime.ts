import type { SessionEvent } from "@agent-platform/contracts";

export const CLAUDE_AGENT_SDK_VERSION = "0.3.270";

export type PermissionMode = "default" | "acceptEdits" | "dontAsk" | "plan";

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

export type NativeSdkMessage = {
  [key: string]: unknown;
  type: string;
};

export type NativeEnvelope = {
  correlation_id: string;
  message: NativeSdkMessage;
  schema_version: "sdk-envelope/v1";
  sdk_version: typeof CLAUDE_AGENT_SDK_VERSION;
};

export type AgentFrame = {
  envelope: NativeEnvelope;
  events: SessionEvent[];
};

export type RuntimePlugin = { path: string; type: "local" };

export type RuntimeConfig = {
  appendSystemPrompt?: string;
  claudeConfigDir: string;
  correlationId: string;
  cwd: string;
  home: string;
  maxTurns?: number;
  mcpServers?: Record<string, unknown>;
  model: string;
  permissionMode?: PermissionMode;
  plugins?: RuntimePlugin[];
  profile: RuntimeProfile;
  resume?: string;
  settingSources?: [] | ["project"];
  tools: string[];
};

export type RuntimeProfile =
  | {
      auth: { kind: "api_key"; value: string };
      endpoint: string;
      kind: "anthropic";
    }
  | {
      auth:
        | { kind: "api_key"; value: string }
        | { kind: "bearer"; value: string };
      endpoint: string;
      kind: "litellm";
    };

export interface AgentRun extends AsyncIterable<AgentFrame> {
  abort(): void;
  close(): void;
  finishInput(): void;
  interrupt(): Promise<{ stillQueued: string[] }>;
  send(input: AgentInput): void;
}

export interface AgentRuntime {
  start(
    config: RuntimeConfig,
    onPermission: (request: PermissionRequest) => Promise<PermissionDecision>,
  ): AgentRun;
}
