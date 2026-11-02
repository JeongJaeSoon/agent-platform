import { createHash, createPrivateKey, randomBytes } from "node:crypto";
import {
  type CompleteGitHubAppManifestRequest,
  type CompleteGitHubAppManifestResponse,
  type DeleteGitHubAppResponse,
  type GetGitHubAppResponse,
  GITHUB_APP_MANIFEST_STATE_TTL_SECONDS,
  type GitHubApp,
  type GitHubAppRepository,
  type GitHubAppRole,
  githubAppWarnings,
  type PutGitHubAppRequest,
  type PutGitHubAppResponse,
  type StartGitHubAppManifestRequest,
  type StartGitHubAppManifestResponse,
} from "@werft-ai/contracts";
import { repoRefOf } from "../ports/forge.ts";
import {
  GitHubAppCheckError,
  type GitHubAppCredential,
  type GitHubAppDirectory,
  type GitHubAppManifestConversion,
  type GitHubAppManifestStore,
  type GitHubAppRecord,
  type GitHubAppStore,
  type PutGitHubAppResult,
} from "../ports/github-app-store.ts";
import type { SecretAudit } from "../ports/secret-store.ts";
import {
  requirePermitted,
  SessionServiceError,
} from "../sessions/session-service.ts";
import {
  type AuthorizationPolicy,
  type Caller,
  MANAGEMENT_ROLES,
} from "./policy.ts";
import { ACTOR_INACTIVE, NOT_FOUND, OUTRANKED } from "./service-errors.ts";

const MANAGERS = MANAGEMENT_ROLES["workspace.manage"] ?? [];

const STORE_OFF = () =>
  new SessionServiceError(
    "BACKEND_UNAVAILABLE",
    "The secret store is off: the API was started without PLATFORM_SECRET_KEY",
  );

const refused = (reasonCode: string, message: string) =>
  new SessionServiceError("BAD_REQUEST", message, undefined, {
    reason_code: reasonCode,
  });

export function githubAppOf(
  record: GitHubAppRecord,
  role: GitHubAppRole,
): GitHubApp {
  const { updatedBy } = record.privateKey;
  return {
    role,
    app_id: record.appId,
    slug: record.slug,
    name: record.name,
    html_url: record.htmlUrl,
    private_key: {
      updated_at: record.privateKey.updatedAt.toISOString(),
      updated_by:
        updatedBy === null
          ? null
          : { user_id: updatedBy.userId, display_name: updatedBy.displayName },
    },
    created_at: record.createdAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
    permissions: record.permissions,
    permissions_checked_at: record.permissionsCheckedAt?.toISOString() ?? null,
    warnings: githubAppWarnings(role, record.permissions),
  };
}

const hashState = (state: string) =>
  createHash("sha256").update(state, "utf8").digest();

// managedStore has already refused anyone but a signed-in user.
function userOf(caller: Caller): string {
  const userId = caller.actor?.userId;
  if (!userId) throw new Error("A console caller without a user");
  return userId;
}

/** The author App's manifest (design github-app-manifest.md §5). */
export function githubAppManifest(input: {
  origin: string;
  callbackUrl: string;
  login: string | null;
  public: boolean;
  actions: boolean;
  /** Four hex characters: App names are unique across GitHub. */
  suffix: string;
}) {
  const origin = input.origin.replace(/\/+$/, "");
  const owner = (input.login ?? "agent").slice(0, 22).toLowerCase();
  return {
    name: `werft-${owner}-${input.suffix}`,
    url: origin,
    redirect_url: `${origin}/settings/workspace/github/new-app`,
    callback_urls: [input.callbackUrl],
    setup_url: `${origin}/settings/workspace/github`,
    public: input.public,
    default_permissions: {
      contents: "write",
      pull_requests: "write",
      metadata: "read",
      ...(input.actions ? { actions: "write", workflows: "write" } : {}),
    },
    // No hook_attributes: GitHub rejects a hook URL it cannot reach, even an
    // inactive one, and the platform subscribes to no events.
    default_events: [],
    request_oauth_on_install: false,
  };
}

/**
 * A PEM as GitHub hands it out, or pasted with Windows line ends; anything
 * that is not an RSA private key is refused before GitHub sees it.
 */
function rsaPrivateKey(raw: string): string {
  const pem = raw.replace(/\r\n?/g, "\n").trim();
  try {
    if (createPrivateKey(pem).asymmetricKeyType === "rsa") return pem;
  } catch {}
  throw refused(
    "invalid_private_key",
    "private_key is not an RSA private key PEM",
  );
}

/**
 * The workspace's GitHub Apps, one per role (design github-agent.md §2
 * decision 1), set in the console by an owner or admin (`workspace.manage`)
 * signed in to it. A key is checked against GitHub before it is kept, and
 * never leaves the server again.
 */
