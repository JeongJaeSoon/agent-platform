import { describe, expect, test } from "bun:test";

import { MEMORY_VISIBILITY_VALUES, memoryRecordSchema } from "./memory.ts";
import {
  formatSurfaceRef,
  sessionLinkSchema,
  surfaceBindingSchema,
} from "./surfaces.ts";

const AGENT_ID = "019a0000-0000-7000-8000-0000000000e1";
const WORKSPACE_ID = "019a0000-0000-7000-8000-0000000000e2";
const MEMORY_ID = "019a0000-0000-7000-8000-0000000000e3";
const BINDING_ID = "019a0000-0000-7000-8000-0000000000e4";
const SESSION_ID = "019a0000-0000-7000-8000-0000000000e5";
const AT = "2026-09-22T01:00:00Z";

const record = {
  id: MEMORY_ID,
  workspace_id: WORKSPACE_ID,
  agent_id: AGENT_ID,
  type: "semantic",
  visibility: "agent",
  visibility_ref: null,
  content: "분기 마감은 매 분기 마지막 영업일이다.",
  source_session_id: SESSION_ID,
  source_binding_id: BINDING_ID,
  source_message_ref: null,
  sensitivity: "normal",
  confidence: 0.9,
  valid_until: null,
  status: "active",
  revision: 0,
  created_by: "user:someone",
  created_at: AT,
} satisfies Record<string, unknown>;

