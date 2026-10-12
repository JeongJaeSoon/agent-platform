import { describe, expect, test } from "bun:test";
import type { Principal } from "@agent-platform/contracts";
import type {
  PushRefusalRecord,
  PushRequestStore,
} from "../ports/push-requests.ts";
import { createPushRequestService } from "./push-request-service.ts";
import { SessionServiceError } from "./session-service.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const PUSH = "22222222-2222-4222-8222-222222222222";

function service() {
  const refusals: PushRefusalRecord[] = [];
  const decided: unknown[] = [];
  const store = {
    recordRefusal: async (input: PushRefusalRecord) => {
      refusals.push(input);
      return "receipt-1";
    },
    decide: async (input: unknown) => {
      decided.push(input);
      throw new Error("not reached");
    },
  } as unknown as PushRequestStore;
  return {
    refusals,
    decided,
    push: createPushRequestService({
      store,
      source: {
        readPushSource: async () => ({ status: "none" }),
      },
    }),
  };
}

describe("push request decisions", () => {
  test("a principal kind outside the allowlist cannot decide, even holding sessions:approve", async () => {
    const { push, refusals, decided } = service();
    const installation: Principal = {
      kind: "installation",
      id: "inst-1",
      owner_id: "owner-a",
      workspace_id: "9d2c4e61-8a3b-4f70-b1e5-6c0a7d3f2b98",
      scopes: ["sessions:approve"],
    };
    let bodyRead = false;
    const error = await push
      .decide(
        { principal: installation, ownerId: "owner-a", verified: true },
        SESSION,
        PUSH,
        {
          idempotencyKey: "k-1",
          readBody: async () => {
            bodyRead = true;
            return { decision: "approve", git_commit: "a".repeat(40) };
          },
        },
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionServiceError);
    expect((error as SessionServiceError).code).toBe("FORBIDDEN");
    expect((error as SessionServiceError).details).toEqual({
      refusal: "unverified_principal",
      receipt_id: "receipt-1",
    });
    expect(refusals).toMatchObject([
      {
        operation: "decide_push",
        refusal: "unverified_principal",
        actor: {
          principal: { kind: "installation", id: "inst-1" },
          actor_user_id: null,
        },
      },
    ]);
    expect(bodyRead).toBe(false);
    expect(decided).toEqual([]);
  });

  test("an uppercase session id reads the checkpoint and records receipts under the stored id", async () => {
    const read: string[] = [];
    const refusals: PushRefusalRecord[] = [];
    const push = createPushRequestService({
      store: {
        findSession: async () => ({ repositoryId: "sample-app" }),
        recordRefusal: async (input: PushRefusalRecord) => {
          refusals.push(input);
          return "receipt-1";
        },
      } as unknown as PushRequestStore,
      source: {
        readPushSource: async (sessionId) => {
          read.push(sessionId);
          return { status: "none" };
        },
      },
    });
    const actor = {
      principal: {
        kind: "api_key",
        id: "key-1",
        owner_id: "owner-a",
        scopes: [],
      } as unknown as Principal,
      ownerId: "owner-a",
      verified: true,
    };
    const session = "aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb";
    const pushId = "cccccccc-2222-4222-8222-dddddddddddd";
    await push
      .create(actor, session.toUpperCase(), { idempotencyKey: "k-1" })
      .catch(() => {});
    await push
      .decide(actor, session.toUpperCase(), pushId.toUpperCase(), {
        idempotencyKey: "k-2",
        readBody: async () => ({
          decision: "reject",
          git_commit: "a".repeat(40),
        }),
      })
      .catch(() => {});
    expect(read).toEqual([session]);
    expect(refusals.map((refusal) => refusal.sessionId)).toEqual([
      session,
      session,
    ]);
    expect(refusals[1]?.result.push_request_id).toBe(pushId);
  });
});
