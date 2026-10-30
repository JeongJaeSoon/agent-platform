import { describe, expect, test } from "bun:test";
import {
  GITHUB_CEILING_NONE,
  type GitHubCeiling,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import type {
  GitHubSettingsStore,
  GitHubWorkspaceSettings,
} from "../ports/github-settings.ts";
import { SessionServiceError } from "../sessions/session-service.ts";
import { createGitHubSettingsService } from "./github-settings-service.ts";
import { type Caller, callerFor, createAuthorizationPolicy } from "./policy.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const OTHER = "019a0000-0000-7000-8000-0000000000f2";

function user(
  role: WorkspaceRole,
  options: { surface?: "web" | "api"; workspace?: string } = {},
): Caller {
  return callerFor(
    {
      kind: "user",
      id: crypto.randomUUID(),
      workspace_id: options.workspace ?? WORKSPACE,
      role,
      scopes: [...scopesForRole(role)],
    },
    { kind: options.surface ?? "web" },
    crypto.randomUUID(),
  );
}

function apiKey(): Caller {
  return callerFor(
    {
      kind: "api_key",
      id: "key-1",
      owner_id: WORKSPACE,
      workspace_id: WORKSPACE,
      scopes: [...scopesForRole("owner")],
    },
    { kind: "api" },
    crypto.randomUUID(),
    { creatorId: crypto.randomUUID() },
  );
}

function harness() {
  let settings: GitHubWorkspaceSettings = {
    ceiling: GITHUB_CEILING_NONE,
    revision: 0,
  };
  const puts: Array<{ updatedBy: string; ceiling: GitHubCeiling }> = [];
  const store: GitHubSettingsStore = {
    get: async () => settings,
    agentsUsing: async () => ({
      workflows: 0,
      actions: 2,
      checks: 0,
      issues: 0,
      review: 1,
    }),
    appPermissions: async () => ({
      author: { permissions: { contents: "write", actions: "write" } },
      reviewer: null,
    }),
    putCeiling: async (input) => {
      if (input.revision !== settings.revision) {
        return { outcome: "revision_conflict" };
      }
      puts.push({ updatedBy: input.updatedBy, ceiling: input.ceiling });
      settings = { ceiling: input.ceiling, revision: settings.revision + 1 };
      return { outcome: "stored", settings };
    },
  };
  const service = createGitHubSettingsService({
    authorization: createAuthorizationPolicy(),
    store,
  });
  return { service, puts };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SessionServiceError) {
      return { code: error.code, details: error.details };
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

const ACTIONS_ON: GitHubCeiling = { ...GITHUB_CEILING_NONE, actions: true };

describe("GitHub settings service", () => {
  test("GET by any member returns ceiling, revision, agents_using and apps", async () => {
    const { service } = harness();
    for (const role of ["owner", "admin"] as const) {
      expect(await service.get(user(role), WORKSPACE)).toMatchObject({
        revision: 0,
      });
    }
    expect(await service.get(user("member"), WORKSPACE)).toEqual({
      ceiling: GITHUB_CEILING_NONE,
      revision: 0,
      agents_using: {
        workflows: 0,
        actions: 2,
        checks: 0,
        issues: 0,
        review: 1,
      },
      apps: {
        author: { permissions: { contents: "write", actions: "write" } },
        reviewer: null,
      },
    });
  });

  test("GET for another workspace is NOT_FOUND", async () => {
    const { service } = harness();
    expect((await refusal(service.get(user("owner"), OTHER))).code).toBe(
      "NOT_FOUND",
    );
    expect(
      (
        await refusal(
          service.get(user("owner", { workspace: OTHER }), WORKSPACE),
        )
      ).code,
    ).toBe("NOT_FOUND");
  });

  test("GET by an API key is FORBIDDEN", async () => {
    const { service } = harness();
    expect((await refusal(service.get(apiKey(), WORKSPACE))).code).toBe(
      "FORBIDDEN",
    );
  });

  test("an owner and an admin signed in to the console can PUT", async () => {
    const { service, puts } = harness();
    const owner = user("owner");
    const stored = await service.put(owner, WORKSPACE, async () => ({
      ceiling: ACTIONS_ON,
      revision: 0,
    }));
    expect(stored).toMatchObject({ ceiling: ACTIONS_ON, revision: 1 });
    const admin = user("admin");
    expect(
      await service.put(admin, WORKSPACE, async () => ({
        ceiling: GITHUB_CEILING_NONE,
        revision: 1,
      })),
    ).toMatchObject({ ceiling: GITHUB_CEILING_NONE, revision: 2 });
    expect(puts.map((put): string | undefined => put.updatedBy)).toEqual([
      owner.subject.principal?.id,
      admin.subject.principal?.id,
    ]);
  });

  test("a member PUT is FORBIDDEN and the body is not read", async () => {
    const { service, puts } = harness();
    let read = false;
    expect(
      (
        await refusal(
          service.put(user("member"), WORKSPACE, async () => {
            read = true;
            return { ceiling: ACTIONS_ON, revision: 0 };
          }),
        )
      ).code,
    ).toBe("FORBIDDEN");
    expect(read).toBe(false);
    expect(puts).toEqual([]);
  });

  test("an API key, or an owner off the web surface, is FORBIDDEN", async () => {
    const { service, puts } = harness();
    const body = async () => ({ ceiling: ACTIONS_ON, revision: 0 });
    expect((await refusal(service.put(apiKey(), WORKSPACE, body))).code).toBe(
      "FORBIDDEN",
    );
    expect(
      await refusal(
        service.put(user("owner", { surface: "api" }), WORKSPACE, body),
      ),
    ).toEqual({
      code: "FORBIDDEN",
      details: { reason_code: "web_session_required" },
    });
    expect(puts).toEqual([]);
  });

  test("a stale revision is REVISION_CONFLICT", async () => {
    const { service } = harness();
    await service.put(user("owner"), WORKSPACE, async () => ({
      ceiling: ACTIONS_ON,
      revision: 0,
    }));
    expect(
      (
        await refusal(
          service.put(user("owner"), WORKSPACE, async () => ({
            ceiling: GITHUB_CEILING_NONE,
            revision: 0,
          })),
        )
      ).code,
    ).toBe("REVISION_CONFLICT");
  });
});
