import {
  type AgentCard,
  acceptInviteRequestSchema,
  agentCardSchema,
  createAgentRequestSchema,
  createInviteRequestSchema,
} from "@agent-platform/contracts";
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

export const agentIdentityStep = z.object({
  slug: trimmed(createAgentRequestSchema.shape.slug),
  name: trimmed(createAgentRequestSchema.shape.name),
});

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

/** The card as its form holds it: lists as one name per line. */
export const agentCardDraftSchema = z.object({
  role: z.string(),
  instructions: z.string(),
  tone: z.string(),
  language: agentCardSchema.shape.language.unwrap(),
  model: z.string(),
  /** `all` = whatever the runtime profile allows (`tools: null`). */
  toolsMode: z.enum(["all", "list"]),
  tools: z.string(),
  forbidden: z.string(),
});
export type AgentCardDraft = z.input<typeof agentCardDraftSchema>;

// One name per line: the contract lets a tool name hold spaces and commas.
const splitList = (text: string) =>
  text
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);

/**
 * The card step. An edit passes the card it started from: the result keeps
 * every field the form has no input for (rules, tool_policy,
 * credential_refs, anything added later) instead of the contract's defaults.
 * A tone left empty is removed, as clearing it in the form means.
 */
export function agentCardStep(base?: AgentCard) {
  return agentCardDraftSchema
    .transform((draft): z.input<typeof agentCardSchema> => {
      const { tone: _cleared, ...kept } = base ?? {};
      const tone = draft.tone.trim();
      return {
        ...kept,
        role: draft.role.trim(),
        instructions: draft.instructions.trim(),
        ...(tone ? { tone } : {}),
        language: draft.language,
        model: draft.model.trim(),
        capabilities: {
          ...base?.capabilities,
          tools: draft.toolsMode === "all" ? null : splitList(draft.tools),
          mcp: null,
          forbidden: splitList(draft.forbidden),
        },
      };
    })
    .pipe(agentCardSchema);
}
