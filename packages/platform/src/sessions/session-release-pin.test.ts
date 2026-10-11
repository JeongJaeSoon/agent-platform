import { describe, expect, test } from "bun:test";
import {
  type AuthorizationRequest,
  scopesForRole,
} from "@agent-platform/contracts";
import { callerFor, createAuthorizationPolicy } from "../musterrolle/policy.ts";
import type { AcceptSessionInput } from "../ports/session-unit-of-work.ts";
import type { SessionCatalog } from "./catalog.ts";
import {
  createSessionService,
  SessionServiceError,
} from "./session-service.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const MEMBER = "019a0000-0000-7000-8000-0000000000a1";
const AGENT = "019a0000-0000-7000-8000-00000000b0a1";

const profile: SessionCatalog["profiles"][string] = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  tools: ["Read"],
  permission_mode: "default",
  provider: {
    kind: "litellm",
    endpoint: "https://litellm.invalid",
    auth: {
      kind: "api_key",
      value: "test",
      ref: { value_env: "PROVIDER_KEY" },
    },
  },
};
const catalog: SessionCatalog = {
  profiles: { "coding-v1": profile, "review-v1": profile },
  repositories: {
    app: {
      url: "https://example.invalid/app.git",
      branch: "main",
      profiles: ["coding-v1", "review-v1"],
    },
  },
};

const unreached = async () => {
  throw new Error("not reached");
};

function setup() {
  const accepted: AcceptSessionInput[] = [];
  const asked: AuthorizationRequest[] = [];
  const policy = createAuthorizationPolicy();
  const service = createSessionService({
    authorization: {
      authorize: (request) => {
        asked.push(request);
        return policy.authorize(request);
      },
    },
    catalog,
    releases: {
      async resolveRelease(_workspaceId, releaseId) {
        if (releaseId !== "rel-1") {
          throw new SessionServiceError("NOT_FOUND", "Resource not found");
        }
        return {
          id: "rel-1",
          agent_id: AGENT,
          runtime_profile_id: "coding-v1",
        };
      },
    },
    inputs: {
      async acceptInputAtomic(input) {
        accepted.push(input);
        return {
          outcome: "accepted",
          response: {
            session_id: "019a0000-0000-7000-8000-00000000e0a1",
            turn_id: "1",
            receipt_id: "019a0000-0000-7000-8000-00000000c0a1",
            receipt_status: "accepted",
            status: "queued",
          },
        };
      },
      appendInputAtomic: unreached,
    },
    controls: {
      terminateAtomic: unreached,
      pauseAtomic: unreached,
      decideRecoveryAtomic: unreached,
      resumeAtomic: unreached,
    },
    reader: {
      listSessions: unreached,
      getSession: unreached,
      listTurns: unreached,
      getTurn: unreached,
      getReceipt: unreached,
      readEvents: unreached,
    },
    limits: {
      queuedInputLimitPerSession: 10,
      storageLimitBytes: 1e15,
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
    },
  });
  const caller = callerFor(
    {
      kind: "user",
      id: MEMBER,
      workspace_id: WORKSPACE,
      role: "member",
      scopes: [...scopesForRole("member")],
    },
    { kind: "web" },
    "r",
  );
  return { service, caller, accepted, asked };
}

const body = { profile_id: "coding-v1", repository_id: "app", message: "hi" };

describe("a session pinned to an agent release", () => {
  test("is authorized as that agent's and stores the pin", async () => {
    const { service, caller, accepted, asked } = setup();
    await service.createSession(caller, {
      idempotencyKey: "k",
      body: { ...body, agent_release_id: "rel-1" },
    });
    expect(asked[0]?.resource).toMatchObject({ id: null, agent_id: AGENT });
    expect(accepted[0]?.agentReleaseId).toBe("rel-1");
  });

  test("must run on the release's profile", async () => {
    const { service, caller, accepted } = setup();
    const error = await service
      .createSession(caller, {
        idempotencyKey: "k",
        body: { ...body, profile_id: "review-v1", agent_release_id: "rel-1" },
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "RELEASE_PROFILE_MISMATCH" });
    expect(accepted).toHaveLength(0);
  });

  test("an unknown release is not found, and no pin stores none", async () => {
    const { service, caller, accepted } = setup();
    expect(
      await service
        .createSession(caller, {
          idempotencyKey: "k",
          body: { ...body, agent_release_id: "rel-2" },
        })
        .catch((e: unknown) => e),
    ).toMatchObject({ code: "NOT_FOUND" });
    await service.createSession(caller, { idempotencyKey: "k", body });
    expect(accepted[0]?.agentReleaseId).toBeUndefined();
  });
});