export function createGitHubAppService(deps: {
  authorization: AuthorizationPolicy;
  /** Null when the API runs without a master key. */
  store: GitHubAppStore | null;
  directory: GitHubAppDirectory;
  apiBase: string;
  /** Catalog repositories written as `{ kind: github_app }`. */
  repositories: () => ReadonlyArray<{ id: string; url: string }>;
  /** Called after a change commits, so this replica's connections pick it up. */
  changed: () => Promise<void>;
  newId?: () => string;
  /** Making the author App from a manifest; absent, it is refused. */
  manifests?: {
    states: GitHubAppManifestStore;
    /** `POST /app-manifests/{code}/conversions`; sent once, never retried. */
    convert: (
      apiBase: string,
      code: string,
    ) => Promise<GitHubAppManifestConversion>;
    /** Null when CONSOLE_ORIGIN is unset. */
    consoleOrigin: string | null;
    /** The account-link callback (`githubCallbackUrl`). */
    callbackUrl: string | null;
    /** GitHub's web origin, where the browser posts the manifest. */
    webBase: string;
    now?: () => Date;
    /** Which check refused a state; for the log, never the response. */
    refused?: (check: string) => void;
  };
}) {
  const { authorization, directory } = deps;
  const newId = deps.newId ?? (() => crypto.randomUUID());

  async function managedStore(
    caller: Caller,
    workspaceId: string,
  ): Promise<GitHubAppStore> {
    if (workspaceId !== caller.ownerId) throw NOT_FOUND();
    await requirePermitted(authorization, caller, "workspace.manage", {
      kind: "workspace",
      id: workspaceId,
    });
    if (
      caller.subject.surface.kind !== "web" ||
      caller.subject.principal?.kind !== "user"
    ) {
      throw new SessionServiceError(
        "FORBIDDEN",
        "The GitHub App is set from a signed-in console session, not with an API key",
        undefined,
        { reason_code: "web_session_required" },
      );
    }
    if (deps.store === null) throw STORE_OFF();
    return deps.store;
  }

  const auditOf = (caller: Caller): SecretAudit => ({
    principal: caller,
    receiptId: newId(),
    roles: MANAGERS,
  });

  // After a write has committed, a failed reload must not report it failed;
  // the periodic one catches up.
  const reload = () => deps.changed().catch(() => undefined);

  const manifestBlocked = () =>
    deps.manifests?.consoleOrigin && deps.manifests.callbackUrl
      ? null
      : ("console_origin_unset" as const);

  const unchecked = (): GitHubAppRepository[] =>
    deps
      .repositories()
      .map(({ id, url }) => ({ id, url, installation_id: null }));

  async function check(
    credential: GitHubAppCredential,
  ): Promise<Omit<GetGitHubAppResponse, "github_app">> {
    try {
      const [installations, repositories] = await Promise.all([
        directory.installations(credential),
        Promise.all(
          unchecked().map(async (repository): Promise<GitHubAppRepository> => {
            const ref = repoRefOf(repository.url);
            const found =
              ref === null
                ? null
                : await directory.installationFor(credential, ref);
            return {
              ...repository,
              installation_id: found?.id ?? null,
              installation_permissions: found?.permissions ?? null,
            };
          }),
        ),
      ]);
      return {
        check: { state: "ok" },
        installations: installations.map((installation) => ({
          id: installation.id,
          account: installation.account,
          repository_selection: installation.repositorySelection,
          html_url: installation.htmlUrl,
        })),
        repositories,
      };
    } catch (error) {
      return {
        check: {
          state: "failed",
          reason_code:
            error instanceof GitHubAppCheckError
              ? error.reason
              : "github_unreachable",
        },
        installations: [],
        repositories: unchecked(),
      };
    }
  }

  return {
    async describe(
      caller: Caller,
      workspaceId: string,
      role: GitHubAppRole,
    ): Promise<GetGitHubAppResponse> {
      const store = await managedStore(caller, workspaceId);
      const record = await store.find(workspaceId, role);
      const credential =
        record === null
          ? undefined
          : (await store.credentials(role, workspaceId)).find(
              (held) => held.id === record.id,
            );
      if (record === null || credential === undefined) {
        return {
          github_app: null,
          check: null,
          installations: [],
          repositories: unchecked(),
          manifest_blocked: manifestBlocked(),
        };
      }
      const [checked, profile] = await Promise.all([
        check(credential),
        // An owner widens the App on GitHub; this read is how it shows here.
        directory
          .describe(credential)
          .then(
            (profile) => profile,
            () => null,
          ),
      ]);
      if (profile !== null) {
        await store.recordPermissions(
          record.id,
          credential.appId,
          profile.permissions,
          profile.clientId,
        );
      }
      return {
        github_app: {
          ...githubAppOf(
            profile === null
              ? record
              : {
                  ...record,
                  permissions: profile.permissions,
                  permissionsCheckedAt: new Date(),
                  clientId: profile.clientId,
                },
            role,
          ),
          owner: profile?.owner ?? null,
        },
        ...checked,
        manifest_blocked: manifestBlocked(),
      };
    },

    /**
     * `readBody` runs only once the caller is allowed, so a refused caller
     * learns nothing about the request body.
     */
    async register(
      caller: Caller,
      workspaceId: string,
      role: GitHubAppRole,
      readBody: () => Promise<PutGitHubAppRequest>,
    ): Promise<PutGitHubAppResponse> {
      const store = await managedStore(caller, workspaceId);
      const body = await readBody();
      const privateKey = rsaPrivateKey(body.private_key);
      let profile: Awaited<ReturnType<GitHubAppDirectory["describe"]>>;
      try {
        profile = await directory.describe({
          appId: body.app_id,
          apiBase: deps.apiBase,
          privateKey,
        });
      } catch (error) {
        if (
          error instanceof GitHubAppCheckError &&
          error.reason === "github_rejected"
        ) {
          throw refused(
            "github_app_rejected",
            "GitHub did not accept this private key for app_id",
          );
        }
        throw new SessionServiceError(
          "BACKEND_UNAVAILABLE",
          "GitHub could not be reached to check the App",
          undefined,
          { reason_code: "github_unreachable" },
        );
      }
      if (profile.appId !== body.app_id) {
        throw refused(
          "github_app_rejected",
          "GitHub did not accept this private key for app_id",
        );
      }
      const audit = auditOf(caller);
      const result = await store.put(
        workspaceId,
        role,
        { ...profile, apiBase: deps.apiBase },
        privateKey,
        audit,
      );
      return {
        github_app: await stored(result, role),
        receipt_id: audit.receiptId,
      };
    },

    /**
     * A manifest for a new author App and the GitHub URL the browser posts it
     * to, with a single-use state bound to the caller (design
     * github-app-manifest.md).
     */
    async startManifest(
      caller: Caller,
      workspaceId: string,
      readBody: () => Promise<StartGitHubAppManifestRequest>,
    ): Promise<StartGitHubAppManifestResponse> {
      const store = await managedStore(caller, workspaceId);
      const manifests = deps.manifests;
      const origin = manifests?.consoleOrigin;
      if (!manifests || !origin || !manifests.callbackUrl) {
        throw new SessionServiceError(
          "BACKEND_UNAVAILABLE",
          "CONSOLE_ORIGIN is not set, so GitHub has nowhere to send the browser back",
          undefined,
          { reason_code: "console_origin_unset" },
        );
      }
      const body = await readBody();
      const current = await store.find(workspaceId, "author");
      if (current !== null && !body.replace) {
        throw new SessionServiceError(
          "GITHUB_APP_CONFLICT",
          "An author GitHub App is registered; send replace: true to replace it",
          undefined,
          { reason_code: "author_app_exists" },
        );
      }
      const at = manifests.now?.() ?? new Date();
      const expiresAt = new Date(
        at.getTime() + GITHUB_APP_MANIFEST_STATE_TTL_SECONDS * 1000,
      );
      const state = randomBytes(32).toString("base64url");
      const login =
        body.owner.kind === "organization" ? body.owner.login : null;
      await manifests.states.issueState(
        hashState(state),
        {
          workspaceId,
          actorUserId: userOf(caller),
          role: "author",
          ownerLogin: login,
          public: body.public,
          replacesAppId: current?.appId ?? null,
          expiresAt,
        },
        at,
      );
      const web = manifests.webBase.replace(/\/+$/, "");
      const target =
        login === null
          ? `${web}/settings/apps/new`
          : `${web}/organizations/${encodeURIComponent(login)}/settings/apps/new`;
      return {
        action_url: `${target}?state=${state}`,
        manifest: JSON.stringify(
          githubAppManifest({
            origin,
            callbackUrl: manifests.callbackUrl,
            login,
            public: body.public,
            actions: body.actions,
            suffix: randomBytes(2).toString("hex"),
          }),
        ),
        expires_at: expiresAt.toISOString(),
      };
    },

    /**
     * Spends the state, exchanges the code once, and stores the App, its key
     * and its OAuth client secret in one transaction.
     */
    async completeManifest(
      caller: Caller,
      workspaceId: string,
      readBody: () => Promise<CompleteGitHubAppManifestRequest>,
    ): Promise<CompleteGitHubAppManifestResponse> {
      const store = await managedStore(caller, workspaceId);
      const manifests = deps.manifests;
      if (!manifests) {
        throw new SessionServiceError(
          "BACKEND_UNAVAILABLE",
          "Making a GitHub App from a manifest is off on this server",
          undefined,
          { reason_code: "console_origin_unset" },
        );
      }
      const body = await readBody();
      const state = await manifests.states.consumeState(hashState(body.state));
      const at = manifests.now?.() ?? new Date();
      const refusal =
        state === null
          ? "not_found"
          : state.expiresAt.getTime() <= at.getTime()
            ? "expired"
            : state.workspaceId !== workspaceId
              ? "workspace"
              : state.actorUserId !== userOf(caller)
                ? "actor"
                : state.role !== "author"
                  ? "role"
                  : null;
      if (state === null || refusal !== null) {
        manifests.refused?.(refusal ?? "not_found");
        throw refused(
          "state_invalid",
          "This GitHub App link is expired, spent or someone else's; start again",
        );
      }
      let app: GitHubAppManifestConversion;
      try {
        app = await manifests.convert(deps.apiBase, body.code);
      } catch (error) {
        if (
          error instanceof GitHubAppCheckError &&
          error.reason === "github_rejected"
        ) {
          throw refused(
            "code_rejected",
            "GitHub did not accept the code; it may have expired or been used",
          );
        }
        throw new SessionServiceError(
          "BACKEND_UNAVAILABLE",
          "GitHub could not be reached to finish the App",
          undefined,
          { reason_code: "github_unreachable" },
        );
      }
      const audit = auditOf(caller);
      let result: PutGitHubAppResult;
      try {
        result = await store.put(
          workspaceId,
          "author",
          {
            appId: app.appId,
            slug: app.slug,
            name: app.name,
            htmlUrl: app.htmlUrl,
            permissions: app.permissions,
            clientId: app.clientId,
            apiBase: deps.apiBase,
          },
          app.privateKey,
          audit,
          {
            clientSecret: app.clientSecret,
            replaces: state.replacesAppId,
            owner: app.owner,
            public: state.public,
          },
        );
      } catch {
        // The code is spent: GitHub holds the App, and its key is gone.
        throw new SessionServiceError(
          "BACKEND_UNAVAILABLE",
          "The App was made on GitHub but its key could not be stored",
          undefined,
          {
            reason_code: "store_failed",
            app_id: app.appId,
            html_url: app.htmlUrl,
          },
        );
      }
      if (result.outcome === "author_app_changed") {
        throw new SessionServiceError(
          "GITHUB_APP_CONFLICT",
          "The author GitHub App changed while this one was being made; nothing was stored",
          undefined,
          {
            reason_code: "author_app_changed",
            app_id: app.appId,
            html_url: app.htmlUrl,
          },
        );
      }
      let githubApp: GitHubApp;
      try {
        githubApp = await stored(result, "author");
      } catch (error) {
        // Whatever refused the save, the App already exists on GitHub.
        if (!(error instanceof SessionServiceError)) throw error;
        throw new SessionServiceError(error.code, error.message, error.retry, {
          ...(error.details as object | null),
          app_id: app.appId,
          html_url: app.htmlUrl,
        });
      }
      return {
        github_app: githubApp,
        install_url: `${app.htmlUrl}/installations/new`,
        receipt_id: audit.receiptId,
      };
    },

    async remove(
      caller: Caller,
      workspaceId: string,
      role: GitHubAppRole,
    ): Promise<DeleteGitHubAppResponse> {
      const store = await managedStore(caller, workspaceId);
      const audit = auditOf(caller);
      const result = await store.delete(workspaceId, role, audit);
      switch (result.outcome) {
        case "deleted":
          await reload();
          return { receipt_id: audit.receiptId };
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        default:
          throw NOT_FOUND();
      }
    },
  };

  async function stored(
    result: PutGitHubAppResult,
    role: GitHubAppRole,
  ): Promise<GitHubApp> {
    switch (result.outcome) {
      case "stored":
        await reload();
        return githubAppOf(result.app, role);
      case "author_app_exists":
      case "author_app_changed":
        throw new SessionServiceError(
          "GITHUB_APP_CONFLICT",
          "The author GitHub App changed; nothing was stored",
          undefined,
          { reason_code: result.outcome },
        );
      case "same_app":
        throw new SessionServiceError(
          "GITHUB_APP_CONFLICT",
          "The workspace's other GitHub App is this App; GitHub refuses an approval from the App that opened the pull request",
          undefined,
          { reason_code: "same_app" },
        );
      case "no_author_app":
        throw new SessionServiceError(
          "GITHUB_APP_CONFLICT",
          "Register the author GitHub App before the reviewer App",
          undefined,
          { reason_code: "no_author_app" },
        );
      case "actor_inactive":
        throw ACTOR_INACTIVE();
      case "outranked":
        throw OUTRANKED();
      default:
        throw NOT_FOUND();
    }
  }
}

export type GitHubAppService = ReturnType<typeof createGitHubAppService>;
