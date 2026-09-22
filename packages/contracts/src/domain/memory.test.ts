import { describe, expect, test } from "bun:test";

import { MEMORY_VISIBILITY_VALUES, memoryRecordSchema } from "./memory.ts";
import { surfaceBindingSchema } from "./surfaces.ts";

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
});
