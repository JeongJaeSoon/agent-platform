import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  bootstrapTokenSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  LOGIN_LOCKOUT_ATTEMPTS,
  LOGIN_LOCKOUT_WINDOW_MINUTES,
  type Principal,
  SESSION_SCOPE_VALUES,
  scopesForRole,
  WEB_SESSION_COOKIE_NAME,
} from "@agent-platform/contracts";
import {
  type BootstrapInput,
  bootstrapFirstOwner,
  countUsers,
  createWebSession,
  type Database,
  findLiveMembership,
  findUserForLogin,
  findWorkspace,
  type LiveMembership,
  type ResolvedWebSession,
  renewWebSession,
  resolveWebSession,
  revokeWebSession,
  type UserRow,
  type WorkspaceRow,
} from "@agent-platform/db";
import type { StructuredLogger } from "@agent-platform/observability";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { type ApiKeyStore, hashApiKey } from "./keys.ts";

// Principal resolution for /v1 (03 §3.2). A bearer key is evaluated alone —
// a wrong key is never rescued by a cookie (Codex A06) — and the cookie path
// exists only when the app was given a session store. AUTH_MODE=none keeps
// trusting X-Owner-Id and nothing else, exactly as before this file existed.

export const WEB_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
// A session's expiry slides forward at most this often, so an active tab
// does not turn every request into an UPDATE.
export const WEB_SESSION_RENEW_AFTER_MS = 60 * 60 * 1000;
export const LOGIN_LOCKOUT_WINDOW_MS = LOGIN_LOCKOUT_WINDOW_MINUTES * 60 * 1000;

export interface IdentityStore {
  countUsers(): Promise<number>;
  bootstrap(input: BootstrapInput): Promise<{
    user: UserRow;
    workspace: WorkspaceRow;
  }>;
  findUserForLogin(email: string): Promise<UserRow | null>;
  findLiveMembership(userId: string): Promise<LiveMembership | null>;
  findWorkspace(workspaceId: string): Promise<WorkspaceRow | null>;
  createWebSession(input: {
    id: string;
    userId: string;
    tokenHash: Uint8Array;
    ttlMs: number;
    userAgent: string | null;
  }): Promise<{ expiresAt: Date }>;
  resolveWebSession(tokenHash: Uint8Array): Promise<ResolvedWebSession | null>;
  renewWebSession(
    sessionId: string,
    ttlMs: number,
    renewAfterMs: number,
  ): Promise<void>;
  revokeWebSession(tokenHash: Uint8Array): Promise<void>;
}

export class DatabaseIdentityStore implements IdentityStore {
  constructor(private readonly db: Database) {}
  countUsers() {
    return countUsers(this.db);
  }
  bootstrap(input: BootstrapInput) {
    return bootstrapFirstOwner(this.db, input);
  }
  findUserForLogin(email: string) {
    return findUserForLogin(this.db, email);
  }
  findLiveMembership(userId: string) {
    return findLiveMembership(this.db, userId);
  }
  findWorkspace(workspaceId: string) {
    return findWorkspace(this.db, workspaceId);
  }
  createWebSession(input: {
    id: string;
    userId: string;
    tokenHash: Uint8Array;
    ttlMs: number;
    userAgent: string | null;
  }) {
    return createWebSession(this.db, input);
  }
  resolveWebSession(tokenHash: Uint8Array) {
    return resolveWebSession(this.db, tokenHash);
  }
  renewWebSession(sessionId: string, ttlMs: number, renewAfterMs: number) {
    return renewWebSession(this.db, sessionId, ttlMs, renewAfterMs);
  }
  revokeWebSession(tokenHash: Uint8Array) {
    return revokeWebSession(this.db, tokenHash);
  }
}

// ---------------------------------------------------------------------------
// Tokens and passwords
// ---------------------------------------------------------------------------

// Same shape as API keys: a prefixed random token whose sha256 is stored.
export function generateWebSessionToken(): string {
  return `aps_${randomBytes(32).toString("base64url")}`;
}

export const hashWebSessionToken = hashApiKey;

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

let unknownUserHash: Promise<string> | undefined;
/**
 * Verify against a real hash even when there is no user, so a login for an
 * unknown email takes as long as one with a wrong password and the response
 * does not say which it was.
 */
export async function verifyPassword(
  password: string,
  storedHash: string | null,
): Promise<boolean> {
  if (storedHash === null) {
    unknownUserHash ??= hashPassword(randomBytes(16).toString("base64url"));
    await Bun.password.verify(password, await unknownUserHash);
    return false;
  }
  return Bun.password.verify(password, storedHash);
}

