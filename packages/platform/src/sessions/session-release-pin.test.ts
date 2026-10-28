import { describe, expect, test } from "bun:test";
import {
  type AuthorizationRequest,
  scopesForRole,
  sessionCredentialUnboundDetailsSchema,
} from "@werft-ai/contracts";
import { callerFor, createAuthorizationPolicy } from "../musterrolle/policy.ts";
import type { AgentContact } from "../ports/credential-binding-store.ts";
import type { AcceptSessionInput } from "../ports/session-unit-of-work.ts";
import {
  type InstallationProfileEntry,
  type InstallationProfileState,
  profileFingerprint,
  type SessionCatalog,
  type WorkspaceProfileRecord,
  workspaceProfileRefusal,
  workspaceProfileState,
} from "./catalog.ts";
import { withSeededInstallation } from "./profile-registry.ts";
import {
  createSessionService,
  SessionServiceError,
} from "./session-service.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const MEMBER = "019a0000-0000-7000-8000-0000000000a1";
const AGENT = "019a0000-0000-7000-8000-00000000b0a1";
const RECEIPT = "019a0000-0000-7000-8000-00000000c0a1";

const profile: SessionCatalog["profiles"][string] = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  models: ["claude-opus-5-5", "claude-haiku-5-5"],
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
const catalog: SessionCatalog = withSeededInstallation({
  profiles: { "coding-v1": profile, "review-v1": profile },
  repositories: {
    app: {
      url: "https://example.invalid/app.git",
      branch: "main",
      profiles: ["coding-v1", "review-v1"],
    },
  },
});

const unreached = async () => {
  throw new Error("not reached");
};