describe("MemoryRecord", () => {
  test("keeps the agent as the widest scope an agent can write", () => {
    expect(MEMORY_VISIBILITY_VALUES).toContain("agent");
    expect(MEMORY_VISIBILITY_VALUES as readonly string[]).not.toContain(
      "kollege",
    );
    expect(MEMORY_VISIBILITY_VALUES as readonly string[]).not.toContain(
      "organization",
    );
    expect(memoryRecordSchema.safeParse(record).success).toBe(true);
  });

  test("a scoped visibility must name what it is scoped to", () => {
    for (const visibility of ["session", "channel", "user"] as const) {
      expect(
        memoryRecordSchema.safeParse({
          ...record,
          visibility,
          visibility_ref: null,
        }).success,
      ).toBe(false);
      expect(
        memoryRecordSchema.safeParse({
          ...record,
          visibility,
          visibility_ref: BINDING_ID,
        }).success,
      ).toBe(true);
    }
  });

  test("each visibility decides what its ref is, not just that it has one", () => {
    // Without a per-variant id schema a surface binding id would stand in for
    // a session and still parse, quietly widening who can read the row.
    expect(
      memoryRecordSchema.safeParse({
        ...record,
        visibility: "session",
        visibility_ref: "C01",
      }).success,
    ).toBe(false);
    expect(
      memoryRecordSchema.safeParse({
        ...record,
        visibility: "channel",
        visibility_ref: "C01",
      }).success,
    ).toBe(false);
    // A scoped actor id is minted by the surface, so it is not a uuid.
    expect(
      memoryRecordSchema.safeParse({
        ...record,
        visibility: "user",
        visibility_ref: "slack:T01:U02",
      }).success,
    ).toBe(true);
  });

  test("an unscoped visibility must not carry a ref", () => {
    for (const visibility of ["agent", "workspace"] as const) {
      expect(
        memoryRecordSchema.safeParse({
          ...record,
          visibility,
          visibility_ref: BINDING_ID,
        }).success,
      ).toBe(false);
    }
  });

  test("a record is superseded, never rewritten in place", () => {
    const parsed = memoryRecordSchema.parse({
      ...record,
      status: "superseded",
      revision: 3,
    });
    expect(parsed.status).toBe("superseded");
    expect(
      memoryRecordSchema.safeParse({ ...record, status: "purged" }).success,
    ).toBe(false);
  });

  test("rejects an empty or oversized body and a confidence outside 0..1", () => {
    expect(
      memoryRecordSchema.safeParse({ ...record, content: "" }).success,
    ).toBe(false);
    expect(
      memoryRecordSchema.safeParse({ ...record, content: "a".repeat(10_001) })
        .success,
    ).toBe(false);
    expect(
      memoryRecordSchema.safeParse({ ...record, confidence: 1.1 }).success,
    ).toBe(false);
  });

  test("a binding decides whether an agent may write at all", () => {
    const binding = {
      id: BINDING_ID,
      workspace_id: WORKSPACE_ID,
      owner_id: "owner_1",
      surface: "slack",
      installation_id: SESSION_ID,
      external_surface_id: "C01",
      surface_kind: "private_channel",
      agent_id: AGENT_ID,
      mode: "mention",
      memory_write_policy: "deny",
      status: "ready",
      muted: false,
      revision: 0,
      created_at: AT,
      revoked_at: null,
    };
    expect(surfaceBindingSchema.parse(binding).memory_write_policy).toBe(
      "deny",
    );
    expect(
      surfaceBindingSchema.safeParse({
        ...binding,
        memory_write_policy: "allow_all",
      }).success,
    ).toBe(false);
  });

  test("a ready slack binding cannot be missing what routing needs", () => {
    const binding = {
      id: BINDING_ID,
      workspace_id: WORKSPACE_ID,
      owner_id: "owner_1",
      surface: "slack",
      installation_id: SESSION_ID,
      external_surface_id: "C01",
      surface_kind: "private_channel",
      agent_id: AGENT_ID,
      mode: "mention",
      memory_write_policy: "deny",
      status: "ready",
      muted: false,
      revision: 0,
      created_at: AT,
      revoked_at: null,
    };
    for (const field of [
      "installation_id",
      "external_surface_id",
      "surface_kind",
    ] as const) {
      expect(
        surfaceBindingSchema.safeParse({ ...binding, [field]: null }).success,
      ).toBe(false);
      // `partial` is exactly the state where the column is still empty.
      expect(
        surfaceBindingSchema.safeParse({
          ...binding,
          status: "partial",
          [field]: null,
        }).success,
      ).toBe(true);
    }
  });

  test("a revoked binding cannot also report itself ready", () => {
    // One consumer reads `status`, another reads `revoked_at`; if they can
    // disagree, one of them keeps routing into a revoked binding.
    const binding = {
      id: BINDING_ID,
      workspace_id: WORKSPACE_ID,
      owner_id: "owner_1",
      surface: "slack",
      installation_id: SESSION_ID,
      external_surface_id: "C01",
      surface_kind: "private_channel",
      agent_id: AGENT_ID,
      mode: "mention",
      memory_write_policy: "deny",
      status: "ready",
      muted: false,
      revision: 0,
      created_at: AT,
      revoked_at: null,
    };
    expect(
      surfaceBindingSchema.safeParse({ ...binding, revoked_at: AT }).success,
    ).toBe(false);
    expect(
      surfaceBindingSchema.safeParse({ ...binding, status: "revoked" }).success,
    ).toBe(false);
    expect(
      surfaceBindingSchema.safeParse({
        ...binding,
        status: "revoked",
        revoked_at: AT,
      }).success,
    ).toBe(true);
  });

  test("a surface ref cannot be spelled two ways", () => {
    // Channel and thread ids are opaque, and a surface may put a colon in
    // either; concatenating raw would make these two the same reserved key.
    expect(formatSurfaceRef("a:b", "c")).not.toBe(formatSurfaceRef("a", "b:c"));
    expect(formatSurfaceRef("C01", "1700000000.000100")).toBe(
      "C01:1700000000.000100",
    );
    expect(() => formatSurfaceRef("", "c")).toThrow(TypeError);
  });

  test("a live session link carries both pins or it cannot be bound", () => {
    const link = {
      id: "019a0000-0000-7000-8000-0000000000e6",
      workspace_id: WORKSPACE_ID,
      owner_id: "owner_1",
      session_id: SESSION_ID,
      surface: "slack",
      installation_id: "019a0000-0000-7000-8000-0000000000e7",
      surface_binding_id: BINDING_ID,
      surface_ref: formatSurfaceRef("C01", "1700000000.000100"),
      channel_id: "C01",
      thread_id: "1700000000.000100",
      agent_id: AGENT_ID,
      release_id: "rel_9f2c",
      profile_id: "claude-coding-v1",
      role: "primary",
      visibility: "full",
      muted: false,
      revision: 0,
      created_by: null,
      created_at: AT,
      revoked_at: null,
    };
    expect(sessionLinkSchema.safeParse(link).success).toBe(true);
    // `(installation_id, surface_ref)` is a reserved natural key, so one
    // conversation gets one spelling — a hand-concatenated ref would reserve
    // a second key for the same thread and open a second session on it.
    expect(
      sessionLinkSchema.safeParse({
        ...link,
        surface_ref: `${link.channel_id}:${link.thread_id}x`,
      }).success,
    ).toBe(false);
    // Half an identity would skip canonicalisation and let any spelling
    // through — exactly the second key this is meant to prevent.
    expect(
      sessionLinkSchema.safeParse({ ...link, thread_id: null }).success,
    ).toBe(false);
    // Components the id schemas accept must have a representable ref, and
    // asking for one must not throw out of safeParse. Hangul is the worst
    // case: one code unit becomes nine percent-encoded characters, so a pair
    // of maximum-length ids is an order of magnitude longer than the ids.
    const long = "채".repeat(128);
    expect(() =>
      sessionLinkSchema.safeParse({
        ...link,
        channel_id: long,
        thread_id: long,
        surface_ref: formatSurfaceRef(long, long),
      }),
    ).not.toThrow();
    expect(
      sessionLinkSchema.safeParse({
        ...link,
        channel_id: long,
        thread_id: long,
        surface_ref: formatSurfaceRef(long, long),
      }).success,
    ).toBe(true);
    for (const field of ["release_id", "profile_id"] as const) {
      expect(
        sessionLinkSchema.safeParse({ ...link, [field]: null }).success,
      ).toBe(false);
      // A revoked link may have lost its pins; nothing binds through it.
      expect(
        sessionLinkSchema.safeParse({
          ...link,
          [field]: null,
          revoked_at: AT,
        }).success,
      ).toBe(true);
    }
  });
});
