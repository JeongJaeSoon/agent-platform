import { z } from "zod";

import {
  agentIdSchema,
  memoryIdSchema,
  opaqueIdSchema,
  revisionSchema,
  sessionIdSchema,
  surfaceBindingIdSchema,
  timestampSchema,
  workspaceIdSchema,
} from "../shared/index.ts";

export const MEMORY_TYPE_VALUES = ["semantic", "episodic"] as const;
export const memoryTypeSchema = z.enum(MEMORY_TYPE_VALUES);

/**
 * Who may read a record (03 §9, 03b §4.3). Ported from Kollegium's
 * `kollege|channel|user` with `kollege` renamed to `agent`: the widest scope
 * an agent can write is its own working set, and promotion to `workspace`
 * ("Team shared") is a human decision, never automatic.
 */
export const MEMORY_VISIBILITY_VALUES = [
  "session",
  "agent",
  "workspace",
  "channel",
  "user",
] as const;
export const memoryVisibilitySchema = z.enum(MEMORY_VISIBILITY_VALUES);

export const MEMORY_STATUS_VALUES = [
  "candidate",
  "active",
  "superseded",
  "deleted",
] as const;
export const memoryStatusSchema = z.enum(MEMORY_STATUS_VALUES);

export const MEMORY_SENSITIVITY_VALUES = ["normal", "sensitive"] as const;
export const memorySensitivitySchema = z.enum(MEMORY_SENSITIVITY_VALUES);

// `channel` points at a surface binding, never at a raw channel id, and
// `user` at a scoped actor id — so revoking a binding revokes its memory.
const SCOPED_VISIBILITIES = new Set(["session", "channel", "user"]);

export const memoryRecordSchema = z
  .object({
    id: memoryIdSchema,
    workspace_id: workspaceIdSchema,
    agent_id: agentIdSchema,
    type: memoryTypeSchema,
    visibility: memoryVisibilitySchema,
    /** Session id, surface binding id or scoped actor id; null when agent- or workspace-wide. */
    visibility_ref: opaqueIdSchema.nullable(),
    content: z.string().min(1).max(10_000),
    source_session_id: sessionIdSchema.nullable(),
    source_binding_id: surfaceBindingIdSchema.nullable(),
    source_message_ref: z.string().min(1).max(256).nullable(),
    sensitivity: memorySensitivitySchema,
    confidence: z.number().min(0).max(1),
    valid_until: timestampSchema.nullable(),
    status: memoryStatusSchema,
    /** Soft delete plus revision: a record is superseded, never overwritten. */
    revision: revisionSchema,
    created_by: opaqueIdSchema,
    created_at: timestampSchema,
  })
  .strict()
  .superRefine((record, ctx) => {
    const scoped = SCOPED_VISIBILITIES.has(record.visibility);
    if (scoped && record.visibility_ref === null) {
      ctx.addIssue({
        code: "custom",
        path: ["visibility_ref"],
        message: `${record.visibility} visibility requires a visibility_ref`,
      });
    }
    if (!scoped && record.visibility_ref !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["visibility_ref"],
        message: `${record.visibility} visibility must not carry a visibility_ref`,
      });
    }
  });

/** What a reader must present before any row is selected (94S-155 predicate). */
export const memoryVisibilityQuerySchema = z
  .object({
    workspace_id: workspaceIdSchema,
    agent_id: agentIdSchema,
    session_id: sessionIdSchema.nullable(),
    surface_binding_id: surfaceBindingIdSchema.nullable(),
    actor_id: opaqueIdSchema.nullable(),
    at: timestampSchema,
  })
  .strict();

export type MemoryType = z.infer<typeof memoryTypeSchema>;
export type MemoryVisibility = z.infer<typeof memoryVisibilitySchema>;
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;
export type MemorySensitivity = z.infer<typeof memorySensitivitySchema>;
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;
export type MemoryVisibilityQuery = z.infer<typeof memoryVisibilityQuerySchema>;