function setup(
  options: {
    unbound?: string[];
    contacts?: AgentContact[];
    /** What the acceptance finds: an earlier acceptance, or an unbind. */
    accept?: "replayed" | "credential_unbound" | "unsupported";
    catalog?: SessionCatalog;
    releaseProfile?: string;
  } = {},
) {
  const accepted: AcceptSessionInput[] = [];
  const asked: AuthorizationRequest[] = [];
  const policy = createAuthorizationPolicy({
    credentials: { unboundRefs: async () => options.unbound ?? [] },
  });
  const service = createSessionService({
    authorization: {
      authorize: (request) => {
        asked.push(request);
        return policy.authorize(request);
      },
    },
    catalog: options.catalog ?? catalog,
    releases: {
      async resolveRelease(_workspaceId, releaseId) {
        if (releaseId !== "rel-1" && releaseId !== "rel-app") {
          throw new SessionServiceError("NOT_FOUND", "Resource not found");
        }
        return {
          id: releaseId,
          agent_id: AGENT,
          runtime_profile_id: options.releaseProfile ?? "coding-v1",
          repository_id: releaseId === "rel-app" ? "app" : null,
          runtime_config_snapshot: { model: "claude-opus-5-5" },
        };
      },
    },
    inputs: {
      async acceptInputAtomic(input) {
        accepted.push(input);
        if (
          options.accept === "credential_unbound" ||
          (input.credentialsUnbound && options.accept !== "replayed")
        ) {
          return { outcome: "credential_unbound", receiptId: RECEIPT };
        }
        return {
          outcome: options.accept ?? "accepted",
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
      closeAtomic: unreached,
      decideRecoveryAtomic: unreached,
      resumeAtomic: unreached,
      changeProfileAtomic: unreached,
      renameAtomic: unreached,
    },
    credentials: {
      contacts: async (workspaceId, agentId) =>
        workspaceId === WORKSPACE && agentId === AGENT
          ? (options.contacts ?? [])
          : [],
    },
    reader: {
      listSessions: unreached,
      countSessions: unreached,
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
    expect(asked[0]?.resource).toMatchObject({
      id: null,
      agent_id: AGENT,
      release_id: "rel-1",
    });
    expect(accepted[0]?.agentReleaseId).toBe("rel-1");
  });

  test("runs the card's model unless the request names another the profile offers", async () => {
    const { service, caller, accepted } = setup();
    const create = (extra: object) =>
      service.createSession(caller, {
        idempotencyKey: "k",
        body: { ...body, agent_release_id: "rel-1", ...extra },
      });
    await create({});
    expect(accepted[0]?.model).toBe("claude-opus-5-5");
    await create({ model: "claude-haiku-5-5" });
    expect(accepted[1]?.model).toBe("claude-haiku-5-5");
    await service.createSession(caller, { idempotencyKey: "k", body });
    expect(accepted[2]?.model).toBe("claude-sonnet-5");
    await create({ model: "claude-fable-5-1" });
    expect(accepted[3]).toMatchObject({ repository: null });
    expect(accepted[3]?.model).toBeUndefined();
    expect(accepted[3]?.profileFingerprint).toBeUndefined();
  });

  test("with only the release named, runs on its profile and its repository", async () => {
    const { service, caller, accepted } = setup();
    await service.createSession(caller, {
      idempotencyKey: "k",
      body: { agent_release_id: "rel-app", message: "hi" },
    });
    expect(accepted[0]).toMatchObject({
      profileId: "coding-v1",
      agentReleaseId: "rel-app",
      repository: {
        id: "app",
        url: "https://example.invalid/app.git",
        branch: "main",
      },
    });
    // A release without a repository runs nothing on a profile that needs
    // one: the acceptance is asked with no pair, which it refuses.
    await service.createSession(caller, {
      idempotencyKey: "k2",
      body: { agent_release_id: "rel-1", message: "hi" },
    });
    expect(accepted[1]).toMatchObject({
      profileId: "coding-v1",
      repository: null,
    });
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

  test("a workspace version is not taken on what was read before a failed read: another replica may have retired it", async () => {
    const record: WorkspaceProfileRecord = {
      id: "ws_acme_strict_v1",
      workspace_id: WORKSPACE,
      name: "strict",
      version: 1,
      base_profile_id: "coding-v1",
      base_fingerprint: profileFingerprint(profile),
      model: "claude-sonnet-5",
      models: ["claude-sonnet-5"],
      tools: ["Read"],
      permission_mode: "default",
      base_runtime_version: "0.3.270",
      base_billing: "metered",
      base_repository_mode: "required",
      created_by: "019a0000-0000-7000-8000-0000000000b1",
      created_at: new Date("2026-10-27T00:00:00Z"),
      retired_by: null,
      retired_at: null,
    };
    const { service, caller, accepted } = setup({
      catalog: {
        ...catalog,
        workspace_profiles: {
          records: new Map([[record.id, record]]),
          refresh: async () => {
            throw new Error("database down");
          },
        },
      },
    });
    const error = await service
      .createSession(caller, {
        idempotencyKey: "k",
        body: { ...body, profile_id: record.id },
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ message: "database down" });
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

  test("does not start while a credential its release uses is unbound", async () => {
    const admins: AgentContact[] = [
      {
        userId: "019a0000-0000-7000-8000-0000000000a2",
        displayName: "관리자",
        email: "admin+bot@example.invalid",
      },
      {
        userId: "019a0000-0000-7000-8000-0000000000a3",
        displayName: "둘째",
        email: "second@example.invalid",
      },
    ];
    const { service, caller, accepted } = setup({
      unbound: ["slack_bot_token"],
      contacts: admins,
    });
    const error = await service
      .createSession(caller, {
        idempotencyKey: "k",
        body: { ...body, agent_release_id: "rel-1" },
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SessionServiceError);
    expect(error).toMatchObject({
      code: "CREDENTIAL_UNBOUND",
      details: {
        reason_code: "credential_unbound",
        guidance:
          "연결 설정이 바뀌어 시작하지 못했어요. 에이전트 관리자에게 문의하세요",
        agent_id: AGENT,
        admins: [
          {
            user_id: admins[0]?.userId,
            display_name: "관리자",
            email: "admin+bot@example.invalid",
          },
          {
            user_id: admins[1]?.userId,
            display_name: "둘째",
            email: "second@example.invalid",
          },
        ],
        admin_link:
          "mailto:admin%2Bbot%40example.invalid,second%40example.invalid",
      },
    });
    // The requester learns who to ask, never which names are missing.
    expect(JSON.stringify(error)).not.toContain("slack_bot_token");
    expect(
      sessionCredentialUnboundDetailsSchema.parse(
        (error as SessionServiceError).details,
      ),
    ).toBeTruthy();
    // Only the acceptance can tell a replay, so it is asked for nothing else.
    expect(accepted.map((input) => input.credentialsUnbound)).toEqual([true]);
  });

  test("with no one to ask, the link is null", async () => {
    const { service, caller } = setup({ unbound: ["x"] });
    expect(
      await service
        .createSession(caller, {
          idempotencyKey: "k",
          body: { ...body, agent_release_id: "rel-1" },
        })
        .catch((e: unknown) => e),
    ).toMatchObject({
      code: "CREDENTIAL_UNBOUND",
      details: { admins: [], admin_link: null },
    });
  });

  test("a replay of a session accepted before the unbind gets its answer back", async () => {
    const { service, caller } = setup({
      unbound: ["slack_bot_token"],
      accept: "replayed",
    });
    expect(
      await service.createSession(caller, {
        idempotencyKey: "k",
        body: { ...body, agent_release_id: "rel-1" },
      }),
    ).toMatchObject({ session_id: "019a0000-0000-7000-8000-00000000e0a1" });
  });

  test("an unbind between the decision and the acceptance still refuses", async () => {
    const { service, caller, accepted } = setup({
      accept: "credential_unbound",
    });
    expect(
      await service
        .createSession(caller, {
          idempotencyKey: "k",
          body: { ...body, agent_release_id: "rel-1" },
        })
        .catch((e: unknown) => e),
    ).toMatchObject({
      code: "CREDENTIAL_UNBOUND",
      details: {
        reason_code: "credential_unbound",
        agent_id: AGENT,
        receipt_id: RECEIPT,
      },
    });
    expect(accepted[0]?.credentialsUnbound).toBeUndefined();
  });
});

// docs/contributing/decisions/profile-db.md §6, the attachment table: a new
// session with no release, against one of a release made before.
describe("attachment rules", () => {
  const ceiling = (
    state: InstallationProfileState,
  ): InstallationProfileEntry => ({
    id: "coding-v1",
    origin: "catalog",
    state,
    repository_ids: ["app"],
  });
  const over: WorkspaceProfileRecord = {
    id: "ws_acme_narrow_v1",
    workspace_id: WORKSPACE,
    name: "narrow",
    version: 1,
    base_profile_id: "coding-v1",
    base_fingerprint: profileFingerprint(profile),
    model: "claude-sonnet-5",
    models: ["claude-sonnet-5", "claude-opus-5-5"],
    tools: ["Read"],
    permission_mode: "default",
    base_runtime_version: "0.3.270",
    base_billing: "metered",
    base_repository_mode: "required",
    created_by: MEMBER,
    created_at: new Date("2026-10-27T00:00:00Z"),
    retired_by: null,
    retired_at: null,
  };
  const catalogIn = (state: InstallationProfileState): SessionCatalog => ({
    ...catalog,
    profiles:
      state === "usable" || state === "retired"
        ? catalog.profiles
        : { "review-v1": profile },
    installation: new Map([["coding-v1", ceiling(state)]]),
    workspace_profiles: {
      records: new Map([[over.id, over]]),
      refresh: async () => {},
    },
  });
  async function starts(
    state: InstallationProfileState,
    profileId: string,
    release: boolean,
  ): Promise<string> {
    const { service, caller, accepted } = setup({
      catalog: catalogIn(state),
      releaseProfile: profileId,
    });
    return service
      .createSession(caller, {
        idempotencyKey: "k",
        body: {
          ...body,
          profile_id: profileId,
          ...(release ? { agent_release_id: "rel-1" } : {}),
        },
      })
      .then(
        () =>
          accepted[0]?.profileFingerprint === undefined ? "no pair" : "runs",
        (error: { code?: string }) => error.code ?? "thrown",
      );
  }

  test("a retired ceiling: no new session without a release; a release's session still runs", async () => {
    expect(await starts("usable", "coding-v1", false)).toBe("runs");
    expect(await starts("retired", "coding-v1", false)).not.toBe("runs");
    expect(await starts("retired", "coding-v1", true)).toBe("runs");
  });

  test("a version over a retired ceiling (base_retired): the same", async () => {
    expect(await starts("usable", over.id, false)).toBe("runs");
    expect(await starts("retired", over.id, false)).not.toBe("runs");
    expect(await starts("retired", over.id, true)).toBe("runs");
  });

  test("any other state runs nothing, with a release or without, on the ceiling or a version over it", async () => {
    for (const state of [
      "blocked",
      "connection_missing",
      "unattended_off",
      "definition_drift",
      "runtime_unsupported",
    ] as const) {
      for (const id of ["coding-v1", over.id]) {
        expect(await starts(state, id, false)).not.toBe("runs");
        expect(await starts(state, id, true)).not.toBe("runs");
      }
    }
  });

  test("a blocked ceiling is refused by name, a release's session too, and a version over it reads base_blocked", () => {
    expect(workspaceProfileState(catalogIn("blocked"), over)).toBe(
      "base_blocked",
    );
    expect(
      workspaceProfileRefusal(catalogIn("blocked"), WORKSPACE, "coding-v1", {
        retiredAllowed: true,
      }),
    ).toMatchObject({ state: "blocked" });
  });

  test("a session without a release on a blocked ceiling, or a version over it, is refused as PROFILE_BLOCKED naming the profile", async () => {
    const refusal = async (profileId: string) => {
      const { service, caller } = setup({
        catalog: catalogIn("blocked"),
        accept: "unsupported",
      });
      return service
        .createSession(caller, {
          idempotencyKey: "k",
          body: { ...body, profile_id: profileId },
        })
        .catch((error: unknown) => error);
    };
    expect(await refusal("coding-v1")).toMatchObject({
      code: "PROFILE_BLOCKED",
      details: { reason_code: "blocked", profile_id: "coding-v1" },
    });
    expect(await refusal(over.id)).toMatchObject({
      code: "PROFILE_BLOCKED",
      details: { reason_code: "base_blocked", profile_id: over.id },
    });
  });
});
