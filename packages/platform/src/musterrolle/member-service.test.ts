import { describe, expect, test } from "bun:test";
import { createMemberService } from "./member-service.ts";
import { callerFor, createAuthorizationPolicy } from "./policy.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const OWNER = "019a0000-0000-7000-8000-0000000000a1";

describe("offboardMember", () => {
  test("an owner cannot offboard themselves, so a workspace never locks out its last owner", async () => {
    let reached = false;
    const service = createMemberService({
      authorization: createAuthorizationPolicy(),
      store: {
        offboard: async () => {
          reached = true;
          return { outcome: "not_found" };
        },
        listAwaitingTakeover: async () => [],
        takeOver: async () => ({ outcome: "not_found" }),
      },
    });
    const caller = callerFor(
      {
        kind: "user",
        id: OWNER,
        workspace_id: WORKSPACE,
        role: "owner",
        scopes: ["sessions:read"],
      },
      { kind: "api" },
      crypto.randomUUID(),
    );
    await expect(
      service.offboardMember(caller, OWNER.toUpperCase()),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(reached).toBe(false);
  });
});
