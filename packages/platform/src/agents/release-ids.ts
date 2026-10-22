import { createHash } from "node:crypto";
import {
  type AgentCard,
  type AgentRelease,
  canonicalJsonOfJson,
  DEFAULT_TOOL_POLICY,
  type EffectiveTools,
  MCP_TOOL_PREFIX,
  type PolicyPins,
  type ToolPolicy,
} from "@werft-ai/contracts";
import {
  type CatalogProfile,
  pinnedMcpTools,
  profileFingerprint,
  type SessionCatalog,
} from "../sessions/catalog.ts";

// Ported from Kollegium v1 `packages/core/src/ids.ts` (Apache-2.0,
// JeongJaeSoon/kollegium @ d711706).

// Bumped when the hashed shape changes, so an old id can never equal a new
// one by accident. 2: `policy_pins` went from a placeholder `{}` to the
// resolved tool policy. A stored `{}` release keeps hashing as 1, so its id
// still verifies.
function releaseIdVersion(identity: ReleaseIdentity): number {
  return identity.policy_pins.tools === undefined ? 1 : 2;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function cardContentSha256(card: AgentCard): string {
  return sha256Hex(canonicalJsonOfJson(card));
}

export type ReleaseIdentity = Pick<
  AgentRelease,
  | "agent_id"
  | "card_sha256"
  | "runtime_profile_id"
  | "profile_digest"
  | "runtime_config_snapshot"
  | "effective_tools"
  | "policy_pins"
>;

export function deriveReleaseId(identity: ReleaseIdentity): string {
  return `sha256:${sha256Hex(
    canonicalJsonOfJson({
      release_id_version: releaseIdVersion(identity),
      agent_id: identity.agent_id,
      card_sha256: identity.card_sha256,
      runtime_profile_id: identity.runtime_profile_id,
      profile_digest: identity.profile_digest,
      runtime_config_snapshot: identity.runtime_config_snapshot,
      effective_tools: identity.effective_tools,
      policy_pins: identity.policy_pins,
    }),
  )}`;
}

export class ReleaseIdentityError extends Error {
  constructor(readonly releaseId: string) {
    super(`agent release ${releaseId} does not hash to its id`);
  }
}

export function assertReleaseIdentity(release: AgentRelease): void {
  if (deriveReleaseId(release) !== release.id) {
    throw new ReleaseIdentityError(release.id);
  }
}

export type ReleaseCompatibilityError = { field: string; message: string };

/**
 * What a card runs as under a profile: the tools both allow, minus what the
 * card forbids, in the profile's order. An error when the card's model or
 * tools fall outside the profile.
 */
export function resolveReleaseContent(
  card: AgentCard,
  profileId: string,
  profile: CatalogProfile,
  mcpServers: SessionCatalog["mcp_servers"] = {},
):
  | {
      ok: true;
      content: Omit<ReleaseIdentity, "agent_id" | "card_sha256">;
    }
  | { ok: false; error: ReleaseCompatibilityError } {
  if (card.model !== profile.model) {
    return {
      ok: false,
      error: {
        field: "card.model",
        message: `model ${card.model} is not the model of runtime profile ${profileId}`,
      },
    };
  }
  const allowed = new Set(profile.tools);
  const outside = (card.capabilities.tools ?? []).filter(
    (tool) => !allowed.has(tool),
  );
  if (outside.length > 0) {
    return {
      ok: false,
      error: {
        field: "card.capabilities.tools",
        message: `runtime profile ${profileId} does not allow ${outside.join(", ")}`,
      },
    };
  }
  const asked =
    card.capabilities.tools === null
      ? allowed
      : new Set(card.capabilities.tools);
  const forbidden = new Set(card.capabilities.forbidden);
  const tools = profile.tools.filter(
    (tool) => asked.has(tool) && !forbidden.has(tool),
  );
  const policy = resolveToolPolicy(card, profileId, tools);
  if (!policy.ok) return policy;
  const policy_pins = policy.pins;
  const mcp = resolveMcpServer(card, policy_pins, mcpServers);
  if (!mcp.ok) return mcp;
  const effective_tools: EffectiveTools = { tools, mcp: mcp.tools };
  return {
    ok: true,
    content: {
      runtime_profile_id: profileId,
      profile_digest: profileFingerprint(profile),
      // No credential here, not even the attempt's egress token: the worker
      // gets that at claim.
      runtime_config_snapshot: {
        model: profile.model,
        tools,
        permission_mode: profile.permission_mode,
        provider: {
          kind: profile.provider.kind,
          endpoint: profile.provider.endpoint,
        },
        ...(profile.project_settings?.claude_md === true
          ? { project_settings: profile.project_settings }
          : {}),
      },
      effective_tools,
      policy_pins,
    },
  };
}

/**
 * The card's MCP server must be one the catalog declares, and its credential
 * one the card names, so the bind, activation and session-start checks
 * already cover it; its tools run only where the release pins them `allow`.
 */
function resolveMcpServer(
  card: AgentCard,
  pins: PolicyPins,
  mcpServers: NonNullable<SessionCatalog["mcp_servers"]>,
):
  | { ok: true; tools: string[] }
  | { ok: false; error: ReleaseCompatibilityError } {
  const named = card.capabilities.mcp?.[0];
  if (named === undefined) return { ok: true, tools: [] };
  const server = Object.hasOwn(mcpServers, named.server)
    ? mcpServers[named.server]
    : undefined;
  if (server === undefined) {
    return {
      ok: false,
      error: {
        field: "card.capabilities.mcp",
        message: `MCP server ${named.server} is not in the catalog`,
      },
    };
  }
  if (
    !(card.capabilities.credential_refs ?? []).includes(server.credential_ref)
  ) {
    return {
      ok: false,
      error: {
        field: "card.capabilities.credential_refs",
        message: `MCP server ${named.server} calls as ${server.credential_ref}, which the card must name`,
      },
    };
  }
  const tools = pinnedMcpTools(named.server, pins.tools?.per_tool ?? {});
  if (tools.length === 0) {
    return {
      ok: false,
      error: {
        field: "card.capabilities.tool_policy.per_tool",
        message: `no ${MCP_TOOL_PREFIX}${named.server}__ tool is allowed`,
      },
    };
  }
  return { ok: true, tools };
}

/**
 * Pins a policy for every tool the release runs, so a later change to the
 * defaults cannot move a release that already exists. A built-in tool the
 * card names must be one the release runs: a policy for a tool it cannot
 * call would read as a permission it does not have.
 */
function resolveToolPolicy(
  card: AgentCard,
  profileId: string,
  tools: string[],
):
  | { ok: true; pins: PolicyPins }
  | { ok: false; error: ReleaseCompatibilityError } {
  const declared = card.capabilities.tool_policy;
  const defaults = {
    builtin: declared?.default?.builtin ?? DEFAULT_TOOL_POLICY.builtin,
    mcp: declared?.default?.mcp ?? DEFAULT_TOOL_POLICY.mcp,
  };
  const named = declared?.per_tool ?? {};
  const running = new Set(tools);
  const unknown = Object.keys(named).filter(
    (tool) => !tool.startsWith(MCP_TOOL_PREFIX) && !running.has(tool),
  );
  if (unknown.length > 0) {
    return {
      ok: false,
      error: {
        field: "card.capabilities.tool_policy.per_tool",
        message: `release under runtime profile ${profileId} does not run ${unknown.join(", ")}`,
      },
    };
  }
  // Entries, not property writes: a tool named `__proto__` stays a tool.
  const per_tool: [string, ToolPolicy][] = [
    ...tools.map((tool): [string, ToolPolicy] => [
      tool,
      Object.hasOwn(named, tool)
        ? (named[tool] as ToolPolicy)
        : defaults.builtin,
    ]),
    ...Object.entries(named).filter(([tool]) =>
      tool.startsWith(MCP_TOOL_PREFIX),
    ),
  ];
  return {
    ok: true,
    pins: {
      tools: { default: defaults, per_tool: Object.fromEntries(per_tool) },
    },
  };
}
