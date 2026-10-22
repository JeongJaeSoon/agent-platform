import { z } from "zod";

import {
  agentIdSchema,
  receiptIdSchema,
  timestampSchema,
  userIdSchema,
  workspaceIdSchema,
} from "../shared/index.ts";
import { sessionScopeSchema } from "./authorization.ts";

// API keys issued from the web or the API (design 4.2). A personal key acts
// as the person who made it; a service key belongs to the workspace and, when
// it names an agent, reaches that agent's sessions only.

export const API_KEY_KIND_VALUES = ["personal", "service"] as const;
export const apiKeyKindSchema = z.enum(API_KEY_KIND_VALUES);

export const API_KEY_LIST_LIMIT = 200;

export const apiKeyIdSchema = z.uuid();
export const apiKeyIdParamsSchema = z.object({ id: apiKeyIdSchema }).strict();

export const apiKeyViewSchema = z
  .object({
    id: apiKeyIdSchema,
    kind: apiKeyKindSchema,
    workspace_id: workspaceIdSchema,
    agent_id: agentIdSchema.nullable(),
    /** Null on a key issued before keys recorded who issued them. */
    created_by: userIdSchema.nullable(),
    scopes: z.array(sessionScopeSchema),
    created_at: timestampSchema,
    expires_at: timestampSchema.nullable(),
    revoked_at: timestampSchema.nullable(),
  })
  .strict();

export const createApiKeyRequestSchema = z
  .object({
    kind: apiKeyKindSchema,
    // Never more than the issuer holds now; an agent's key never approves.
    scopes: z.array(sessionScopeSchema).min(1),
    agent_id: agentIdSchema.optional(),
    expires_at: timestampSchema.optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.kind === "personal" && request.agent_id !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["agent_id"],
        message: "a personal key acts as its creator, never as an agent",
      });
    }
  });

/** The only place a key's secret ever appears: once, to whoever issued it. */
export const createApiKeyResponseSchema = z
  .object({
    key: apiKeyViewSchema,
    secret: z.string().min(32).max(256),
    receipt_id: receiptIdSchema,
  })
  .strict();

/**
 * The caller's own personal keys, plus the service keys they may revoke:
 * every one for an owner or admin, their agents' for an agent's admin.
 * Newest first.
 */
export const listApiKeysResponseSchema = z
  .object({ items: z.array(apiKeyViewSchema).max(API_KEY_LIST_LIMIT) })
  .strict();

export const revokeApiKeyResponseSchema = z
  .object({
    key: apiKeyViewSchema,
    /** Null when the key was already revoked and nothing was written. */
    receipt_id: receiptIdSchema.nullable(),
  })
  .strict();

export type ApiKeyKind = z.infer<typeof apiKeyKindSchema>;
export type ApiKeyView = z.infer<typeof apiKeyViewSchema>;
export type CreateApiKeyRequest = z.infer<typeof createApiKeyRequestSchema>;
export type CreateApiKeyResponse = z.infer<typeof createApiKeyResponseSchema>;
export type ListApiKeysResponse = z.infer<typeof listApiKeysResponseSchema>;
export type RevokeApiKeyResponse = z.infer<typeof revokeApiKeyResponseSchema>;
