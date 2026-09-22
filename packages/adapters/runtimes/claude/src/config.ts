import type {
  NativeEnvelope,
  RuntimeCapabilities,
  RuntimeConfig,
  TranscriptMirror,
} from "@agent-platform/runtime-core";

export const CLAUDE_AGENT_SDK_VERSION = "0.3.270";
/** The Claude Code build the pinned SDK ships and reports in `system/init`. */
export const CLAUDE_CODE_VERSION = "2.1.270";

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
  /**
   * Where the engine mirrors root and subagent transcripts. Without it the
   * transcript lives only on the container's disk, which no checkpoint can
   * outlive.
   */
  sessionStore?: TranscriptMirror;
  /**
   * Resume from the transcript on this container's own disk instead of from a
   * checkpoint. Only a local tool has any business setting it: a restore that
   * forgot to bind its mirror would otherwise look exactly like this and
   * silently replay whatever the disk happens to hold.
   */
  localTranscriptResume?: true;
  settingSources?: [] | ["project"];
};
