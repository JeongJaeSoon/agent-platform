import {
  type ApiErrorCode,
  CSRF_HEADER_VALUE,
  type SessionScope,
} from "@agent-platform/contracts";

// Prose the OpenAPI generator (openapi.ts) assembles into the document. Every
// statement here describes behavior enforced elsewhere; change it with the code.

/** What the generator knows about an operation when it writes error text. */
export type ErrorContext = {
  scope: SessionScope | undefined;
  // "public": no credential; "session": a cookie session only.
  auth: "public" | "session" | "any";
  // "always": every caller sends the CSRF header (login). "cookie": only a
  // cookie-authenticated caller does (every cookie mutation).
  csrf: "always" | "cookie" | "none";
  idempotencyKey: boolean;
  lastEventId: boolean;
  body: boolean;
  query: boolean;
};

export const API_INFO_DESCRIPTION = `Private alpha session control plane. This document is generated from the route declarations in apps/control-host/src/api/openapi.ts and the Zod schemas in packages/contracts; do not edit it by hand.

## Authentication

Send an API key as an HTTP bearer token, \`Bearer <key>\` (\`bearerApiKey\`), or use the browser session cookie that \`POST /v1/auth/login\` sets (\`cookieSession\`). A missing, malformed, unknown or revoked credential answers \`401 UNAUTHORIZED\`. \`/healthz\`, \`/readyz\`, \`/v1/openapi.json\`, \`/v1/auth/bootstrap\` and \`/v1/auth/login\` take no credential.

A cookie-authenticated request with any method other than GET must also send \`X-Requested-With: ${CSRF_HEADER_VALUE}\` and must not be cross-site (\`Sec-Fetch-Site\`, \`Origin\`); otherwise it answers \`403 FORBIDDEN\`. API-key requests never need that header.

## Scopes

Each operation names the one scope it requires, in its description and in its \`security\` requirement:

- \`sessions:read\`: read sessions, turns, events, pending requests, usage, limits and receipts.
- \`sessions:write\`: create sessions and send messages.
- \`sessions:approve\`: answer pending permission and question requests.
- \`sessions:control\`: interrupt, pause, resume and terminate.
- \`sessions:recover\`: record recovery decisions.

What a credential holds:

- An API key holds exactly the scopes it was issued with (\`--scopes\`). A key issued before scopes existed holds none and must be reissued.
- A cookie session holds the scopes of the user's workspace role: \`owner\` holds all five, \`member\` all but \`sessions:recover\`.
- A credential without the required scope answers \`403 FORBIDDEN\` before the body or the resource is read.

## Idempotency

Every command (POST) except bootstrap, login and logout requires an \`Idempotency-Key\` header of 1–255 characters; a missing or invalid key answers \`400 BAD_REQUEST\`. The key is scoped to the caller, the operation and the target resource. Retrying with the same key and the same body returns the original status and body without running the command again; the same key with a different body answers \`409 IDEMPOTENCY_CONFLICT\`. After a timeout or a lost response, retry with the same key rather than a new one. Bootstrap, login and logout ignore the header.

## Errors

Every error answers \`application/json\` with \`{"error": {"code", "message", "retryable", "request_id", "details"}}\` (\`ApiErrorResponse\`). Branch on \`code\`, not on \`message\`. \`retryable: true\` means the same request may succeed later unchanged (\`REQUEST_TIMEOUT\`, \`RATE_LIMITED\`, \`BACKEND_UNAVAILABLE\`, \`NOT_READY\`). Each response below lists its codes and when each one happens.

## Response headers

- \`X-Request-Id\`: on every response, a fresh id for this request; an error's \`request_id\` is the same value. Quote it when reporting a problem.
- \`Retry-After\`: seconds to wait, on \`429 RATE_LIMITED\` and on \`503 BACKEND_UNAVAILABLE\`.`;

export const SECURITY_SCHEME_DESCRIPTIONS = {
  bearerApiKey:
    "An API key sent as an HTTP bearer token, `Bearer <key>`. It holds exactly the scopes it was issued with; a key issued before scopes existed holds none.",
  cookieSession:
    "The browser session cookie set by `POST /v1/auth/login`. It holds the scopes of the user's workspace role (`owner`: all; `member`: all but `sessions:recover`). Requests other than GET must also send `X-Requested-With: agent-platform-web`.",
} as const;

