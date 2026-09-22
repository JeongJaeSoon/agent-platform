import { describe, expect, test } from "bun:test";

import { RECEIPT_OPERATION_VALUES, receiptSchema } from "./receipt.ts";

const RECEIPT_ID = "019a0000-0000-7000-8000-000000000101";
const SESSION_ID = "019a0000-0000-7000-8000-000000000102";
const WORKSPACE_ID = "019a0000-0000-7000-8000-000000000103";
const USER_ID = "019a0000-0000-7000-8000-000000000104";
const AT = "2026-09-22T01:00:00Z";

const base = {
  id: RECEIPT_ID,
  operation: "create_session",
  status: "accepted",
  result: null,
  error: null,
  created_at: AT,
  updated_at: AT,
};

describe("receipt target union", () => {
  test("the alpha session target is unchanged and still required in full", () => {
    expect(
      receiptSchema.safeParse({
        ...base,
        target_ref: { session_id: SESSION_ID, turn_id: "1", request_id: null },
      }).success,
    ).toBe(true);
    // Dropping a field does not silently fall through to the resource variant.
    expect(
      receiptSchema.safeParse({
        ...base,
        target_ref: { session_id: SESSION_ID },
      }).success,
    ).toBe(false);
    expect(receiptSchema.safeParse({ ...base, target_ref: {} }).success).toBe(
      false,
    );
  });

  test("a mutation outside a session names its resource instead", () => {
    const parsed = receiptSchema.parse({
      ...base,
      target_ref: {
        resource: {
          kind: "invite",
          id: "019a0000-0000-7000-8000-000000000105",
        },
        workspace_id: WORKSPACE_ID,
      },
    });
    expect(parsed.target_ref).toEqual({
      resource: { kind: "invite", id: "019a0000-0000-7000-8000-000000000105" },
      workspace_id: WORKSPACE_ID,
    });
    expect(
      receiptSchema.safeParse({
        ...base,
        target_ref: {
          resource: { kind: "kollege", id: "x" },
          workspace_id: null,
        },
      }).success,
    ).toBe(false);
  });

  test("the operation vocabulary stays session-only until a route adds to it", () => {
    expect(RECEIPT_OPERATION_VALUES as readonly string[]).not.toContain(
      "create_invite",
    );
    expect(
      receiptSchema.safeParse({ ...base, operation: "create_invite" }).success,
    ).toBe(false);
  });

  test("actor is optional so alpha rows written before it still parse", () => {
    const withoutActor = receiptSchema.parse({
      ...base,
      target_ref: { session_id: SESSION_ID, turn_id: null, request_id: null },
    });
    expect(Object.hasOwn(withoutActor, "actor")).toBe(false);
    const withActor = receiptSchema.parse({
      ...base,
      target_ref: { session_id: SESSION_ID, turn_id: null, request_id: null },
      actor: {
        principal: { kind: "user", id: USER_ID },
        actor_user_id: USER_ID,
        agent_id: null,
      },
    });
    expect(withActor.actor?.actor_user_id).toBe(USER_ID);
  });
});
