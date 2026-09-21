import type {
  NativeEnvelope,
  RuntimeCapabilities,
  RuntimeConfig,
} from "@agent-platform/runtime-core";

export const CLAUDE_AGENT_SDK_VERSION = "0.3.270";

export const CLAUDE_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  checkpoint: true,
  interrupt: true,
  resume: true,
};

export type PermissionMode = "default" | "acceptEdits" | "dontAsk" | "plan";

export type ClaudeNativeEnvelope = NativeEnvelope & {
  sdk_version: typeof CLAUDE_AGENT_SDK_VERSION;
};

export type RuntimePlugin = { path: string; type: "local" };

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

export type ClaudeRuntimeConfig = RuntimeConfig & {
  appendSystemPrompt?: string;
  claudeConfigDir: string;
  mcpServers?: Record<string, unknown>;
  permissionMode?: PermissionMode;
  plugins?: RuntimePlugin[];
  profile: RuntimeProfile;
  settingSources?: [] | ["project"];
};
