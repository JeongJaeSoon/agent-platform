import { z } from "zod";

export const SESSION_STATUS_VALUES = [
  "queued",
  "running",
  "needs_input",
  "idle",
  "failed",
  "stopped",
] as const;

export const sessionStatusSchema = z.enum(SESSION_STATUS_VALUES);
export const turnStatusSchema = z.enum([
  "queued",
  "running",
  "done",
  "failed",
  "interrupted",
]);
export const permissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "dontAsk",
  "plan",
]);
export const sessionIdParamsSchema = z.object({ id: z.string().uuid() });
export const idempotencyKeyHeadersSchema = z.object({
  "idempotency-key": z.string().min(1).max(255).optional(),
});

export const sessionSchema = z.object({
  session_id: z.string().uuid(),
  claude_session_id: z.string().min(1).nullable(),
  owner_id: z.string().min(1),
  repo_url: z.string().url(),
  branch: z.string().min(1),
  status: sessionStatusSchema,
  pod_id: z.string().min(1).nullable(),
  pinned: z.boolean(),
  last_turn_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export const turnSchema = z.object({
  turn_id: z.number().int().positive(),
  session_id: z.string().uuid(),
  message: z.string(),
  status: turnStatusSchema,
  started_at: z.string().datetime().nullable(),
  ended_at: z.string().datetime().nullable(),
  result: z.unknown().nullable(),
});
export const pullRequestSchema = z.object({ url: z.string().url() });

export const createSessionRequestSchema = z.object({
  repo_url: z.string().url(),
  base_branch: z.string().min(1),
  message: z.string().min(1),
  model: z.string().min(1).optional(),
  permission_mode: permissionModeSchema.optional(),
});
export const createSessionResponseSchema = z.object({
  session_id: z.string().uuid(),
});
export const listSessionsQuerySchema = z.object({
  owner_id: z.string().min(1).optional(),
  status: sessionStatusSchema.optional(),
});
export const listSessionsResponseSchema = z.array(sessionSchema);
export const getSessionResponseSchema = z.object({
  session: sessionSchema,
  current_turn: turnSchema.nullable(),
  pull_requests: z.array(pullRequestSchema),
});

export const sessionMessageSchema = z.object({ message: z.string().min(1) });
export const postSessionMessageRequestSchema = sessionMessageSchema;
export const postSessionMessageResponseSchema = z.object({
  turn_id: z.number().int().positive(),
});
export const pinSessionRequestSchema = z.object({ pinned: z.boolean() });
export const noContentResponseSchema = z.undefined();
export const healthResponseSchema = z.object({ status: z.literal("ok") });
export const readyResponseSchema = z.object({ status: z.literal("ready") });

export const unassignedSessionSignalSchema = z.undefined();

export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type TurnStatus = z.infer<typeof turnStatusSchema>;
export type PermissionMode = z.infer<typeof permissionModeSchema>;
export type SessionIdParams = z.infer<typeof sessionIdParamsSchema>;
export type IdempotencyKeyHeaders = z.infer<typeof idempotencyKeyHeadersSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type Turn = z.infer<typeof turnSchema>;
export type PullRequest = z.infer<typeof pullRequestSchema>;
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;
export type ListSessionsQuery = z.infer<typeof listSessionsQuerySchema>;
export type ListSessionsResponse = z.infer<typeof listSessionsResponseSchema>;
export type GetSessionResponse = z.infer<typeof getSessionResponseSchema>;
export type SessionMessage = z.infer<typeof sessionMessageSchema>;
export type PostSessionMessageRequest = z.infer<
  typeof postSessionMessageRequestSchema
>;
export type PostSessionMessageResponse = z.infer<
  typeof postSessionMessageResponseSchema
>;
export type PinSessionRequest = z.infer<typeof pinSessionRequestSchema>;
export type NoContentResponse = z.infer<typeof noContentResponseSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type ReadyResponse = z.infer<typeof readyResponseSchema>;
export type UnassignedSessionSignal = z.infer<
  typeof unassignedSessionSignalSchema
>;
