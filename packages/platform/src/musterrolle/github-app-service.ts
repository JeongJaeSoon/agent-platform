import { createPrivateKey } from "node:crypto";
import {
  type DeleteGitHubAppResponse,
  type GetGitHubAppResponse,
  type GitHubApp,
  type GitHubAppRepository,
  githubAppWarnings,
  type PutGitHubAppRequest,
  type PutGitHubAppResponse,
} from "@werft-ai/contracts";
import { repoRefOf } from "../ports/forge.ts";
import {
  GitHubAppCheckError,
  type GitHubAppCredential,
  type GitHubAppDirectory,
  type GitHubAppRecord,
  type GitHubAppStore,
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
/** `/github-app` is the author App's; the reviewer's has routes of its own. */
const ROLE = "author";

const STORE_OFF = () =>
  new SessionServiceError(
    "BACKEND_UNAVAILABLE",
    "The secret store is off: the API was started without PLATFORM_SECRET_KEY",
  );

const refused = (reasonCode: string, message: string) =>
  new SessionServiceError("BAD_REQUEST", message, undefined, {
    reason_code: reasonCode,
  });

export function githubAppOf(record: GitHubAppRecord): GitHubApp {
  const { updatedBy } = record.privateKey;
  return {
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
    warnings: githubAppWarnings(ROLE, record.permissions),
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
 * The workspace's GitHub App, set in the console by an owner or admin
 * (`workspace.manage`) signed in to it. The key is checked against GitHub
 * before it is kept, and never leaves the server again.
 */
export function createGitHubAppService(deps: {
  authorization: AuthorizationPolicy;
  /** Null when the API runs without a master key. */
  store: GitHubAppStore | null;
  directory: GitHubAppDirectory;
  apiBase: string;
  /** Catalog repositories written as `{ kind: github_app }`. */
  repositories: () => ReadonlyArray<{ id: string; url: string }>;
  /** Called after a change commits, so this replica's forge picks it up. */
  changed: () => Promise<void>;
  newId?: () => string;
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

  async function check(
    credential: GitHubAppCredential,
  ): Promise<Omit<GetGitHubAppResponse, "github_app">> {
    const unchecked = deps
      .repositories()
      .map(({ id, url }) => ({ id, url, installation_id: null }));
    try {
      const [installations, repositories] = await Promise.all([
        directory.installations(credential),
        Promise.all(
          unchecked.map(async (repository): Promise<GitHubAppRepository> => {
            const ref = repoRefOf(repository.url);
            return {
              ...repository,
              installation_id:
                ref === null
                  ? null
                  : await directory.installationFor(credential, ref),
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
        repositories: unchecked,
      };
    }
  }

  return {
    async describe(
      caller: Caller,
      workspaceId: string,
    ): Promise<GetGitHubAppResponse> {
      const store = await managedStore(caller, workspaceId);
      const record = await store.find(workspaceId, ROLE);
      const credential =
        record === null
          ? undefined
          : (await store.credentials(ROLE, workspaceId)).find(
              (held) => held.id === record.id,
            );
      if (record === null || credential === undefined) {
        return {
          github_app: null,
          check: null,
          installations: [],
          repositories: deps
            .repositories()
            .map(({ id, url }) => ({ id, url, installation_id: null })),
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
        github_app: githubAppOf(
          profile === null
            ? record
            : {
                ...record,
                permissions: profile.permissions,
                permissionsCheckedAt: new Date(),
                clientId: profile.clientId,
              },
        ),
        ...checked,
      };
    },

    /**
     * `readBody` runs only once the caller is allowed, so a refused caller
     * learns nothing about the request body.
     */
    async register(
      caller: Caller,
      workspaceId: string,
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
        ROLE,
        { ...profile, apiBase: deps.apiBase },
        privateKey,
        audit,
      );
      switch (result.outcome) {
        case "stored":
          await reload();
          return {
            github_app: githubAppOf(result.app),
            receipt_id: audit.receiptId,
          };
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        default:
          throw NOT_FOUND();
      }
    },

    async remove(
      caller: Caller,
      workspaceId: string,
    ): Promise<DeleteGitHubAppResponse> {
      const store = await managedStore(caller, workspaceId);
      const audit = auditOf(caller);
      const result = await store.delete(workspaceId, ROLE, audit);
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
}

export type GitHubAppService = ReturnType<typeof createGitHubAppService>;