// ---------------------------------------------------------------------------
// Bootstrap token (Codex B10)
// ---------------------------------------------------------------------------

export interface BootstrapGate {
  /** True once, for the matching token; false afterwards and for any other. */
  consume(candidate: string): boolean;
  /** Undo a consume whose bootstrap did not complete. */
  release(): void;
}

export function createBootstrapGate(token: string): BootstrapGate {
  let pending: string | null = token;
  const expected = Buffer.from(token, "utf8");
  return {
    consume(candidate) {
      if (pending === null) return false;
      const given = Buffer.from(candidate, "utf8");
      if (
        given.length !== expected.length ||
        !timingSafeEqual(given, expected)
      ) {
        return false;
      }
      pending = null;
      return true;
    },
    release() {
      pending = token;
    },
  };
}

export function generateBootstrapToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Take the operator's token or mint one. A minted token is printed once, and
 * only while the install still needs it, so an established deployment that
 * forgot the variable does not print a secret nobody can use. It goes
 * through `print`, not the structured logger: that logger redacts any
 * `*token*` field on purpose, and this is the one value that must reach the
 * operator's terminal in the clear.
 */
export async function bootstrapGateFromEnv(
  value: string | undefined,
  store: Pick<IdentityStore, "countUsers">,
  logger: StructuredLogger,
  print: (line: string) => void = (line) => console.error(line),
): Promise<BootstrapGate> {
  if (value) {
    // The request schema bounds the token; a configured value outside it
    // could never be presented, which would leave the install impossible to
    // bootstrap with no error anywhere. Refuse to start instead.
    const parsed = bootstrapTokenSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(
        "BOOTSTRAP_TOKEN must be 32 to 256 characters (or unset to generate one)",
      );
    }
    return createBootstrapGate(parsed.data);
  }
  const token = generateBootstrapToken();
  if ((await store.countUsers()) === 0) {
    logger.warn(
      "BOOTSTRAP_TOKEN not set; a token for this process was printed to stderr",
    );
    print(`BOOTSTRAP_TOKEN=${token}`);
  }
  return createBootstrapGate(token);
}

// ---------------------------------------------------------------------------
// Login lockout
// ---------------------------------------------------------------------------

export const LOGIN_LOCKOUT_MAX_KEYS = 10_000;

/**
 * Per-email failure window, in process memory. Two replicas keep two
 * windows, so the effective limit is attempts × replicas; a shared store is
 * the trigger for moving this to the database. The map holds at most
 * `maxKeys` addresses: past that, the address whose failure was recorded
 * longest ago is dropped, so a spray of distinct emails costs the attacker
 * their own lockouts, not the process its memory.
 */
