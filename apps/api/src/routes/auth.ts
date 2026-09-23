import { randomUUID } from "node:crypto";
import {
  authMeResponseSchema,
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  loginRequestSchema,
  loginResponseSchema,
  normalizeEmail,
  scopesForRole,
  type Workspace,
  workspaceSettingsSchema,
} from "@agent-platform/contracts";
import { BootstrapDoneError, type WorkspaceRow } from "@agent-platform/db";
import type { StructuredLogger } from "@agent-platform/observability";
import { z } from "zod";
import {
  ApiHttpError,
  type ApiRouter,
  ingestThenStopClock,
  isStorageUnavailable,
  jsonWithSchema,
  parseJsonBody,
  storageUnavailableError,
} from "../app.ts";
import {
  type BootstrapGate,
  clearWebSessionCookie,
  generateWebSessionToken,
  hashPassword,
  hashWebSessionToken,
  type IdentityStore,
  LoginLockout,
  setWebSessionCookie,
  verifyPassword,
  WEB_SESSION_TTL_MS,
  webSessionCookie,
} from "../auth.ts";

// Error statuses each handler can produce; the OpenAPI parity test holds the
// route table to this.
export const authRouteErrors: Record<string, number[]> = {
  "POST /v1/auth/bootstrap": [400, 401, 409, 413, 503],
  "POST /v1/auth/login": [400, 401, 413, 429, 503],
  "POST /v1/auth/logout": [401, 403, 503],
  "GET /v1/auth/me": [401, 503],
};

export interface AuthRouteDeps {
  identity: IdentityStore;
  bootstrap: BootstrapGate;
  lockout?: LoginLockout;
  logger?: StructuredLogger;
}

const INVALID_CREDENTIALS = "Invalid email or password";

// The token is read on its own and checked before the rest of the body is
// validated, so a caller without it learns nothing about the schema and gets
// 401 rather than 400. A body that is not a JSON object cannot carry a
// token at all and stays a 400.
const bootstrapTokenOnlySchema = z.looseObject({
  bootstrap_token: z.unknown().optional(),
});

async function storageMapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isStorageUnavailable(error)) {
      throw storageUnavailableError();
    }
    throw error;
  }
}

export function workspaceView(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    settings: workspaceSettingsSchema.parse(row.settings),
    created_at: row.createdAt.toISOString(),
  };
}