export const IDEMPOTENCY_KEY_DESCRIPTION =
  "Required, 1–255 characters; a UUID per user intent works. A retry with the same key and the same body returns the original response and runs the command once; the same key with a different body answers `409 IDEMPOTENCY_CONFLICT`. A missing or invalid key answers `400 BAD_REQUEST`, after the body is read.";

export const LAST_EVENT_ID_DESCRIPTION =
  "The `id` of the last complete event received. Replay resumes strictly after it; omit it (or send it empty) to replay from the start. A malformed value answers `400 BAD_REQUEST`.";

export const RESPONSE_HEADERS = {
  RequestId: {
    description:
      "A fresh id for this request, on every response; an error body's `request_id` carries the same value.",
    schema: { type: "string", format: "uuid" },
  },
  RetryAfter: {
    description: "Seconds to wait before sending the same request again.",
    schema: { type: "integer", minimum: 1 },
  },
} as const;

type When = string | ((context: ErrorContext) => string);

function badRequest(context: ErrorContext): string {
  const causes = [
    context.body && "the body is not JSON or does not match the request schema",
    context.query && "a query parameter or the page cursor is invalid",
    context.idempotencyKey &&
      "the `Idempotency-Key` header is missing, empty or longer than 255 characters",
    context.lastEventId && "`Last-Event-ID` is malformed",
  ].filter(Boolean);
  return `The request is malformed: ${causes.join("; ")}. Fix the request before retrying.`;
}

function forbidden(context: ErrorContext): string {
  const causes: string[] = [];
  if (context.csrf === "always") {
    causes.push(
      `The request lacks \`X-Requested-With: ${CSRF_HEADER_VALUE}\` or is cross-site (\`Sec-Fetch-Site\`, \`Origin\`); every caller must send the header`,
    );
  } else if (context.csrf === "cookie") {
    causes.push(
      `CSRF: a cookie-authenticated request lacks \`X-Requested-With: ${CSRF_HEADER_VALUE}\` or is cross-site (\`Sec-Fetch-Site\`, \`Origin\`); API-key requests never need the header`,
    );
  }
  if (context.auth === "session") {
    causes.push(
      "Credential: an API key was sent; this operation takes a cookie session only",
      "Permission: where the description names who may call it, the signed-in member is not one of them",
    );
  }
  if (context.scope) {
    causes.push(
      `Scope: the credential does not hold \`${context.scope}\`, checked before the body or the resource is read`,
    );
  }
  return `${causes.join(". ")}.`;
}

