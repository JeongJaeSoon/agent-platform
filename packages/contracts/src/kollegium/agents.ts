import { z } from "zod";

import {
  agentIdSchema,
  agentReleaseIdSchema,
  agentVersionIdSchema,
  canonicalJson,
  INT4_MAX,
  pageSchema,
  paginationQuerySchema,
  receiptIdSchema,
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

/**
 * The name of a credential held outside Werft — a secret store entry, a
 * remote MCP server connection — never its value (design 4.4).
 */
export const CREDENTIAL_REF_PATTERN = "^[a-z0-9][a-z0-9._:/-]{0,127}$";
export const credentialRefSchema = z
  .string()
  .regex(
    new RegExp(CREDENTIAL_REF_PATTERN),
    "must be a lowercase credential name, not a value",
  );
export const CREDENTIAL_BINDING_TARGET_VALUES = [
  "agent",
  "agent_identity",
] as const;

/** What happens when the agent calls a tool. Kiel evaluates it per call (D9). */
export const TOOL_POLICY_VALUES = ["allow", "ask", "deny"] as const;
export const toolPolicySchema = z.enum(TOOL_POLICY_VALUES);

/** Remote MCP server tools are named `mcp__<server>__<tool>` by the SDK. */
export const MCP_TOOL_PREFIX = "mcp__";

export const toolPolicyDefaultsSchema = z
  .object({ builtin: toolPolicySchema, mcp: toolPolicySchema })
  .strict();

/** Same defaults as Managed Agents (D12). */
export const DEFAULT_TOOL_POLICY = {
  builtin: "allow",
  mcp: "ask",
} as const satisfies z.infer<typeof toolPolicyDefaultsSchema>;

/** A card's say over its tools; anything left out takes the default. */
export const cardToolPolicySchema = z
  .object({
    default: toolPolicyDefaultsSchema.partial().strict().optional(),
    per_tool: z.record(toolNameSchema, toolPolicySchema).optional(),
  })
  .strict();

export const agentRuleSchema = z
  .object({
    id: z.string().min(1).max(64),
    text: z.string().min(1).max(2_000),
    source: z.enum(AGENT_RULE_SOURCE_VALUES),
  })
  .strict();

/** Its tools are `mcp__<id>__<tool>`, so the id holds no `__`. */
export const MCP_SERVER_ID_PATTERN = "^[a-z0-9](?:[a-z0-9-]|_(?!_)){0,31}$";
export const mcpServerIdSchema = z
  .string()
  .regex(new RegExp(MCP_SERVER_ID_PATTERN), "must be a catalog MCP server id");
export const cardMcpServerSchema = z
  .object({ server: mcpServerIdSchema })
  .strict();

export const agentCapabilitiesSchema = z
  .object({
    /** `null` = every tool the runtime profile allows, `[]` = none. */
    tools: z.array(toolNameSchema).nullable(),
    /**
     * The remote MCP server the agent calls, by the operator catalog's id
     * (`mcp_servers.<id>`), which fixes its URL, credential and workspaces.
     * Null for none, so a card written before it keeps its content hash.
     */
    mcp: z.array(cardMcpServerSchema).min(1).max(1).nullable(),
    /** Server-enforced denials, not prose in the instructions. */
    forbidden: z.array(toolNameSchema).default([]),
    /**
     * Optional, with no default, so a card written before it existed keeps
     * its content hash. Changing it makes a new version, hence a new release.
     */
    tool_policy: cardToolPolicySchema.optional(),
    /**
     * The credentials the agent runs with, by name. Optional for the same
     * reason as `tool_policy`. Each must be bound to the agent before a
     * release of this version activates or starts a session (D11).
     */
    credential_refs: z
      .array(credentialRefSchema)
      .max(32)
      .refine(
        (refs) => new Set(refs).size === refs.length,
        "credential_refs must not repeat a name",
      )
      .optional(),
  })
  .strict();

/**
 * The card a person writes: role, instructions, model and capability range
 * (03 §4.1). `name` lives on the agent row, not here, so renaming an
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
    language: z.enum(AGENT_CARD_LANGUAGE_VALUES).default("ko"),
    /** Must sit inside the runtime profile's model allowlist. */
    model: z.string().min(1).max(128),
    capabilities: agentCapabilitiesSchema,
    rules: z.array(agentRuleSchema).default([]),
  })
  .strict();

