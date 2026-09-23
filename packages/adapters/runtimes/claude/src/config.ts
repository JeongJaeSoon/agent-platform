import {
  CLAUDE_AGENT_SDK_VERSION,
  CLAUDE_CODE_VERSION,
} from "@agent-platform/runtime-claude-codec";
import type {
  NativeEnvelope,
  RuntimeCapabilities,
  RuntimeConfig,
  TranscriptMirror,
} from "@agent-platform/runtime-core";

export { CLAUDE_AGENT_SDK_VERSION, CLAUDE_CODE_VERSION };

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

/**
 * Who a run acts for, said without any credential. A session belongs to an
 * owner partition (`AuthorizationContext.owner_scope` on the platform side),
 * so that partition is what a checkpoint belongs to as well: another user of
 * the same partition may resume it, the same endpoint under another partition
 * may not. It is hashed into the checkpoint fingerprint, which is why it must
 * be stable across credential rotation and must never be the secret itself.
 */
export type RuntimePrincipal = { ownerScope: string };

/**
 * What a worker holds in place of a provider credential (94S-252): a token
 * the egress proxy at `transport` exchanges for the real one. `endpoint`
 * stays the upstream the proxy forwards to, which is what policy approves
 * and the checkpoint fingerprint names.
 */
export type EgressTokenAuth = {
  kind: "egress_token";
  token: string;
  transport: string;
};

export type RuntimeProfile = (
  | {
      auth: { kind: "api_key"; value: string } | EgressTokenAuth;
      endpoint: string;
      kind: "anthropic";
    }
  | {
      auth:
        | { kind: "api_key"; value: string }
        | { kind: "bearer"; value: string }
        | EgressTokenAuth;
      endpoint: string;
      kind: "litellm";
    }
) & { principal: RuntimePrincipal };

/**
 * Caller-asserted identities for the parts of a config the checkpoint
 * fingerprint cannot hash by value: an in-process MCP server is a live object
 * graph, and a local plugin is a path whose contents can change underneath
 * it. Each is keyed the way the SDK names it — MCP servers by registry name,
 * plugins by path — and the value is whatever the caller can keep stable for
 * one tool surface and change for another: a version, a content digest, a
 * release id. The fingerprint hashes the identity in place of the object, so
 * two runs claim compatibility exactly when their callers say so.
 */
export type ComponentIdentities = {
  mcpServers?: Record<string, string>;
  plugins?: Record<string, string>;
};

export type ClaudeRuntimeConfig = RuntimeConfig & {
  appendSystemPrompt?: string;
  claudeConfigDir: string;
  /**
   * Required for every plugin and for every MCP server that is not plain
   * data; a run missing one is refused before it starts, because no
   * checkpoint it took could say what it was compatible with.
   */
  identities?: ComponentIdentities;
  mcpServers?: Record<string, unknown>;
  permissionMode?: PermissionMode;
  plugins?: RuntimePlugin[];
  profile: RuntimeProfile;
  /**
   * The repository's own CLAUDE.md, let into the system prompt by the caller
   * rather than loaded by the engine: the engine only reads it together with
   * the rest of the project source — settings.json with its hooks, env and
   * permission rules — so this requires `settingSources: []`. `contents` is
   * whatever the caller read (null when the repository has none); where it
   * reads it from is the trust decision, and it is the caller's.
   *
   * The checkpoint fingerprint takes the switch, not the text, so a branch
   * that changed its CLAUDE.md does not make a session's checkpoints
   * unresumable. A resumed run keeps the text it started with anyway: the
   * engine replays the system prompt it recorded (`snapshot`) until the
   * conversation is compacted, and after that carries this run's `contents`.
   */
  repositoryClaudeMd?: { contents: string | null };
  /**
   * How many times the engine retries a failed Messages request (5xx,
   * overload, rate limit, connection) before the turn fails with
   * `terminal_reason: "api_error"`. Unset leaves the engine's own policy.
   */
  providerMaxRetries?: number;
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
  /**
   * PEM bundle the engine trusts in addition to the system store, for a
   * Messages endpoint behind a private CA or a TLS-terminating egress. It is
   * named here, by whoever composes the runtime, and never picked up from the
   * host environment: an ambient bundle would quietly become a trust root for
   * credential-bearing API traffic.
   */
  trustedCaBundle?: string;
};
