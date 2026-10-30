import { describe, expect, test } from "bun:test";
import {
  GITHUB_CEILING_NONE,
  type GitHubCeiling,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import type {
  GitHubOAuthStore,
  GitHubSettingsStore,
  GitHubWorkspaceSettings,
} from "../ports/github-settings.ts";
import { SessionServiceError } from "../sessions/session-service.ts";
import { fakeGitHubClientSecret } from "../testing/github-fakes.ts";
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

const CALLBACK = "https://console.example.com/settings/linked-accounts/github";

function harness(options: { authorApp?: boolean; secretsOn?: boolean } = {}) {
  const secrets: Array<{ workspaceId: string; secret: string }> = [];
  const oauth: GitHubOAuthStore = {
    status: async () => ({
      authorApp: options.authorApp !== false,
      clientId: options.authorApp === false ? null : "Iv23liClient",
      clientSecretSet: secrets.length > 0,
    }),
    client: async () => null,
    putClientSecret: async (workspaceId, secret, _audit, clientId) => {
      if (options.authorApp === false) return { outcome: "no_author_app" };
      if (clientId !== "Iv23liClient") return { outcome: "client_changed" };
      secrets.push({ workspaceId, secret });
      return { outcome: "stored" };
    },
  };
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
    oauth,
    callbackUrl: CALLBACK,
    secretsOn: options.secretsOn ?? true,
    newId: () => "019a0000-0000-7000-8000-0000000000aa",
  });
  return { service, puts, secrets };
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
      oauth: {
        client_id: "Iv23liClient",
        client_secret_set: false,
        callback_url: CALLBACK,
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

// Every refusal comes before the body, so these never hold a client secret.
describe("storing the OAuth client secret", () => {
  test("an owner or an admin stores it for the App shown; only that it is set comes back", async () => {
    const { service, secrets } = harness();
    for (const role of ["owner", "admin"] as const) {
      const typed = fakeGitHubClientSecret();
      const stored = await service.putOAuthClientSecret(
        user(role),
        WORKSPACE,
        async () => ({ client_id: "Iv23liClient", client_secret: typed }),
      );
      expect(stored).toEqual({
        receipt_id: "019a0000-0000-7000-8000-0000000000aa",
        oauth: {
          client_id: "Iv23liClient",
          client_secret_set: true,
          callback_url: CALLBACK,
        },
      });
      expect(JSON.stringify(stored).includes(typed)).toBe(false);
      expect(secrets.at(-1)?.secret === typed).toBe(true);
      expect(secrets.at(-1)?.workspaceId).toBe(WORKSPACE);
    }
    expect(secrets).toHaveLength(2);
  });
});

describe("refusing the OAuth client secret", () => {
  const unread = async (): Promise<never> => {
    throw new Error("the body was read");
  };

  test("a member, an API key, an owner off the web or another workspace", async () => {
    const { service, secrets } = harness();
    for (const [caller, workspaceId, code] of [
      [user("member"), WORKSPACE, "FORBIDDEN"],
      [apiKey(), WORKSPACE, "FORBIDDEN"],
      [user("owner", { surface: "api" }), WORKSPACE, "FORBIDDEN"],
      [user("owner"), OTHER, "NOT_FOUND"],
    ] as const) {
      expect(
        (
          await refusal(
            service.putOAuthClientSecret(caller, workspaceId, unread),
          )
        ).code,
      ).toBe(code);
    }
    expect(secrets).toEqual([]);
  });

  test("no author App is GITHUB_LINK_NOT_CONFIGURED", async () => {
    const { service } = harness({ authorApp: false });
    expect(
      await refusal(
        service.putOAuthClientSecret(user("admin"), WORKSPACE, unread),
      ),
    ).toEqual({
      code: "GITHUB_LINK_NOT_CONFIGURED",
      details: { reason_code: "no_author_app" },
    });
  });

  test("a secret typed for an App since replaced is REVISION_CONFLICT", async () => {
    const { service, secrets } = harness();
    expect(
      await refusal(
        service.putOAuthClientSecret(user("owner"), WORKSPACE, async () => ({
          client_id: "Iv23liReplaced",
          // Refused before it is stored, as in the callback fixtures.
          client_secret: "",
        })),
      ),
    ).toEqual({
      code: "REVISION_CONFLICT",
      details: { reason_code: "github_app_changed" },
    });
    expect(secrets).toEqual([]);
  });

  test("the secret store off is BACKEND_UNAVAILABLE", async () => {
    const { service } = harness({ secretsOn: false });
    expect(
      (
        await refusal(
          service.putOAuthClientSecret(user("owner"), WORKSPACE, unread),
        )
      ).code,
    ).toBe("BACKEND_UNAVAILABLE");
  });
});
