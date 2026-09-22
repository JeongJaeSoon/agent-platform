import { canonical, sha256Hex } from "@agent-platform/runtime-claude-codec";
import type { ClaudeRuntimeConfig } from "./config.ts";
import { publicProfile } from "./profile.ts";

export * from "@agent-platform/runtime-claude-codec";

/**
 * Digest of everything about a run's configuration that changes how a stored
 * transcript replays. The model credential is excluded — `publicProfile` drops
 * it — so rotating a key does not invalidate a checkpoint, while pointing the
 * run at a different endpoint or tool allowlist does.
 *
 * MCP servers are hashed whole, not by registry name: the same name can be
 * repointed at a different command, endpoint or tenant, and a checkpoint taken
 * under the old one is not replayable under the new one. That means a secret
 * embedded in a server definition also moves the fingerprint — the safe
 * direction, since the alternative is calling two different tool surfaces
 * compatible.
 *
 * What it does not cover: plugin *contents* at an unchanged path, and the
 * behaviour of an in-process MCP server. The SDK accepts a live `McpServer`
 * instance in `mcpServers`, which has no serializable identity and is cyclic —
 * hashing it verbatim throws. Such an entry is reduced to its class name, so
 * the fingerprint still distinguishes "an in-process server is registered under
 * this name" from "a different transport is", but not one in-process server
 * from another under the same name.
 */
export function claudeProfileFingerprint(
  config: Pick<
    ClaudeRuntimeConfig,
    | "appendSystemPrompt"
    | "mcpServers"
    | "model"
    | "permissionMode"
    | "plugins"
    | "profile"
    | "settingSources"
    | "tools"
  >,
): string {
  return sha256Hex(
    JSON.stringify(
      canonical({
        appendSystemPrompt: config.appendSystemPrompt ?? null,
        mcpServers: describeOpaque(config.mcpServers ?? {}),
        model: config.model,
        permissionMode: config.permissionMode ?? "default",
        plugins: [...(config.plugins ?? [])].sort((left, right) =>
          left.path.localeCompare(right.path),
        ),
        profile: publicProfile(config.profile),
        settingSources: config.settingSources ?? ["project"],
        tools: [...config.tools].sort(),
      }),
    ),
  );
}

/**
 * Replaces anything that is not plain data with a stable stand-in, so a live
 * object graph in the config cannot make the fingerprint throw. Recursion is
 * bounded by the same rule: a class instance is never descended into, which is
 * also what stops a cycle.
 */
function describeOpaque(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(describeOpaque);
  if (typeof value === "function") return { opaque: value.name || "function" };
  if (typeof value !== "object" || value === null) return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return { opaque: prototype.constructor?.name ?? "object" };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, describeOpaque(nested)]),
  );
}