/**
 * A card as stored. Cards written before `tone` was dropped (94S-761) still
 * hold it; it is accepted and left out of what is read. The version's
 * `content_sha256` and its releases' `card_sha256` keep hashing the stored
 * card, so nothing re-hashes what this returns.
 */
export const storedAgentCardSchema = agentCardSchema
  .extend({ tone: z.string().optional() })
  .transform(({ tone: _dropped, ...card }): AgentCard => card);

/** `-1` until the first activation, which is why it is not a `revision`. */
export const activationRevisionSchema = z.number().int().min(-1).max(INT4_MAX);

export const agentSchema = z
  .object({
    id: agentIdSchema,
    workspace_id: workspaceIdSchema,
    slug: agentSlugSchema,
    name: z.string().min(1).max(120),
    status: agentStatusSchema,
    active_release_id: agentReleaseIdSchema.nullable(),
    activation_revision: activationRevisionSchema,
    created_by: userIdSchema.nullable(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .strict();

/** Insert-only. `content_sha256` is sha256 over the canonical JSON of the card. */
export const agentVersionSchema = z
  .object({
    id: agentVersionIdSchema,
    agent_id: agentIdSchema,
    version_no: z.number().int().positive(),
    card: agentCardSchema,
    content_sha256: sha256HexSchema,
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
// that mistake fail loudly at the parse instead of quietly in the database.
//
// The match is on a *word* inside the key, not on the whole key, because the
// names that actually appear are compound: `client_secret`, `signing_secret`,
// `botToken`, `secretAccessKey`. A credential travels as a reference —
// `api_key_ref: "env:ANTHROPIC_API_KEY"` — so a key whose last word is `ref`
// is allowed, and that is the only exemption.
//
// It errs wide on purpose: a false positive is a parse error the author fixes
// by renaming or by storing a reference, a false negative is a live key in an
// immutable row.
//
// `auth`, `env` and `headers` are rejected as whole keys rather than by word.
// They are containers of resolved values — `mcpServers.notion.env.NOTION_API`
// is a live credential under a name no word list can recognise — and a release
// snapshot has no business holding a resolved environment at all: the runtime
// resolves it at launch from `env_ref`. `auth_kind` and `header_order` name
// one of these without holding it, which is why the match is on the whole key.
//
// What this cannot see: a credential under a name that says nothing, at the
// top level (`notion: "live-value"`). The guard is structural — whoever builds
// the release is still the one responsible for not putting it there.
const CREDENTIAL_WORD =
  /^(key|keys|token|tokens|secret|secrets|password|passphrase|credential|credentials)$/i;
const CREDENTIAL_KEY = /^(auth|authorization|env|environment|headers)$/i;

// `signingSecret` → [signing, Secret]; `client_secret` → [client, secret];
// `APIKey` → [API, Key]. Without the second boundary an acronym swallows the
// word after it and `JWTToken` reads as one unknown word.
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0);
}

// `env:ANTHROPIC_API_KEY`, `secret:slack/bot`, `vault:kv/data/x#field`. A
// reference names where the value lives; it is not the value.
const REFERENCE_VALUE = /^[a-z][a-z0-9+.-]*:.+$/;

function namesReference(key: string): boolean {
  const last = keyWords(key).at(-1);
  return last !== undefined && /^refs?$/i.test(last);
}

function holdsCredential(key: string): boolean {
  if (CREDENTIAL_KEY.test(key)) return true;
  if (namesReference(key)) return false;
  return keyWords(key).some((word) => CREDENTIAL_WORD.test(word));
}

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
    if (holdsCredential(key)) {
      ctx.addIssue({
        code: "custom",
        path: [...path, key],
        message: `${key} may not travel in a release snapshot; store a reference instead`,
      });
      continue;
    }
    // The `_ref` suffix buys an exemption from the word scan, so the value
    // has to earn it: a key named like a reference holding a literal
    // credential would otherwise be the easiest way through this guard.
    if (
      namesReference(key) &&
      !(typeof nested === "string" && REFERENCE_VALUE.test(nested))
    ) {
      ctx.addIssue({
        code: "custom",
        path: [...path, key],
        message: `${key} must be a reference such as env:NAME, not a value`,
      });
      continue;
    }
    assertCredentialFree(nested, [...path, key], ctx);
  }
}

/** The resolved profile config, with every credential left behind. */
export const runtimeConfigSnapshotSchema = z
  .record(z.string(), z.unknown())
  .superRefine((snapshot, ctx) => {
    // The release id is a hash of this, so a snapshot `canonicalJson` cannot
    // represent — a Date, a Map, an undefined optional — is a release that
    // parses and then cannot be identified. Reuse the hash's own rule rather
    // than restate it.
    try {
      canonicalJson(snapshot);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: `not canonically representable: ${(error as Error).message}`,
      });
      return;
    }
    assertCredentialFree(snapshot, [], ctx);
  });

