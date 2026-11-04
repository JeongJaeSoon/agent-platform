import {
  type AgentCard,
  acceptInviteRequestSchema,
  agentCardRequestSchema,
  agentCardSchema,
  agentDescriptionSchema,
  createAgentReleaseRequestSchema,
  createAgentRequestSchema,
  createInviteRequestSchema,
  createWorkspaceProfileRequestSchema,
  MCP_TOOL_PREFIX,
} from "@werft-ai/contracts";
// biome-ignore lint/style/noRestrictedImports: the forms entry, like the schemas entry, may name zod; the root entry still may not.
import { z } from "zod";

/*
 * Step schemas for the console's forms. Each field is the contract's own
 * schema behind a trim, so a step accepts exactly what the server would and
 * whitespace alone counts as empty. A step's input is what the form holds;
 * its output is what goes into the request.
 */

const trimmed = <T extends z.ZodType<unknown, string>>(field: T) =>
  z.string().trim().pipe(field);

/** Empty for none: the description is optional. */
export const agentIdentityStep = z.object({
  slug: trimmed(createAgentRequestSchema.shape.slug),
  name: trimmed(createAgentRequestSchema.shape.name),
  description: trimmed(agentDescriptionSchema),
});

/** The release step of making an agent: the version comes from the saved draft. */
export const agentReleaseStep = z.object({
  runtime_profile_id: trimmed(
    createAgentReleaseRequestSchema.shape.runtime_profile_id,
  ),
  /** Empty for none, which only a profile that may go without one takes. */
  repository_id: z.string().trim(),
});

export const workspaceProfileNameStep = trimmed(
  createWorkspaceProfileRequestSchema.shape.name,
);
export const workspaceProfileStep = createWorkspaceProfileRequestSchema;

export {
  addedTools,
  canonicalTool,
  carriedDeny,
  firstVersionDeny,
  GITHUB_APP_PERMISSION_GUIDANCE,
  githubAppWarnings,
  MCP_TOOL_PREFIX,
  WORKSPACE_PROFILE_POLICY,
  workspaceProfileId,
} from "@werft-ai/contracts";

export const inviteStep = z.object({
  email: trimmed(createInviteRequestSchema.shape.email),
  role: createInviteRequestSchema.shape.role,
});

/**
 * Redeeming an invite. The password is taken as typed, spaces included; a
 * name left empty is left out, as an existing account needs none.
 */
export const acceptInviteStep = z.object({
  password: acceptInviteRequestSchema.shape.password,
  display_name: z
    .string()
    .trim()
    .transform((name) => name || undefined)
    .pipe(acceptInviteRequestSchema.shape.display_name),
});

/** The card as its form holds it. */
const agentCardDraftSchema = z.object({
  /** Absent from a form without the field (the new-agent flow). */
  agentInstructions: z.string().optional(),
  language: agentCardSchema.shape.language.unwrap(),
  model: z.string(),
  /** `all` = whatever the runtime profile allows (`tools: null`). */
  toolsMode: z.enum(["all", "list"]),
  /** The checked tools; read only in `list` mode. */
  tools: z.array(z.string()),
  /** Only ever shrinks in the form: it shows the list and can clear it. */
  forbidden: z.array(z.string()),
});
export type AgentCardDraft = z.input<typeof agentCardDraftSchema>;

/**
 * The capabilities a draft sends, over those of the card it edits. A
 * built-in tool that will not run (unchecked, or forbidden) loses its
 * `per_tool` entry: a release refuses a policy for a built-in tool it does
 * not run, and the form has no way to edit one. MCP entries attach apart
 * from this list and stay.
 */
export function draftCapabilities(
  draft: Pick<AgentCardDraft, "toolsMode" | "tools" | "forbidden">,
  base?: AgentCard["capabilities"],
): AgentCard["capabilities"] {
  const tools = draft.toolsMode === "all" ? null : [...new Set(draft.tools)];
  const policy = base?.tool_policy;
  const perTool = policy?.per_tool;
  const runs = (tool: string) =>
    (tools === null || tools.includes(tool)) && !draft.forbidden.includes(tool);
  const kept =
    perTool === undefined
      ? perTool
      : Object.fromEntries(
          Object.entries(perTool).filter(
            ([tool]) => tool.startsWith(MCP_TOOL_PREFIX) || runs(tool),
          ),
        );
  return {
    ...base,
    tools,
    mcp: base?.mcp ?? null,
    forbidden: [...draft.forbidden],
    ...(policy === undefined
      ? {}
      : {
          tool_policy: {
            ...policy,
            ...(kept === undefined ? {} : { per_tool: kept }),
          },
        }),
  };
}

/**
 * `card` with the agent instructions a form holds, kept as typed. Blank
 * leaves the field out, as the claim does; a form without the field
 * (`undefined`) keeps what `card` has.
 */
export function withAgentInstructions<T extends object>(
  card: T,
  text: string | undefined,
): T & { agent_instructions?: string } {
  if (text === undefined) return card;
  const { agent_instructions: _replaced, ...rest } = card as T & {
    agent_instructions?: string;
  };
  return (
    text.trim() === "" ? rest : { ...rest, agent_instructions: text }
  ) as T;
}

/**
 * The card step. An edit passes the card it started from: the result keeps
 * every field the form has no input for (rules, tool_policy,
 * credential_refs, the MCP server, a card's earlier role and instructions,
 * anything added later) instead of the contract's defaults.
 */
export function agentCardStep(base?: AgentCard) {
  return agentCardDraftSchema
    .transform(
      (draft): z.input<typeof agentCardRequestSchema> =>
        withAgentInstructions(
          {
            ...base,
            language: draft.language,
            model: draft.model.trim(),
            capabilities: draftCapabilities(draft, base?.capabilities),
          },
          draft.agentInstructions,
        ),
    )
    .pipe(agentCardRequestSchema);
}
