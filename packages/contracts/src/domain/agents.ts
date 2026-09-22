import { z } from "zod";

import {
  agentIdSchema,
  agentReleaseIdSchema,
  agentVersionIdSchema,
  revisionSchema,
  sha256HexSchema,
  timestampSchema,
  userIdSchema,
  workspaceIdSchema,
} from "../shared/index.ts";

export const AGENT_STATUS_VALUES = ["active", "paused", "archived"] as const;
export const agentStatusSchema = z.enum(AGENT_STATUS_VALUES);

export const AGENT_CARD_LANGUAGE_VALUES = ["ko", "en"] as const;
export const AGENT_RULE_SOURCE_VALUES = ["user", "correction"] as const;

export const agentSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase kebab-case");
export const toolNameSchema = z.string().min(1).max(128);

export const agentRuleSchema = z
  .object({
    id: z.string().min(1).max(64),
    text: z.string().min(1).max(2_000),
    source: z.enum(AGENT_RULE_SOURCE_VALUES),
  })
  .strict();

export const agentCapabilitiesSchema = z
  .object({
    /** `null` = every tool the runtime profile allows, `[]` = none (Codex B07). */
    tools: z.array(toolNameSchema).nullable(),
    /** Names resolved against the runtime profile's MCP allowlist. */
    mcp: z.array(toolNameSchema).nullable(),
    /** Server-enforced denials, not prose in the instructions. */
    forbidden: z.array(toolNameSchema).default([]),
  })
  .strict();

/**
 * The card a person writes: role, instructions, model and capability range
 * (03 §4.1). `name`/`team` live on the agent row, not here, so renaming an
 * agent does not mint a new immutable version.
 *
 * `.strict()` is what enforces "a card holds no secrets": there is
 * structurally nowhere to put one, and a credential field is rejected rather
 * than silently stored. Credentials stay in the runtime profile.
 */
export const agentCardSchema = z
  .object({
    role: z.string().min(1).max(200),
    instructions: z.string().min(1).max(20_000),
    tone: z.string().min(1).max(200).optional(),
    language: z.enum(AGENT_CARD_LANGUAGE_VALUES).default("ko"),
    /** Must sit inside the runtime profile's model allowlist. */
    model: z.string().min(1).max(128),
    capabilities: agentCapabilitiesSchema,
    rules: z.array(agentRuleSchema).default([]),
  })
  .strict();

export const agentSchema = z
  .object({
    id: agentIdSchema,
    workspace_id: workspaceIdSchema,
    slug: agentSlugSchema,
    name: z.string().min(1).max(120),
    /** A card grouping string, never an authorization subject (Codex E09). */
    team: z.string().min(1).max(120).nullable(),
    status: agentStatusSchema,
    active_release_id: agentReleaseIdSchema.nullable(),
    activation_revision: revisionSchema,
    created_by: userIdSchema.nullable(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .strict();

/** Insert-only. `card_hash` is sha256 over the canonical JSON of the card. */
export const agentVersionSchema = z
  .object({
    id: agentVersionIdSchema,
    agent_id: agentIdSchema,
    number: z.number().int().positive(),
    card: agentCardSchema,
    card_hash: sha256HexSchema,
    created_by: userIdSchema.nullable(),
    created_at: timestampSchema,
  })
  .strict();

export const effectiveToolsSchema = z
  .object({
    tools: z.array(toolNameSchema),
    mcp: z.array(toolNameSchema),
  })
  .strict();

// A structural guard at the trust boundary, not secret detection: the
// repository's own `ClaudeRuntimeConfig` carries the live key at
// `profile.auth.value`, so handing a resolved config straight to this schema
// used to persist it. Rejecting the key names that hold a credential makes
// that mistake fail loudly at the parse instead of quietly in the database. A
// credential travels as a reference — `api_key_ref: "env:ANTHROPIC_API_KEY"` —
// and any key ending in `_ref` is allowed for exactly that reason.
const CREDENTIAL_KEY =
  /^(auth|authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|passphrase|credential|credentials|private[-_]?key)$/i;

function assertCredentialFree(
  value: unknown,
  path: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertCredentialFree(item, [...path, index], ctx);
    });
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (CREDENTIAL_KEY.test(key)) {
      ctx.addIssue({
        code: "custom",
        path: [...path, key],
        message: `${key} may not travel in a release snapshot; store a reference instead`,
      });
      continue;
    }
    assertCredentialFree(nested, [...path, key], ctx);
  }
}

