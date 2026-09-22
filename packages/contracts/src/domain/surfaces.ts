import { z } from "zod";

import {
  agentIdSchema,
  agentReleaseIdSchema,
  installationIdSchema,
  opaqueIdSchema,
  revisionSchema,
  sessionIdSchema,
  sessionLinkIdSchema,
  surfaceBindingIdSchema,
  timestampSchema,
  userIdSchema,
  workspaceIdSchema,
} from "../shared/index.ts";

/** Where a conversation happens (03 §5). `api` is a direct client. */
export const SURFACE_KIND_VALUES = ["web", "slack", "api"] as const;
export const surfaceKindSchema = z.enum(SURFACE_KIND_VALUES);

/** The kind of place inside a chat surface; drives memory visibility. */
export const SURFACE_CHANNEL_KIND_VALUES = [
  "public_channel",
  "private_channel",
  "dm",
] as const;
export const surfaceChannelKindSchema = z.enum(SURFACE_CHANNEL_KIND_VALUES);

/** Admission, not output: `off` stops accepting input, mute only silences. */
export const BINDING_MODE_VALUES = ["off", "mention", "ambient"] as const;
export const bindingModeSchema = z.enum(BINDING_MODE_VALUES);

export const MEMORY_WRITE_POLICY_VALUES = ["deny", "allow_explicit"] as const;
export const memoryWritePolicySchema = z.enum(MEMORY_WRITE_POLICY_VALUES);

export const SURFACE_BINDING_STATUS_VALUES = [
  "ready",
  "partial",
  "failed",
  "revoked",
] as const;
export const surfaceBindingStatusSchema = z.enum(SURFACE_BINDING_STATUS_VALUES);

/** A place where one agent works: (installation, external surface) → agent. */
export const surfaceBindingSchema = z
  .object({
    id: surfaceBindingIdSchema,
    workspace_id: workspaceIdSchema,
    /** The server-issued service owner, never the chat team id (03b §5). */
    owner_id: opaqueIdSchema,
    surface: surfaceKindSchema,
    installation_id: installationIdSchema.nullable(),
    /** Channel id as the surface spells it; opaque here. */
    external_surface_id: opaqueIdSchema.nullable(),
    surface_kind: surfaceChannelKindSchema.nullable(),
    agent_id: agentIdSchema,
    mode: bindingModeSchema,
    memory_write_policy: memoryWritePolicySchema,
    status: surfaceBindingStatusSchema,
    muted: z.boolean(),
    revision: revisionSchema,
    created_at: timestampSchema,
    revoked_at: timestampSchema.nullable(),
  })
  .strict()
  .superRefine((binding, ctx) => {
    // The three columns are nullable because `partial` and `failed` are real
    // states: an install can land before the channel is chosen. `ready` is the
    // claim that routing works, so it cannot be missing what routing needs.
    if (binding.surface !== "slack" || binding.status !== "ready") return;
    for (const field of [
      "installation_id",
      "external_surface_id",
      "surface_kind",
    ] as const) {
      if (binding[field] === null) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `a ready slack binding needs ${field}`,
        });
      }
    }
  });

export const SESSION_LINK_ROLE_VALUES = ["primary", "mirror"] as const;
export const sessionLinkRoleSchema = z.enum(SESSION_LINK_ROLE_VALUES);

/** How much history a newly linked surface may see; the owner chooses (A04). */
export const SESSION_LINK_VISIBILITY_VALUES = ["full", "summary"] as const;
export const sessionLinkVisibilitySchema = z.enum(
  SESSION_LINK_VISIBILITY_VALUES,
);

/**
 * `(installation_id, surface_ref)` is the natural key and stays reserved after
 * revocation: a new message on a revoked thread needs an explicit rebind, it
 * does not quietly open a new session (Codex E08).
 */
export const surfaceRefSchema = z.string().min(1).max(256);

/**
 * Both components are opaque strings a surface mints, and a surface is free to
 * put a colon in one: plain concatenation makes `("a:b", "c")` and
 * `("a", "b:c")` the same ref, which is two conversations sharing one reserved
 * link key and messages resolving to the wrong session. Percent-encode each
 * component so the separator only ever appears where this function put it.
 */
export function formatSurfaceRef(channelId: string, threadId: string): string {
  if (channelId.length === 0 || threadId.length === 0) {
    throw new TypeError("surface ref: empty component");
  }
  return surfaceRefSchema.parse(
    `${encodeURIComponent(channelId)}:${encodeURIComponent(threadId)}`,
  );
}

export const sessionLinkSchema = z
  .object({
    id: sessionLinkIdSchema,
    workspace_id: workspaceIdSchema,
    owner_id: opaqueIdSchema,
    session_id: sessionIdSchema,
    surface: surfaceKindSchema,
    installation_id: installationIdSchema,
    surface_binding_id: surfaceBindingIdSchema,
    surface_ref: surfaceRefSchema,
    channel_id: opaqueIdSchema.nullable(),
    thread_id: opaqueIdSchema.nullable(),
    agent_id: agentIdSchema,
    release_id: agentReleaseIdSchema.nullable(),
    profile_id: z.string().min(1).max(128).nullable(),
    role: sessionLinkRoleSchema,
    visibility: sessionLinkVisibilitySchema,
    muted: z.boolean(),
    revision: revisionSchema,
    created_by: userIdSchema.nullable(),
    created_at: timestampSchema,
    revoked_at: timestampSchema.nullable(),
  })
  .strict()
  .superRefine((link, ctx) => {
    // `ScopedSessionBinding` — what every inbound message resolves to — needs
    // both pins. A live link missing either one would be admitted here and
    // then fail every bind, so it is not a state worth storing. Only a revoked
    // link may have lost them.
    if (link.revoked_at !== null) return;
    for (const field of ["release_id", "profile_id"] as const) {
      if (link[field] === null) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `a live session link needs ${field}`,
        });
      }
    }
  });

export type SurfaceKind = z.infer<typeof surfaceKindSchema>;
export type SurfaceChannelKind = z.infer<typeof surfaceChannelKindSchema>;
export type BindingMode = z.infer<typeof bindingModeSchema>;
export type MemoryWritePolicy = z.infer<typeof memoryWritePolicySchema>;
export type SurfaceBindingStatus = z.infer<typeof surfaceBindingStatusSchema>;
export type SurfaceBinding = z.infer<typeof surfaceBindingSchema>;
export type SessionLinkRole = z.infer<typeof sessionLinkRoleSchema>;
export type SessionLinkVisibility = z.infer<typeof sessionLinkVisibilitySchema>;
export type SessionLink = z.infer<typeof sessionLinkSchema>;