/**
 * The tool policy a release runs under, resolved: `per_tool` names every
 * effective tool, plus any MCP tool the card named. `default.mcp` covers the
 * MCP tools a remote server only reveals at run time.
 *
 * `tools` is absent only on a release stored before policies existed
 * (`{}`); every release created now carries it.
 */
export const policyPinsSchema = z
  .object({
    tools: z
      .object({
        default: toolPolicyDefaultsSchema,
        per_tool: z.record(toolNameSchema, toolPolicySchema),
      })
      .strict()
      .optional(),
  })
  .strict();

export const RELEASE_NOTE_MAX_CODE_POINTS = 200;

// Counted in code points, as the column's char_length check counts them.
// Postgres text cannot store NUL, so it is refused here rather than at insert.
const releaseNoteSchema = z
  .string()
  .refine((note) => {
    const length = [...note].length;
    return length >= 1 && length <= RELEASE_NOTE_MAX_CODE_POINTS;
  }, `note must be 1 to ${RELEASE_NOTE_MAX_CODE_POINTS} characters`)
  .refine((note) => !note.includes("\u0000"), "note must not contain NUL");

/**
 * A version pinned to the runtime settings it was released against.
 *
 * The resolved config travels with the release so a profile edit cannot
 * change an in-flight session; a digest mismatch at start is refused and
 * asks for a re-release instead. Everything but `created_by`, `approved_by`,
 * `note` and the timestamps goes into the release id.
 */
export const agentReleaseSchema = z
  .object({
    id: agentReleaseIdSchema,
    agent_id: agentIdSchema,
    version_id: agentVersionIdSchema,
    card_sha256: sha256HexSchema,
    runtime_profile_id: z.string().min(1).max(128),
    profile_digest: z.string().min(1).max(128),
    runtime_config_snapshot: runtimeConfigSnapshotSchema,
    effective_tools: effectiveToolsSchema,
    policy_pins: policyPinsSchema,
    created_by: userIdSchema.nullable(),
    created_at: timestampSchema,
    /** Set by the first activation, never by creating the release. */
    approved_by: userIdSchema.nullable(),
    approved_at: timestampSchema.nullable(),
    /** What the person releasing it wrote; a re-release keeps the first. */
    note: releaseNoteSchema.nullable(),
  })
  .strict();

export const agentIdParamsSchema = z.object({ id: agentIdSchema });

export const agentDetailSchema = z
  .object({
    agent: agentSchema,
    versions: z.array(agentVersionSchema),
    releases: z.array(agentReleaseSchema),
    active_release: agentReleaseSchema.nullable(),
  })
  .strict();
/** How much of a version's instructions a list summary carries. */
export const AGENT_SUMMARY_INSTRUCTIONS_MAX = 300;

/**
 * What a list shows of an agent beyond its row, read in one go for the page
 * so a list of cards does not ask once per agent. Only with
 * `include=summary`; without it the items are exactly `agentSchema`.
 */
export const agentSummarySchema = z
  .object({
    /** The version people talk to, or the newest draft before any release. */
    version: z
      .object({
        version_no: z.number().int().positive(),
        role: z.string().min(1).max(200),
        /** The first AGENT_SUMMARY_INSTRUCTIONS_MAX characters. */
        instructions: z.string().min(1).max(AGENT_SUMMARY_INSTRUCTIONS_MAX),
        mcp_servers: z.array(mcpServerIdSchema),
        credential_refs: z.array(credentialRefSchema),
      })
      .strict(),
    /** The active release's, or null before any activation. */
    runtime_profile_id: z.string().min(1).max(128).nullable(),
    /** Names with a live binding on the agent. */
    bound_credential_refs: z.array(credentialRefSchema),
    /** Admins by display name (email when unset), then admin teams by name. */
    admins: z.array(z.string()),
    /**
     * The agent's sessions the caller can see, by the status
     * GET /v1/sessions shows them in.
     */
    needs_input_count: z.number().int().nonnegative(),
    running_count: z.number().int().nonnegative(),
  })
  .strict();