/** When each code happens, as the API produces it on any operation. */
export const ERROR_CODE_WHEN: Partial<Record<ApiErrorCode, When>> = {
  BAD_REQUEST: badRequest,
  UNAUTHORIZED: (context) =>
    context.auth === "public"
      ? "The submitted credentials were rejected."
      : "No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie.",
  FORBIDDEN: forbidden,
  NOT_FOUND:
    "The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists.",
  REQUEST_TIMEOUT:
    "The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`).",
  PAYLOAD_TOO_LARGE:
    "The body is larger than 64 KiB, or `message` is longer than 32 KiB of UTF-8.",
  STORAGE_LIMIT_EXCEEDED:
    "Accepting this message would exceed the installation's storage limit (`GET /v1/limits`). Retrying does not free space.",
  UNSUPPORTED_CAPABILITY:
    "This installation or the session's runtime cannot serve the request.",
  RATE_LIMITED: "Too many requests; wait for `Retry-After` and retry.",
  BACKEND_UNAVAILABLE:
    "Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`.",
  NOT_READY:
    "A readiness check failed; `error.details.check` names it (`database`, `schema` or `config`).",
  CURSOR_EXPIRED:
    "The cursor fell outside retained history; reread the resource state and start a new stream. Reserved: alpha does not trim events.",
  IDEMPOTENCY_CONFLICT:
    "This `Idempotency-Key` was already used for this operation and resource with a different body. Use a new key for a new intent.",
  BOOTSTRAP_DONE: "An owner already exists; bootstrap runs once.",
  REVISION_CONFLICT:
    "`expected_revision` is not the session's current `revision`. Reread the session, check the intent still holds, and retry with the new revision.",
  SESSION_PAUSED: "The session is pausing or paused; resume it first.",
  SESSION_RESUMING: "The session is resuming; wait for the resume receipt.",
  SESSION_STOPPED: "The session is stopping or stopped; resume it first.",
  SESSION_CLOSED: "The session is closed and accepts no further commands.",
  RECOVERY_REQUIRED:
    "The session needs a recovery decision first (`POST /v1/sessions/{id}/recovery-decisions`).",
  CHECKPOINT_UNAVAILABLE:
    "The session has no committed checkpoint that can serve this request.",
  REQUEST_EXPIRED:
    "The pending request was already answered, expired or closed.",
  REQUEST_STALE: "The request was made against state that has since moved on.",
  TURN_NOT_STARTED:
    "The target turn is still queued; there is nothing to interrupt yet.",
  PAUSE_COMMITTING:
    "The pause has already committed its stop and can no longer be cancelled; wait for it, then resume.",
  TAKEOVER_REQUIRED:
    "The person who asked for the session was offboarded; it takes no input until an owner takes it over.",
  ALREADY_EXISTS:
    "A resource with the same identity already exists; the operation names which field must be unique.",
  INVITE_USED: "The invite was already accepted and cannot be used again.",
  INVITE_EXPIRED:
    "The invite was revoked, replaced by a newer one, or has expired. Ask for a new invite.",
  LAST_OWNER: "The change would leave the workspace with no live owner.",
  OWNER_PROTECTED:
    "Only an owner may grant the owner role or change an owner's membership.",
  SCOPE_NOT_GRANTABLE:
    "The key asks for a scope its issuer does not hold now, or an agent's key asks for `sessions:approve`.",
  SLACK_NOT_INSTALLED:
    "The workspace has no verified Slack install for this team.",
  LINK_TEAM_MISMATCH:
    "The Slack account belongs to another Slack team than the workspace's install.",
  LINK_TAKEN: "The Slack account is already linked to another person.",
  LINK_EXISTS:
    "The caller already linked a different Slack account in this team; unlink it first.",
  AGENT_IDENTITY_TAKEN:
    "The Slack app and team are already pinned to another agent; revoke that identity first.",
  CREDENTIAL_REF_IN_USE:
    "The credential name is already held by an agent identity, or bound to an agent an identity would take it from.",
  RELEASE_PROFILE_MISMATCH:
    "The release was made for another runtime profile than the one named.",
  CREDENTIAL_UNBOUND:
    "The release names a credential its agent has no live binding for; an agent admin must bind it first.",
  PROFILE_DIGEST_MISMATCH:
    "The runtime profile's settings changed since the release was made; release the agent again.",
  LOGIN_LINK_REQUIRED:
    "The verified address already has an account. It is never joined by email: sign in with the existing account and link the external login there.",
};

function when(
  code: ApiErrorCode,
  context: ErrorContext,
  notes: Partial<Record<ApiErrorCode, string>> | undefined,
): string {
  const generic = ERROR_CODE_WHEN[code];
  if (!generic) throw new Error(`No ERROR_CODE_WHEN entry for ${code}`);
  const text = typeof generic === "string" ? generic : generic(context);
  const note = notes?.[code];
  return note ? `${text} ${note}` : text;
}

/**
 * One line per code: when that code is the answer. A note narrows the shared
 * sentence for one operation; it is appended, never a replacement.
 */
export function errorResponseDescription(
  codes: readonly ApiErrorCode[],
  context: ErrorContext,
  notes?: Partial<Record<ApiErrorCode, string>>,
): string {
  return codes
    .map((code) => `- \`${code}\`: ${when(code, context, notes)}`)
    .join("\n");
}

/** Who may call the operation and how it treats Idempotency-Key. */
export function accessNote(
  context: ErrorContext,
  method: "get" | "post" | "patch" | "delete",
): string {
  const who = context.scope
    ? `**Scope:** \`${context.scope}\` (API key or cookie session).`
    : context.auth === "session"
      ? "**Auth:** cookie session only; no scope."
      : "**Auth:** public; no credential.";
  if (method === "get") return who;
  return `${who} **Idempotency-Key:** ${context.idempotencyKey ? "required" : "ignored"}.`;
}