/** Mounted outside the auth middleware (03 §3.2 public allowlist). */
export function registerPublicAuthRoutes(
  router: ApiRouter,
  deps: AuthRouteDeps,
) {
  const lockout = deps.lockout ?? new LoginLockout();

  router.post("/auth/bootstrap", ingestThenStopClock, async (context) => {
    // Done is answered before the token is looked at: once the first owner
    // exists the token has nothing left to protect, and 409 is not a hint.
    if ((await storageMapped(() => deps.identity.countUsers())) > 0) {
      throw new ApiHttpError(409, "BOOTSTRAP_DONE", "Bootstrap already done");
    }
    const raw = await parseJsonBody(context, bootstrapTokenOnlySchema);
    const token =
      typeof raw.bootstrap_token === "string" ? raw.bootstrap_token : null;
    if (token === null || !deps.bootstrap.matches(token)) {
      deps.logger?.warn("Bootstrap refused: token mismatch");
      throw new ApiHttpError(401, "UNAUTHORIZED", "Bootstrap token is invalid");
    }
    const parsed = bootstrapRequestSchema.safeParse(raw);
    if (!parsed.success) {
      // The token stays unspent: a typo in the form is not a used install.
      throw new ApiHttpError(400, "BAD_REQUEST", "Request body is invalid");
    }
    const body = parsed.data;
    if (!deps.bootstrap.consume(token)) {
      // A concurrent request with the same token got there first.
      throw new ApiHttpError(409, "BOOTSTRAP_DONE", "Bootstrap already done");
    }
    try {
      const passwordHash = await hashPassword(body.password);
      const { user, workspace } = await storageMapped(() =>
        deps.identity.bootstrap({
          userId: randomUUID(),
          email: normalizeEmail(body.email),
          passwordHash,
          displayName: body.display_name,
          workspaceId: randomUUID(),
          workspaceSlug: body.workspace_slug,
          workspaceName: body.workspace_name,
        }),
      );
      deps.logger?.info("Bootstrap completed", {
        user_id: user.id,
        workspace_id: workspace.id,
      });
      return jsonWithSchema(
        context,
        bootstrapResponseSchema,
        {
          user_id: user.id,
          workspace: workspaceView(workspace),
          role: "owner",
        },
        201,
      );
    } catch (error) {
      if (error instanceof BootstrapDoneError) {
        throw new ApiHttpError(409, "BOOTSTRAP_DONE", "Bootstrap already done");
      }
      // The insert failed (storage down, slug race); the token is still the
      // operator's to spend.
      deps.bootstrap.release();
      throw error;
    }
  });

  router.post("/auth/login", ingestThenStopClock, async (context) => {
    const body = await parseJsonBody(context, loginRequestSchema);
    const email = normalizeEmail(body.email);
    // Counted as a failure before the password is checked, in the same
    // synchronous step as the lockout check: a burst of concurrent guesses
    // cannot all see the window open while their hashes are still running.
    // Success clears it below.
    const reservation = lockout.reserve(email);
    if (reservation.retryAfterMs > 0) {
      context.header(
        "Retry-After",
        String(Math.ceil(reservation.retryAfterMs / 1000)),
      );
      throw new ApiHttpError(
        429,
        "RATE_LIMITED",
        "Too many failed logins, try again later",
        true,
      );
    }
    let user: Awaited<ReturnType<IdentityStore["findUserForLogin"]>>;
    let verified: boolean;
    let membership: Awaited<ReturnType<IdentityStore["findLiveMembership"]>>;
    try {
      user = await storageMapped(() => deps.identity.findUserForLogin(email));
      verified = await verifyPassword(
        body.password,
        user?.passwordHash ?? null,
      );
      const found = user;
      membership =
        verified && found
          ? await storageMapped(() =>
              deps.identity.findLiveMembership(found.id),
            )
          : null;
    } catch (error) {
      // An outage is not a guess: without this, five 503s in a row would
      // lock the account out for the whole window after the DB recovers.
      reservation.release();
      throw error;
    }
    if (!user || !verified || !membership) {
      // A user with no live workspace fails like a wrong password; the
      // reservation above already counted it, so probing is bounded.
      deps.logger?.warn("Login failed", { has_user: user !== null });
      throw new ApiHttpError(401, "UNAUTHORIZED", INVALID_CREDENTIALS);
    }
    lockout.clear(email);
    const token = generateWebSessionToken();
    const { expiresAt } = await storageMapped(() =>
      deps.identity.createWebSession({
        id: randomUUID(),
        userId: user.id,
        tokenHash: hashWebSessionToken(token),
        ttlMs: WEB_SESSION_TTL_MS,
        userAgent: context.req.header("User-Agent")?.slice(0, 512) ?? null,
      }),
    );
    setWebSessionCookie(context, token, expiresAt);
    return jsonWithSchema(context, loginResponseSchema, {
      user_id: user.id,
      workspace_id: membership.workspaceId,
      role: membership.role,
      scopes: [...scopesForRole(membership.role)],
      expires_at: expiresAt.toISOString(),
    });
  });
}

/** Mounted inside the auth middleware. */
export function registerAuthRoutes(router: ApiRouter, deps: AuthRouteDeps) {
  router.post("/auth/logout", async (context) => {
    const principal = context.get("principal");
    const cookie = webSessionCookie(context);
    if (principal.kind !== "user" || !cookie) {
      throw new ApiHttpError(
        403,
        "FORBIDDEN",
        "Logout applies to a session cookie only",
      );
    }
    await storageMapped(() =>
      deps.identity.revokeWebSession(hashWebSessionToken(cookie)),
    );
    clearWebSessionCookie(context);
    return context.body(null, 204);
  });

  router.get("/auth/me", async (context) => {
    const principal = context.get("principal");
    const session = context.get("webSession");
    if (principal.kind === "user" && session) {
      const workspace = await storageMapped(() =>
        deps.identity.findWorkspace(session.workspaceId),
      );
      if (!workspace) {
        // The membership row references a workspace that is gone; treat the
        // session as no longer valid rather than answer half an identity.
        throw new ApiHttpError(
          401,
          "UNAUTHORIZED",
          "Session is no longer valid",
        );
      }
      return jsonWithSchema(context, authMeResponseSchema, {
        principal,
        user: {
          id: session.userId,
          email: session.email,
          display_name: session.displayName,
        },
        workspace: workspaceView(workspace),
        scopes: principal.scopes,
      });
    }
    return jsonWithSchema(context, authMeResponseSchema, {
      principal,
      user: null,
      // A legacy key stays unmapped until an owner_workspace_map row exists
      // (Codex B18); reading that map is 94S-152.
      workspace: null,
      scopes: principal.scopes,
    });
  });
}