export const agentListItemSchema = agentSchema
  .extend({ summary: agentSummarySchema.optional() })
  .strict();

export const listAgentsQuerySchema = paginationQuerySchema.extend({
  include: z.literal("summary").optional(),
});
export const listAgentsResponseSchema = pageSchema(agentListItemSchema);
const agentCountSchema = z.number().int().nonnegative();
export const countAgentsResponseSchema = z.object({
  counts: z
    .object({
      all: agentCountSchema.meta({
        description:
          "How many agents GET /v1/agents lists, read to the last page.",
      }),
      administered: agentCountSchema.meta({
        description:
          "How many of those the caller administers now, directly or through a team.",
      }),
    })
    .strict(),
});

/** Creates the agent and its first version; nothing is released. */
export const createAgentRequestSchema = z
  .object({
    slug: agentSlugSchema,
    name: z.string().min(1).max(120),
    card: agentCardSchema,
  })
  .strict();
/** A `card` adds a version unless it equals one the agent already has. */
export const updateAgentRequestSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    card: agentCardSchema.optional(),
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
  })
  .strict();
export const draftAgentResponseSchema = z
  .object({
    agent_id: agentIdSchema,
    version_id: agentVersionIdSchema,
    card: agentCardSchema,
  })
  .strict();

export const createAgentReleaseRequestSchema = z
  .object({
    version_id: agentVersionIdSchema,
    runtime_profile_id: z.string().min(1).max(128),
    /** Trimmed; blank is refused. Leaves an existing release's note as is. */
    note: z.string().trim().pipe(releaseNoteSchema).optional(),
  })
  .strict();
/** `created: false` when the same content was released before. */
export const createAgentReleaseResponseSchema = z
  .object({ release: agentReleaseSchema, created: z.boolean() })
  .strict();

/** CAS: a stale `expected_revision` answers 409 REVISION_CONFLICT. */
export const activateAgentRequestSchema = z
  .object({
    release_id: agentReleaseIdSchema,
    expected_revision: activationRevisionSchema,
  })
  .strict();
/** `receipt_id` is null when the release was already active (a no-op). */
export const activateAgentResponseSchema = z
  .object({
    active_release_id: agentReleaseIdSchema,
    previous_release_id: agentReleaseIdSchema.nullable(),
    activation_revision: activationRevisionSchema,
    receipt_id: receiptIdSchema.nullable(),
  })
  .strict();

/** config, read-only, so a card can pick a model it is allowed to use. */
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
export type AgentSummary = z.infer<typeof agentSummarySchema>;
export type AgentListItem = z.infer<typeof agentListItemSchema>;
export type AgentVersion = z.infer<typeof agentVersionSchema>;
export type EffectiveTools = z.infer<typeof effectiveToolsSchema>;
export type AgentRelease = z.infer<typeof agentReleaseSchema>;
export type CreateAgentRequest = z.infer<typeof createAgentRequestSchema>;
export type UpdateAgentRequest = z.infer<typeof updateAgentRequestSchema>;
export type DraftAgentRequest = z.infer<typeof draftAgentRequestSchema>;
export type DraftAgentResponse = z.infer<typeof draftAgentResponseSchema>;
export type AgentDetail = z.infer<typeof agentDetailSchema>;
export type ListAgentsQuery = z.infer<typeof listAgentsQuerySchema>;
export type ListAgentsResponse = z.infer<typeof listAgentsResponseSchema>;
export type CountAgentsResponse = z.infer<typeof countAgentsResponseSchema>;
export type PolicyPins = z.infer<typeof policyPinsSchema>;
export type ToolPolicy = z.infer<typeof toolPolicySchema>;
export type CardToolPolicy = z.infer<typeof cardToolPolicySchema>;
export type CreateAgentReleaseRequest = z.infer<
  typeof createAgentReleaseRequestSchema
>;
export type CreateAgentReleaseResponse = z.infer<
  typeof createAgentReleaseResponseSchema
>;
export type ActivateAgentRequest = z.infer<typeof activateAgentRequestSchema>;
export type ActivateAgentResponse = z.infer<typeof activateAgentResponseSchema>;
export type RuntimeProfileSummary = z.infer<typeof runtimeProfileSummarySchema>;