/** The resolved profile config, with every credential left behind. */
export const runtimeConfigSnapshotSchema = z
  .record(z.string(), z.unknown())
  .superRefine((snapshot, ctx) => assertCredentialFree(snapshot, [], ctx));

/**
 * A version pinned to the runtime settings it was released against.
 *
 * The resolved config travels with the release so a profile edit cannot
 * change an in-flight session; a fingerprint mismatch at start is refused and
 * asks for a re-release instead (Codex B06).
 */
export const agentReleaseSchema = z
  .object({
    id: agentReleaseIdSchema,
    agent_id: agentIdSchema,
    version_id: agentVersionIdSchema,
    runtime_profile_id: z.string().min(1).max(128),
    runtime_profile_fingerprint: z.string().min(1).max(128),
    runtime_config_snapshot: runtimeConfigSnapshotSchema,
    effective_tools: effectiveToolsSchema,
    created_at: timestampSchema,
  })
  .strict();

export const createAgentRequestSchema = z
  .object({
    slug: agentSlugSchema,
    name: z.string().min(1).max(120),
    team: z.string().min(1).max(120).optional(),
  })
  .strict();
export const updateAgentRequestSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    team: z.string().min(1).max(120).nullable().optional(),
    status: agentStatusSchema.optional(),
  })
  .strict()
  .refine(
    (patch) => Object.keys(patch).length > 0,
    "at least one field is required",
  );

/** One-line hiring: a small model fills the card, a person edits it. */
export const draftAgentRequestSchema = z
  .object({
    prompt: z.string().min(1).max(4_000),
    name: z.string().min(1).max(120).optional(),
    team: z.string().min(1).max(120).optional(),
  })
  .strict();
export const draftAgentResponseSchema = z
  .object({
    agent_id: agentIdSchema,
    version_id: agentVersionIdSchema,
    card: agentCardSchema,
  })
  .strict();

export const createAgentVersionRequestSchema = z
  .object({ card: agentCardSchema })
  .strict();

/** CAS: a stale `expected_activation_revision` answers 409 with the current one. */
export const activateAgentRequestSchema = z
  .object({
    version_id: agentVersionIdSchema,
    runtime_profile_id: z.string().min(1).max(128),
    expected_activation_revision: revisionSchema,
  })
  .strict();
export const activateAgentResponseSchema = z
  .object({
    release_id: agentReleaseIdSchema,
    activation_revision: revisionSchema,
  })
  .strict();

/** 94S-132 config, read-only, so a card can pick a model it is allowed to use. */
export const runtimeProfileSummarySchema = z
  .object({
    id: z.string().min(1).max(128),
    fingerprint: z.string().min(1).max(128),
    models: z.array(z.string().min(1).max(128)),
    tools: z.array(toolNameSchema).nullable(),
    mcp: z.array(toolNameSchema).nullable(),
  })
  .strict();

export type AgentStatus = z.infer<typeof agentStatusSchema>;
export type AgentRule = z.infer<typeof agentRuleSchema>;
export type AgentCapabilities = z.infer<typeof agentCapabilitiesSchema>;
export type AgentCard = z.infer<typeof agentCardSchema>;
export type Agent = z.infer<typeof agentSchema>;
export type AgentVersion = z.infer<typeof agentVersionSchema>;
export type EffectiveTools = z.infer<typeof effectiveToolsSchema>;
export type AgentRelease = z.infer<typeof agentReleaseSchema>;
export type CreateAgentRequest = z.infer<typeof createAgentRequestSchema>;
export type UpdateAgentRequest = z.infer<typeof updateAgentRequestSchema>;
export type DraftAgentRequest = z.infer<typeof draftAgentRequestSchema>;
export type DraftAgentResponse = z.infer<typeof draftAgentResponseSchema>;
export type CreateAgentVersionRequest = z.infer<
  typeof createAgentVersionRequestSchema
>;
export type ActivateAgentRequest = z.infer<typeof activateAgentRequestSchema>;
export type ActivateAgentResponse = z.infer<typeof activateAgentResponseSchema>;
export type RuntimeProfileSummary = z.infer<typeof runtimeProfileSummarySchema>;
