import { canonicalJsonOfJson } from "@agent-platform/contracts";
import { sha256Hex } from "@agent-platform/runtime-claude-codec";
import { describeComponents } from "./component-identity.ts";
import type { ClaudeRuntimeConfig } from "./config.ts";
import { publicProfile } from "./profile.ts";

export * from "@agent-platform/runtime-claude-codec";

/**
 * Digest of everything about a run's configuration that changes how a stored
 * transcript replays, plus who the run acts for. The model credential is
 * excluded — `publicProfile` drops it — so rotating a key does not invalidate
 * a checkpoint, while pointing the run at a different endpoint, tool
 * allowlist or owner partition does. The principal is what keeps two tenants
 * on one shared endpoint from producing the same digest and resuming each
 * other's sessions.
 *
 * MCP servers and plugins go through `describeComponents`: a serializable
 * server is hashed as its configuration with credential containers reduced to
 * key names, and anything the fingerprint cannot hash by value — an
 * in-process server, a plugin's contents — is hashed as the identity its
 * caller declared. A component without one throws
 * `UnidentifiedComponentError`; run validation calls this first so such a
 * config is refused before it starts rather than at its first checkpoint.
 *
 * It stays in this package, not in the SDK-free codec package, because it
 * reads the run's configuration; the control plane only compares digests.
 */
export function claudeProfileFingerprint(
  config: Pick<
    ClaudeRuntimeConfig,
    | "appendSystemPrompt"
    | "identities"
    | "mcpServers"
    | "model"
    | "permissionMode"
    | "plugins"
    | "profile"
    | "repositoryClaudeMd"
    | "settingSources"
    | "tools"
  >,
): string {
  const components = describeComponents(config);
  return sha256Hex(
    canonicalJsonOfJson({
      appendSystemPrompt: config.appendSystemPrompt ?? null,
      mcpServers: components.mcpServers,
      model: config.model,
      permissionMode: config.permissionMode ?? "default",
      plugins: components.plugins,
      profile: publicProfile(config.profile),
      // Only when on, so a run that never let CLAUDE.md in keeps the
      // digest its checkpoints were taken under before this switch existed.
      ...(config.repositoryClaudeMd === undefined
        ? {}
        : { repositoryClaudeMd: true }),
      settingSources: config.settingSources ?? ["project"],
      tools: [...config.tools].sort(),
    }),
  );
}
