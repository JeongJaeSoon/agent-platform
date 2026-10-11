import { createHash } from "node:crypto";
import {
  type AgentCard,
  type AgentRelease,
  canonicalJsonOfJson,
  type EffectiveTools,
  type PolicyPins,
} from "@agent-platform/contracts";
import {
  type CatalogProfile,
  profileFingerprint,
} from "../sessions/catalog.ts";

// Ported from Kollegium v1 `packages/core/src/ids.ts` (Apache-2.0,
// JeongJaeSoon/kollegium @ d711706): a release is named by the hash of what
// it runs, so the same content released twice is the same release.

// Bumped when the hashed shape changes, so an old id can never equal a new
// one by accident.
const RELEASE_ID_VERSION = 1;

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function cardContentSha256(card: AgentCard): string {
  return sha256Hex(canonicalJsonOfJson(card));
}

/** Everything a release id covers. Who made or approved it is not here. */
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
      release_id_version: RELEASE_ID_VERSION,
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

/** A stored release whose content no longer hashes to its own id. */
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
 * card forbids, in the profile's order. Null when the card asks for more than
 * the profile gives.
 */
export function resolveReleaseContent(
  card: AgentCard,
  profileId: string,
  profile: CatalogProfile,
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
  const effective_tools: EffectiveTools = { tools, mcp: [] };
  const policy_pins: PolicyPins = {};
  return {
    ok: true,
    content: {
      runtime_profile_id: profileId,
      profile_digest: profileFingerprint(profile),
      // runtimeConfigOf's shape without the attempt's egress token: the
      // worker gets that at claim, and a credential has no place here.
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
