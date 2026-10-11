import { z } from "zod";

import { agentSchema } from "../kollegium/agents.ts";
import {
  agentIdSchema,
  receiptIdSchema,
  timestampSchema,
  userIdSchema,
  workspaceIdSchema,
} from "../shared/index.ts";

// Teams (design 4.7): a group of people in a workspace. Naming a team an
// agent's admin makes every member of it one. Only an owner or an admin
// changes a team (`team.manage`, D23), and a person added joins at once.

export const TEAM_LIST_LIMIT = 200;

export const teamIdSchema = z.uuid();
export const teamNameSchema = z.string().trim().min(1).max(100);

export const teamIdParamsSchema = z.object({ team_id: teamIdSchema }).strict();
export const teamMemberParamsSchema = z
  .object({ team_id: teamIdSchema, user_id: userIdSchema })
  .strict();

export const teamViewSchema = z
  .object({
    id: teamIdSchema,
    workspace_id: workspaceIdSchema,
    name: teamNameSchema,
    member_count: z.number().int().nonnegative(),
    created_by: userIdSchema.nullable(),
    created_at: timestampSchema,
    revision: z.number().int().positive(),
  })
  .strict();

export const teamMemberViewSchema = z
  .object({
    user_id: userIdSchema,
    email: z.string(),
    display_name: z.string().nullable(),
    added_by: userIdSchema.nullable(),
    added_at: timestampSchema,
  })
  .strict();

export const teamDetailSchema = teamViewSchema
  .extend({ members: z.array(teamMemberViewSchema) })
  .strict();

export const createTeamRequestSchema = z
  .object({ name: teamNameSchema })
  .strict();
export const updateTeamRequestSchema = createTeamRequestSchema;

export const teamChangeResponseSchema = z
  .object({
    team: teamViewSchema,
    /** Null when the team already was what was asked: nothing was written. */
    receipt_id: receiptIdSchema.nullable(),
  })
  .strict();

export const deleteTeamResponseSchema = z
  .object({ receipt_id: receiptIdSchema })
  .strict();

export const listTeamsResponseSchema = z
  .object({ items: z.array(teamViewSchema).max(TEAM_LIST_LIMIT) })
  .strict();

// ---------------------------------------------------------------------------
// Agent admins (design 4.1): people and teams
// ---------------------------------------------------------------------------

export const AGENT_ADMIN_KIND_VALUES = ["users", "teams"] as const;
export const agentAdminKindSchema = z.enum(AGENT_ADMIN_KIND_VALUES);

export const agentAdminParamsSchema = z
  .object({
    id: agentIdSchema,
    kind: agentAdminKindSchema,
    subject_id: z.uuid(),
  })
  .strict();

export const agentAdminsViewSchema = z
  .object({
    users: z.array(
      z
        .object({
          user_id: userIdSchema,
          email: z.string(),
          display_name: z.string().nullable(),
          created_by: userIdSchema.nullable(),
          created_at: timestampSchema,
        })
        .strict(),
    ),
    teams: z.array(
      z
        .object({
          team_id: teamIdSchema,
          name: teamNameSchema,
          created_by: userIdSchema.nullable(),
          created_at: timestampSchema,
        })
        .strict(),
    ),
  })
  .strict();

export const agentAdminChangeResponseSchema = z
  .object({
    admins: agentAdminsViewSchema,
    /** Null when the agent's admins already were what was asked. */
    receipt_id: receiptIdSchema.nullable(),
  })
  .strict();

/** The agents the caller administers now, directly or through a team. */
export const listAdministeredAgentsResponseSchema = z
  .object({ items: z.array(agentSchema).max(TEAM_LIST_LIMIT) })
  .strict();

export type TeamView = z.infer<typeof teamViewSchema>;
export type TeamMemberView = z.infer<typeof teamMemberViewSchema>;
export type TeamDetail = z.infer<typeof teamDetailSchema>;
export type CreateTeamRequest = z.infer<typeof createTeamRequestSchema>;
export type UpdateTeamRequest = z.infer<typeof updateTeamRequestSchema>;
export type TeamChangeResponse = z.infer<typeof teamChangeResponseSchema>;
export type DeleteTeamResponse = z.infer<typeof deleteTeamResponseSchema>;
export type ListTeamsResponse = z.infer<typeof listTeamsResponseSchema>;
export type AgentAdminKind = z.infer<typeof agentAdminKindSchema>;
export type AgentAdminsView = z.infer<typeof agentAdminsViewSchema>;
export type AgentAdminChangeResponse = z.infer<
  typeof agentAdminChangeResponseSchema
>;
export type ListAdministeredAgentsResponse = z.infer<
  typeof listAdministeredAgentsResponseSchema
>;