export class LoginLockout {
  // Map iteration is insertion order; a key is re-inserted on every failure
  // so the first key is always the least recently failed one.
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly options: {
      attempts?: number;
      windowMs?: number;
      maxKeys?: number;
      now?: () => number;
    } = {},
  ) {}

  private get attempts() {
    return this.options.attempts ?? LOGIN_LOCKOUT_ATTEMPTS;
  }
  private get windowMs() {
    return this.options.windowMs ?? LOGIN_LOCKOUT_WINDOW_MS;
  }
  private get maxKeys() {
    return this.options.maxKeys ?? LOGIN_LOCKOUT_MAX_KEYS;
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }

  get size(): number {
    return this.failures.size;
  }

  private live(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const kept = (this.failures.get(key) ?? []).filter((at) => at > cutoff);
    if (kept.length === 0) {
      this.failures.delete(key);
    }
    return kept;
  }

  /** Milliseconds until the caller may try again, or 0 when not locked. */
  retryAfterMs(key: string): number {
    const live = this.live(key);
    if (live.length < this.attempts) return 0;
    const oldest = live[live.length - this.attempts] ?? this.now();
    return Math.max(1, oldest + this.windowMs - this.now());
  }

  recordFailure(key: string): void {
    const live = this.live(key);
    live.push(this.now());
    // Only the last `attempts` stamps can ever matter to retryAfterMs.
    const kept = live.slice(-this.attempts);
    this.failures.delete(key);
    if (this.failures.size >= this.maxKeys) {
      const eldest = this.failures.keys().next().value;
      if (eldest !== undefined) {
        this.failures.delete(eldest);
      }
    }
    this.failures.set(key, kept);
  }

  clear(key: string): void {
    this.failures.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Principal resolution
// ---------------------------------------------------------------------------

export interface AuthenticatorOptions {
  authMode: string | undefined;
  keyStore: ApiKeyStore;
  // Absent: no cookie path, the app is API-key only as in alpha.
  identity?: IdentityStore;
}

export type Authenticated = {
  principal: Principal;
  /** Set on the cookie path; GET /v1/auth/me and logout read it. */
  webSession?: ResolvedWebSession;
  /** Re-runs the credential check; SSE calls it so revocation ends a stream. */
  reauthenticate: () => Promise<boolean>;
};

function bearerToken(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const match = /^Bearer ([^\s]+)$/.exec(value);
  return match?.[1] ?? null;
}

// Until 94S-132 returns scopes per key, an API key principal is the legacy
// owner lifted as contracts `authorizationContextFromLegacy` does.
export function legacyApiKeyPrincipal(ownerId: string): Principal {
  return {
    kind: "api_key",
    id: ownerId,
    owner_id: ownerId,
    workspace_id: null,
    scopes: [...SESSION_SCOPE_VALUES],
  };
}

/** The alpha partition key every existing route authorizes on. */
export function ownerIdOf(principal: Principal): string {
  return principal.kind === "user"
    ? principal.workspace_id
    : principal.owner_id;
}

export interface Authenticator {
  authenticate(context: Context): Promise<Authenticated | null>;
}

export function createAuthenticator(
  options: AuthenticatorOptions,
): Authenticator {
  const { authMode, keyStore, identity } = options;
  return {
    async authenticate(context: Context) {
      if (authMode === "none") {
        const ownerId = context.req.header("X-Owner-Id")?.trim() || null;
        return ownerId
          ? {
              principal: legacyApiKeyPrincipal(ownerId),
              reauthenticate: async () => true,
            }
          : null;
      }
      const token = bearerToken(context.req.header("Authorization"));
      if (token) {
        const keyHash = hashApiKey(token);
        const ownerId = await keyStore.findOwner(keyHash);
        return ownerId
          ? {
              principal: legacyApiKeyPrincipal(ownerId),
              reauthenticate: async () =>
                (await keyStore.findOwner(keyHash)) === ownerId,
            }
          : null;
      }
      if (!identity) {
        return null;
      }
      const cookie = getCookie(context, WEB_SESSION_COOKIE_NAME);
      if (!cookie) {
        return null;
      }
      const tokenHash = hashWebSessionToken(cookie);
      const session = await identity.resolveWebSession(tokenHash);
      if (!session) {
        return null;
      }
      // A long-lived response re-checks the same session: logout, expiry, a
      // disabled account or membership, or a role change all end it.
      const reauthenticate = async () => {
        const current = await identity.resolveWebSession(tokenHash);
        return (
          current !== null &&
          current.sessionId === session.sessionId &&
          current.workspaceId === session.workspaceId &&
          current.role === session.role
        );
      };
      await identity.renewWebSession(
        session.sessionId,
        WEB_SESSION_TTL_MS,
        WEB_SESSION_RENEW_AFTER_MS,
      );
      return {
        principal: {
          kind: "user",
          id: session.userId,
          workspace_id: session.workspaceId,
          role: session.role,
          scopes: [...scopesForRole(session.role)],
        },
        webSession: session,
        reauthenticate,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// CSRF (03 §3.2)
// ---------------------------------------------------------------------------

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Why a cookie-authenticated mutation is refused, or null. The custom header
 * cannot be sent cross-site without a CORS preflight the API never answers,
 * and the Origin check catches a same-site sibling that could. Bearer calls
 * are not subject to this: a key is not sent by the browser on its own.
 */
export function csrfViolation(
  context: Context,
  principal: Principal,
): string | null {
  if (principal.kind !== "user" || SAFE_METHODS.has(context.req.method)) {
    return null;
  }
  if (context.req.header(CSRF_HEADER_NAME) !== CSRF_HEADER_VALUE) {
    return `${CSRF_HEADER_NAME} header is required`;
  }
  if (context.req.header("Sec-Fetch-Site") === "cross-site") {
    return "cross-site request";
  }
  const origin = context.req.header("Origin");
  if (origin && origin !== "null") {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return "malformed Origin";
    }
    if (originHost !== context.req.header("Host")) {
      return "Origin does not match Host";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cookie
// ---------------------------------------------------------------------------

export function setWebSessionCookie(
  context: Context,
  token: string,
  expiresAt: Date,
): void {
  setCookie(context, WEB_SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    expires: expiresAt,
  });
}

export function clearWebSessionCookie(context: Context): void {
  deleteCookie(context, WEB_SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
  });
}

export function webSessionCookie(context: Context): string | undefined {
  return getCookie(context, WEB_SESSION_COOKIE_NAME);
}
