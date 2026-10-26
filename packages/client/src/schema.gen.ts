// Generated from docs/openapi.json by `bun run --cwd packages/client api:generate`.
// Do not edit by hand.

export interface paths {
    "/healthz": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Process liveness
         * @description Answers 200 while the process serves HTTP; it checks nothing else, not even the database. Use it as a liveness probe, and `/readyz` to decide whether to send traffic.
         *
         *     **Auth:** public; no credential.
         */
        get: operations["getHealth"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/readyz": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * DB, schema and config readiness
         * @description Runs the readiness checks in order and stops at the first failure: `database` (the database answers), `schema` (the applied migrations include every migration of this build) and `config` (required settings and limits are valid). Use it as a readiness probe: a 503 means do not route traffic here. The execution backend is not checked. From the moment the process starts shutting down it answers 503 too.
         *
         *     **Auth:** public; no credential.
         */
        get: operations["getReady"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/openapi.json": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Generated OpenAPI document
         * @description This document as JSON, the same content as `docs/openapi.json` in the repository.
         *
         *     **Auth:** public; no credential.
         */
        get: operations["getOpenApiDocument"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Check a credential and return its owner
         * @description Checks a credential: answers 200 with the owner it authenticates as, or 401. It changes nothing; use it to test an API key before other calls.
         *
         *     **Scope:** `sessions:read` (API key or cookie session).
         */
        get: operations["getApiRoot"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/bootstrap": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create the first owner and default workspace, or recover an owner
         * @description Allowed only while no live owner exists (an owner whose account or membership is disabled is not live). On an installation that already has users it adds or restores the owner in the existing workspace, ignores workspace_name and workspace_slug, revokes every web session in the workspace and writes a `recover_owner` receipt. Each BOOTSTRAP_TOKEN works once per installation; a token presented while a live owner exists is spent. A wrong or spent token answers 401 before the owner state is looked at.
         *
         *     **Auth:** public; no credential. **Idempotency-Key:** ignored.
         */
        post: operations["bootstrap"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/login-methods": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * How a person can sign in on this installation
         * @description `password` always; `google` when Google sign-in is configured. The login page offers these.
         *
         *     **Auth:** public; no credential.
         */
        get: operations["listLoginMethods"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Email/password login; sets the session cookie
         * @description Checks an email and password and starts a browser session: the response sets the `__Host-ap_session` cookie (HttpOnly, Secure, SameSite=Lax) for 14 days, and the expiry slides forward while the session is used. A user keeps at most 10 live sessions; a new login drops the oldest. This is for the web app; scripts and servers use an API key.
         *
         *     **Auth:** public; no credential. **Idempotency-Key:** ignored.
         */
        post: operations["login"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/google/start": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Begin Google sign-in; answers the Google URL to open
         * @description Sets a short-lived cookie that binds the flow (state, nonce, PKCE verifier) to this browser. 404 when Google sign-in is not configured.
         *
         *     **Auth:** public; no credential. **Idempotency-Key:** ignored.
         */
        post: operations["startGoogleLogin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/google/callback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Finish Google sign-in; sets the session cookie
         * @description Posts the `code` and `state` Google returned to the redirect URI. The first matching rule decides: an already linked Google account signs in as its user; an address that already has an account answers 409 LOGIN_LINK_REQUIRED and is never joined by email; otherwise a live invite for the address, or JIT for an allowed domain, creates the account. Anything else answers 401 without saying whether an account exists. A Google account outside the allowed domains answers 403.
         *
         *     **Auth:** public; no credential. **Idempotency-Key:** ignored.
         */
        post: operations["googleLoginCallback"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/password-reset": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Set a new password with a one-time reset link
         * @description Spends the token, sets the password, revokes every live web session of the user and writes a `reset_password` receipt. There is no failure window: the token cannot be guessed, and a shared one would let anyone lock recovery out. Password hashing shares login's concurrency limit, past which it answers 429.
         *
         *     **Auth:** public; no credential. **Idempotency-Key:** ignored.
         */
        post: operations["resetPassword"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/workspaces/{id}/members/{userId}/password-reset": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Issue a one-time password reset link for a member (owner only)
         * @description Requires the issuer's current password, counted against the issuer's login failure window. An owner cannot issue a link for themselves, nor for a member who owns another workspace. The token is returned once and expires in one hour; issuing another revokes the member's open link. Writes an `issue_password_reset` receipt whose result names the target's role.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        post: operations["issuePasswordReset"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/workspaces/{id}/audit-retention": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Set how many days authorization decisions are kept (owner only)
         * @description At least 30 days; the default is 90. Rows older than this are deleted by the reconciler. The current value is `workspace.settings.audit_retention_days` in GET /v1/auth/me.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        post: operations["setAuditRetention"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/workspaces/{id}/slack-guest": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Let Slack guests call agents, or stop them (owner or admin)
         * @description Off by default. While off, a Slack guest (`is_restricted`) who calls an agent is refused with `guest_disabled`; while on, a guest still has to link their Slack account. Slack Connect users from other organizations are refused either way. An app with Slack's agent features on is closed to guests by Slack itself. The current value is `workspace.settings.slack_guest_enabled` in GET /v1/auth/me.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        post: operations["setSlackGuest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/workspaces/{id}/slack/config-token": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Whether the Slack App Configuration Token is set (owner or admin)
         * @description Says whether a token is set, its last four characters, when it was last set and by whom, when the current access token expires and which Slack user issued it. `state` is `unset`, `active`, or `needs_reentry` when Slack no longer takes the stored token or a rotation's answer was lost: paste a new one. The token itself is never returned. API keys are refused.
         *
         *     **Auth:** cookie session only; no scope.
         */
        get: operations["getSlackConfigToken"];
        /**
         * Set or replace the Slack App Configuration Token (owner or admin)
         * @description Paste the refresh token from api.slack.com/apps. It is rotated with Slack at once (`tooling.tokens.rotate`), which proves Slack takes it; the new access and refresh tokens are stored encrypted together and the pasted one is spent. A token Slack refuses changes nothing stored (409 CONFIG_TOKEN_INVALID, `rejected`). When the token belongs to another Slack user than before, `warnings` says so: that user becomes the collaborator of every app made from now on. The response and the `set_slack_secret` receipt carry the last four characters only, and the value is in no log or error. API keys are refused.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        put: operations["putSlackConfigToken"];
        post?: never;
        /**
         * Delete the Slack App Configuration Token (owner or admin)
         * @description Deletes the stored token and writes a `delete_slack_secret` receipt with its last four characters. 404 when none is set. API keys are refused.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        delete: operations["deleteSlackConfigToken"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/workspaces/{id}/slack/apps/{app_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Delete one of the workspace's Slack apps in Slack
         * @description Deletes the app in Slack (`apps.manifest.delete` with the config token) and its stored secrets; the row stays as `deleted`. Only an app recorded in this workspace's Slack apps can be named. An agent's app takes an owner, an admin or that agent's admin; any other app an owner or admin. An app Slack no longer has counts as deleted. One still being created answers 409 SLACK_APP_CREATING. API keys are refused.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        delete: operations["deleteSlackApp"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/workspaces/{id}/slack/apps/{app_id}/secrets/{purpose}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Set a secret of a Slack app made by hand (owner or admin)
         * @description `purpose` is `slack_signing_secret`, `slack_client_secret` or `slack_bot_token`. Only an app of kind `manual` takes values from a person: the platform writes the secrets of the apps it created (403 `server_managed_secret`), since whoever knew an app's signing secret could sign events as Slack. The value is stored encrypted under the app; the response and the `set_slack_secret` receipt carry its last four characters only. API keys are refused.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        put: operations["putSlackAppSecret"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/logout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Revoke the session cookie
         * @description Revokes the cookie session that sent the request and clears the cookie. The user's other sessions stay signed in.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        post: operations["logout"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The authenticated principal, user and workspace
         * @description Says who the credential authenticates as and what it may do: the principal with its scopes, the workspace, and for a cookie session the user and the management actions its role holds (`permissions`). An API key has no user, so `user` is null and `permissions` is empty; `workspace` is the key's workspace, or null for a legacy key that predates workspaces. The web app boots from this. It changes nothing.
         *
         *     **Scope:** `sessions:read` (API key or cookie session).
         */
        get: operations["getAuthMe"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List the owner's sessions, newest first
         * @description Lists the sessions of the credential's owner that the caller can read, newest `created_at` first, closed ones included, `limit` per page (default 50, at most 100). Pass `next_cursor` back as `cursor` for the next page; it is null on the last one. `status` keeps only sessions reporting that status, `needs_input` included; `relation` keeps the ones the caller started, was shared or administers the agent of; `q` searches titles and id prefixes; `agent_id` keeps the sessions of one agent, any of its releases. Every filter only narrows what the caller can read. It changes nothing.
         *
         *     **Scope:** `sessions:read` (API key or cookie session).
         */
        get: operations["listSessions"];
        put?: never;
        /**
         * Durably accept a session and its first input
         * @description Creates a session for a catalog profile and repository and queues `message` as turn `1`. Whether `repository_id` is sent follows the profile's `repository_mode` (`GET /v1/profiles`): `required` needs it, `none` refuses it, `optional` takes either; a session created without one starts in an empty workspace, has no repository to push to (`POST /v1/sessions/{id}/push-requests` answers 409 PUSH_SOURCE_MISSING) and its detail's `repository_id` is null. The 201 means the input is stored, not that it ran: follow the turn with `GET /v1/sessions/{id}/turns/{turn_id}` or the event stream. `model` picks one of the models the profile offers (its `model` or `models` in the catalog); omitted, the model of the release's card runs when `agent_release_id` is sent, else the profile's default. The session's detail reports it as `model`. The model stays until the session's profile is changed (`POST /v1/sessions/{id}/profile`), which runs the new profile's default. A session waits in `queued` while no execution slot is free; it is never refused for that. `agent_release_id` pins the session to that release of an agent, so a key bound to the agent may create it; `profile_id` must be the release's runtime profile (409 RELEASE_PROFILE_MISMATCH). The run itself follows `profile_id`. Every credential the release names must still be bound to its agent; otherwise 409 CREDENTIAL_UNBOUND, whose `details` carry the guidance to show the requester and the agent's admins to ask (`SessionCredentialUnboundDetails`), never the missing names. The receipt settles with turn `1`: `succeeded` when it completes, `failed` when it fails or is interrupted or cancelled, `unknown` when its outcome is unknown.
         *
         *     **Scope:** `sessions:write` (API key or cookie session). **Idempotency-Key:** required.
         */
        post: operations["createSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/counts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Count the sessions a list would return, per status
         * @description Counts, for each status, the sessions `GET /v1/sessions` would list with that `status` and the same `relation` and `q` when read to its last page; `total` is their sum. A session the caller cannot read is never counted. It changes nothing.
         *
         *     **Scope:** `sessions:read` (API key or cookie session).
         */
        get: operations["countSessions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Session detail with projection, execution and durability
         * @description Reads one session: its `admission_state` (whether it takes input and controls: `active`, `pausing`, `paused`, `resuming`, `stopping`, `stopped`, `recovery_required`, `closing`, `closed`), its `status`, the current `revision`, the execution as last observed, the number of pending requests, `attention` (why the session is held or slowed, if it is) and checkpoint `durability`. Read `revision` here and send it as `expected_revision` to pause, resume, close, terminate or decide recovery. `status: needs_input` and `attention` are computed on each read; reading changes nothing.
         *
         *     **Scope:** `sessions:read` (API key or cookie session).
         */
        get: operations["getSession"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Rename the session
         * @description Sets `title`, in any admission state; the session's `revision` does not change and no receipt is written. Allowed to the session's creator (for a session an API key made, that key), the workspace's owners and admins, and the admins of its agent; since the answer is the session's detail, a key also needs `sessions:read`. Anyone else the session is visible to, through its share, gets 403; anyone it is not visible to, 404. A changed title is a `status` event on the stream carrying `title`; naming the title the session already has writes none. Answers with the session as `GET /v1/sessions/{id}` reads it.
         *
         *     **Scope:** `sessions:write` (API key or cookie session). **Idempotency-Key:** ignored.
         */
        patch: operations["updateSession"];
        trace?: never;
    };
    "/v1/sessions/{id}/share": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Who sees the session
         * @description Readable by whoever sees the session. A session never re-shared reads `workspace` at revision 0.
         *
         *     **Scope:** `sessions:read` (API key or cookie session).
         */
        get: operations["getSessionShare"];
        put?: never;
        /**
         * Change who sees the session
         * @description `private` is the creator alone; `people` and `team` add the people or the current members of the teams named; `workspace` is every member. A person's session is changed only by its creator; a session an API key made, by owners, admins and the admins of its agent. Anyone else the session is visible to gets 403; anyone it is not visible to, 404. Open event streams that may no longer see the session end. Writes a `share_session` receipt unless the share was already as asked (`receipt_id` null).
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        post: operations["setSessionShare"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{id}/audit-read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Read a session outside its share, with a reason
         * @description Owners and admins. The session detail and a page of its turns, whatever the share; nothing on the session changes and no other action is opened by it. Every read is recorded with its `justification`.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        post: operations["auditReadSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Every session of the workspace, metadata only
         * @description Owners and admins. Who made each session, its agent release, state and share scope, newest first; no content, title or summary.
         *
         *     **Auth:** cookie session only; no scope.
         */
        get: operations["listAdminSessions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/sessions/{id}/terminate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Stop any session of the workspace, with a reason
         * @description Owners and admins, whatever the session's share. The `justification` is recorded with the decision and becomes the stop reason. Otherwise as `POST /v1/sessions/{id}/terminate`.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** required.
         */
        post: operations["adminTerminateSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/sessions/{id}/recovery-decisions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Decide recovery for any session of the workspace
         * @description Owners only, whatever the session's share. The decision's `reason` is the justification, recorded with the decision. Otherwise as `POST /v1/sessions/{id}/recovery-decisions`.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** required.
         */
        post: operations["adminDecideSessionRecovery"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{id}/usage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Estimated cost of a session and whether every turn reported it
         * @description Reads the session's estimated provider cost and token count over its lifetime, its cost and token limits, and its queued input against the per-session limit. The cost is the platform's estimate from the model calls it saw, not a bill. `cost.complete: false` means a turn is still open or ended without reporting, so the true total is unknown; do not read it as zero. `budget_exceeded: true` means either limit is reached: no new turn is dispatched, but input is still accepted and queued. It changes nothing.
         *
         *     **Scope:** `sessions:read` (API key or cookie session).
         */
        get: operations["getSessionUsage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{id}/outputs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Files the session left under out/ at its latest checkpoint
         * @description Lists the files under the workspace's `out/` directory as the session's latest committed checkpoint recorded them: `path` (relative to the workspace, starting with `out/`), `bytes` and `sha256`. A file over the output limits is listed with `omitted: too_large` and `sha256: null`; its bytes were not kept, so it cannot be downloaded. A file written after the latest checkpoint is not listed until the next one commits. A session with no committed checkpoint answers an empty list with `checkpoint_revision: null`. Download a listed file with `GET /v1/sessions/{id}/outputs/{path}`. Reading changes nothing.
         *
         *     **Scope:** `sessions:read` (API key or cookie session).
         */
        get: operations["listSessionOutputs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{id}/outputs/{path}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Download one file the session left under out/
         * @description Streams one file that `GET /v1/sessions/{id}/outputs` lists, as `application/octet-stream` with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`. `{path}` is the listed `path` exactly, percent-encoded as one path segment (`out/report.md` is `out%2Freport.md`). The bytes are the ones the checkpoint verified; if the store no longer holds them the transfer ends early with an error rather than completing with other bytes, so check the length (or `sha256`) of what arrived. A path the list does not name, a file listed with `omitted`, or a session with no committed checkpoint answers 404.
         *
         *     **Scope:** `sessions:read` (API key or cookie session).
         */
        get: operations["downloadSessionOutput"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{id}/messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Enqueue the next input after the current turn
         * @description Queues `message` as the session's next turn in the same engine conversation, after every turn already queued. Only an `active` session takes input; the other admission states answer the 409 codes below. The 202 means the input is stored under a new sequential `turn_id`, not that it ran: follow the turn with `GET /v1/sessions/{id}/turns/{turn_id}` or on the event stream. A session over its budget still queues input but runs no new turn (`attention.code: BUDGET_EXCEEDED`). The receipt settles with the turn: `succeeded` when it completes, `failed` when it fails or is interrupted or cancelled, `unknown` when its outcome is unknown.
         *
         *     **Scope:** `sessions:write` (API key or cookie session). **Idempotency-Key:** required.
         */
        post: operations["appendSessionMessage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{id}/turns": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Queued and finished turns
         * @description Lists the session's turns oldest first, in `turn_id` order: queued, running and finished, `limit` per page (default 50, at most 100). Pass `next_cursor` back as `cursor` for the next page; it is null on the last one. Items are summaries; read one turn for its result, usage and attempts. It changes nothing.
         *
         *     **Scope:** `sessions:read` (API key or cookie session).
         */
        get: operations["listSessionTurns"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{id}/turns/{turn_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Committed result of one turn
         * @description Reads one turn: its status, terminal reason, the engine's committed `result` and `usage`, and the worker attempts that ran it. This is the durable answer to whether a turn finished: `completed`, `failed`, `interrupted`, `cancelled` and `outcome_unknown` are terminal. `completed` means the engine ended the turn normally, not that the requested work is done. `result` and `usage` are null until the turn ends, and their shape is the runtime's. It changes nothing.
         *
         *     **Scope:** `sessions:read` (API key or cookie session).
         */
        get: operations["getSessionTurn"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{id}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Durable event replay and live stream (SSE)
         * @description Streams the session's events as Server-Sent Events: first the stored events after `Last-Event-ID` (all of them without it), then new ones as they are written. Each frame's `id` is its cursor, `event` its kind (`system`, `assistant`, `tool_use`, `tool_result`, `question`, `result`, `status`, `error`), and `data` a versioned envelope naming the session, turn and attempt. `question` events announce pending requests; `status` events report the session's status and, after a pause, resume, terminate or recovery decision, its `admission_state`. The stream does not end with a turn or the session: it stays open until the client disconnects, the credential is revoked, or the session's share stops covering the caller (the reconnect then answers 404). Reading changes nothing.
         *
         *     Reconnect after backoff with the last complete event id in `Last-Event-ID`; replay resumes strictly after that event. The stream sends a comment keepalive every 15 seconds. `410 CURSOR_EXPIRED` means the cursor fell outside retained history and the client must resynchronize from resource state; alpha does not trim events, so this response is reserved. A `result` event is engine output, not durable completion: confirm the turn with `GET /v1/sessions/{id}/turns/{turn_id}` and treat only `completed`, `failed`, `interrupted`, `cancelled`, or `outcome_unknown` as terminal.
         *
         *     **Scope:** `sessions:read` (API key or cookie session).
         */
        get: operations["streamSessionEvents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{id}/pending-requests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Open permission and question requests
         * @description Lists the permission and question requests the session's running turn waits on that a client can still answer: open, unexpired, and raised by the worker attempt that holds the turn, oldest first. A `permission` item names the `tool` and its `input`; a `question` item carries the questions and their option ids. Answer before `expires_at` with `POST /v1/sessions/{id}/answers`. New requests also arrive as `question` events on the event stream. It changes nothing.
         *
         *     **Scope:** `sessions:read` (API key or cookie session).
         */
        get: operations["listPendingRequests"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{id}/answers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Answer a pending permission or question request
         * @description Answers one pending request by `request_id`: a permission with `allow` or `deny` (a denial needs a `reason` the model can act on), a question with one answer per question, by option ids or free text where the question allows it. The answer is stored and the request closes at once: the pending list drops it and a `status` event ends the wait. The worker then hands the answer to the engine, and the receipt settles when it reports: `succeeded` once delivered, `failed` if the request expired (`REQUEST_EXPIRED`) or was cancelled (`REQUEST_STALE`) first, `unknown` if the execution ended before it reported. Seeing a session is not answering for it: only its creator (for a session an API key made, that key), its agent's admins and the workspace's owners and admins answer. Anyone else the session is visible to gets 403 (`reason_code: role`) and the request stays open; anyone it is not visible to, 404.
         *
         *     **Scope:** `sessions:approve` (API key or cookie session). **Idempotency-Key:** required.
         */
        post: operations["answerPendingRequest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{id}/push-requests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List the session's push requests
         * @description Every push request of the session, newest first, with its state and who requested and decided it.
         *
         *     **Scope:** `sessions:read` (API key or cookie session).
         */
        get: operations["listPushRequests"];
        put?: never;
        /**
         * Ask for the session's latest checkpoint to be pushed
         * @description Pins the session's latest committed checkpoint: its `checkpoint_revision`, the `git_commit` its verified manifest names, the session's `repository_id`, and the target branch `agent/<session-id>`. None of these can be chosen: the body is `{}`. The request starts `requested` and nothing is pushed until a holder of `sessions:approve` approves it (`POST .../push-requests/{push_request_id}/decision`); the push itself is the platform's, never the worker's.
         *
         *     A session has at most one open request (`requested`, `approved` or `pushing`). Every attempt, refused ones included, leaves a `request_push` receipt; a refusal's `error.details.receipt_id` names it. A replayed Idempotency-Key answers the request it created.
         *
         *     **Scope:** `sessions:write` (API key or cookie session). **Idempotency-Key:** required.
         */
        post: operations["createPushRequest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{id}/push-requests/{push_request_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read one push request
         * @description One push request: what it pinned, its state (`requested`, `approved`, `rejected`, then `pushing`, `pushed` or `failed` once the platform pushes an approved one), and who decided it.
         *
         *     The API pushes an approved request within seconds: exactly the pinned commit, to `refs/heads/agent/<session-id>` on the repository the request pinned, never by force. It refuses, as `failed`, when the catalog entry for the repository changed after the request, the target is the repository's default branch, or the remote branch holds a commit the pinned one does not build on. `finished_at` and `push_receipt_id` are set once it ends; that `push` receipt (`GET /v1/receipts/{receipt_id}`) names the remote, the ref, the commit it replaced, the approver, and on failure the `refusal`.
         *
         *     **Scope:** `sessions:read` (API key or cookie session).
         */
        get: operations["getPushRequest"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{id}/push-requests/{push_request_id}/decision": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Approve or reject a push request
         * @description Decides a `requested` push request once: `approve` lets the platform push the pinned commit to the request's branch, `reject` closes it. `git_commit` must be the commit the decider reviewed; an approval naming any other is refused. An approval is also refused when the session has checkpointed since the request was made, so what is approved is what the session last committed; reject the request and ask again.
         *
         *     Only a verified credential that holds `sessions:approve` decides: an API key or a signed-in user. Worker credentials are not accepted on `/v1` at all (401). Every attempt, refused ones included, leaves a `decide_push` receipt carrying the actor, the verdict and the refusal reason; a refusal's `error.details.receipt_id` names it. A replayed Idempotency-Key answers the request this decision made, as it is now: once the platform has taken it to push, `state` reads `pushing`, `pushed` or `failed`, while `decided_by`, `decided_at` and `decision_receipt_id` still name this decision.
         *
         *     **Scope:** `sessions:approve` (API key or cookie session). **Idempotency-Key:** required.
         */
        post: operations["decidePushRequest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{id}/push-requests/{push_request_id}/pull-request": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Open a pull request from a pushed request
         * @description Opens a pull request on the repository's forge (GitHub or GHES) from the request's branch `agent/<session-id>` into the catalog entry's `branch`. Only a `pushed` request opens one, and only while the catalog entry is still the one the request pinned. The platform calls GitHub with its own credential: an installation token of the catalog's GitHub App, scoped to this repository and `pull_requests: write`, or the entry's PAT.
         *
         *     `title` (default `Agent session <session-id>`) and `body` are cleaned before GitHub sees them: `@` mentions, cross-repository references (`owner/repo#N`), closing keywords (`Closes #N` and the like) and HTML comments are broken with a zero-width space, a line that looks like a secret is replaced by `[REDACTED]`, and both are cut to GitHub's limits. The body ends with a line naming the session and the commit. The platform never approves, merges or asks for reviews.
         *
         *     Safe to retry: a request opens at most one pull request. When one is already recorded, or GitHub already has an open one for the branch, it is answered with `created: false` (200). Every attempt, refused ones included, leaves an `open_pull_request` receipt; `receipt_id` names this one, and a refusal's `error.details.receipt_id` names it.
         *
         *     Only a verified credential that holds `sessions:approve` opens one: an API key or a signed-in user, as for a push decision. Worker credentials are not accepted on `/v1` (401).
         *
         *     **Scope:** `sessions:approve` (API key or cookie session). **Idempotency-Key:** ignored.
         */
        post: operations["openPullRequest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{id}/push-requests/{push_request_id}/pull-request/comments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Post or update a comment on the pull request
         * @description Posts a comment on the pull request opened from this push request, or edits the one posted before with the same `marker` (default `status`), so a progress note is updated in place instead of piling up. The comment carries a hidden line `<!-- agent-platform:<session-id>:<marker> -->` that finds it again. `body` is cleaned the same way as a pull request body.
         *
         *     Every attempt, refused ones included, leaves a `comment_pull_request` receipt with the actor, the pull request, the comment id and `created`. The same credentials as opening the pull request are needed.
         *
         *     **Scope:** `sessions:approve` (API key or cookie session). **Idempotency-Key:** ignored.
         */
        post: operations["commentPullRequest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{id}/interrupt": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Interrupt the targeted turn only
         * @description Asks the worker to stop turn `target_turn_id` while it runs; the session's admission state and its other turns are left alone. The event stream shows a `status` event with phase `interrupting` when the worker takes the request and `engine_stopped` when the engine has stopped the turn; the turn reads `interrupted` once its checkpoint commits. If the turn has not ended 60 seconds after acceptance, its execution is killed.
         *
         *     Accepted while the turn runs: the receipt settles when the turn ends, with a result of `{turn_id, terminal, no_op}`. A new request for a turn that has already ended answers `receipt_status: succeeded` at once, and its receipt says `no_op: true` with the terminal the turn reached on its own: the interrupt did nothing. An interrupt accepted while the turn ran is `no_op: true` too when the turn got to another terminal first; when the turn's outcome is unknown, so is the receipt (`status: unknown`, `no_op: false`). A replayed Idempotency-Key answers the receipt's current status instead.
         *
         *     **Scope:** `sessions:control` (API key or cookie session). **Idempotency-Key:** required.
         */
        post: operations["interruptSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{id}/pause": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Drain the current turn, checkpoint, stop the execution
         * @description Pauses an `active` session so it holds no worker: the running turn, if any, is drained, its checkpoint commits and the execution stops. Queued input is kept and runs after a resume. The session goes `pausing` and the receipt stays `accepted` until the execution is observed gone; then the session is `paused` and the receipt `succeeded` with result `{resulting_admission_state, checkpoint_revision, queued_turn_count}`. A session with no execution goes `paused` at once. A drain that takes over 60 seconds shows `attention.code: PAUSE_BLOCKED` with the reason; nothing is killed for it, and terminating is the caller's choice. The receipt fails if the pause cannot commit, a resume cancels it, or a terminate overtakes it. Each step is a `status` event with `admission_state` on the stream.
         *
         *     **Scope:** `sessions:control` (API key or cookie session). **Idempotency-Key:** required.
         */
        post: operations["pauseSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{id}/close": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Finish the session: drain, checkpoint, close for good
         * @description Ends a session whose work is done. Unlike terminate, nothing is killed: the running turn finishes, its checkpoint commits, and the session ends `closed`, which nothing reopens. Unlike a recovery close (`POST /v1/sessions/{id}/recovery-decisions`, `decision: close`), it is the owner's call on a healthy session, needs `sessions:control` rather than `sessions:recover`, and its receipt operation is `close` rather than `recovery_decision`. `docs/api-guide.md` compares the three.
         *
         *     - **`active` with a live worker:** the worker drains as for a pause and the session goes `closing`. The receipt stays `accepted` until the execution is observed gone with a checkpoint covering every turn that ran; then the session is `closed` and the receipt `succeeded`. A drain over 60 seconds shows `attention.code: CLOSE_BLOCKED` with the reason; nothing is killed for it. An open question or approval holds the close until it is answered or the turn interrupted. If the drain cannot commit, the receipt fails and the session goes back to `active` (or `recovery_required` for a turn whose outcome is unknown), with its queued input intact; a terminate overtakes it (`CONTROL_SUPERSEDED`).
         *     - **`active` with no live worker, `paused`, or a `stopped` session that can be resumed:** closed in this request. With an execution still bound the receipt is `accepted` until it is observed gone; otherwise `succeeded` in the response.
         *
         *     Queued input is cancelled in the transaction that closes the session (each input's receipt fails with `SESSION_CLOSED`). Push requests are left alone; request a push of the result after the close has succeeded, since a push requested inside the last turn is refused `CHECKPOINT_MOVED` once the close commits that turn's checkpoint. The receipt result is `{resulting_admission_state, checkpoint_revision, cancelled_turn_count}`. The stream carries a `status` event for `closing` and for `closed`, and a `system` event `{subtype: session_closed, closed_by: close, close_receipt_id, checkpoint_revision, cancelled_turn_count}`. A caller closing its own session from inside a turn must not wait on the receipt: the drain waits for that turn to end. After the close, messages and controls answer `409 SESSION_CLOSED`.
         *
         *     **Scope:** `sessions:control` (API key or cookie session). **Idempotency-Key:** required.
         */
        post: operations["closeSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{id}/terminate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Block dispatch and force the execution down
         * @description Stops the session by force, in any admission state but `closed`: dispatch is blocked, queued input is cancelled (each input's receipt fails with `SESSION_STOPPED`), open requests close and the execution is killed. The session goes `stopping` until the kill is observed, then `stopped`; with nothing to kill it is `stopped` at once and the receipt is `succeeded` in the response. A `recovery_required` session keeps that state. A turn the kill cut short may end `outcome_unknown`, which holds the session in `recovery_required` until `POST /v1/sessions/{id}/recovery-decisions`. The kill reverts nothing the execution already did outside (commits, pushes, API calls): the response and the receipt say `external_effects_reverted: false`. The receipt result is `{execution_gone, checkpoint_revision, unconfirmed_turn_id, external_effects_reverted}`. Resume a `stopped` session from its last checkpoint with `POST /v1/sessions/{id}/resume`. A pause or close still draining is overtaken: its receipt fails with `CONTROL_SUPERSEDED`. To end a session whose work is done, close it instead (`POST /v1/sessions/{id}/close`).
         *
         *     **Scope:** `sessions:control` (API key or cookie session). **Idempotency-Key:** required.
         */
        post: operations["terminateSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{id}/profile": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Run the session's next turns on another profile
         * @description Moves an `active`, `paused` or `stopped` session onto `profile_id`, a profile this host's catalog allows with the session's repository, or, for a session created without one, a profile whose `repository_mode` is `optional` or `none`. It takes effect at the next turn that starts: a turn running now finishes on the profile it started with, and its worker then leaves so the next one claims the new profile and restores the session's checkpoint, conversation included. The session then runs the new profile's default `model`, whatever `model` it was created with. Earlier turns keep their record and cost; each turn's `attempts[].profile_id` says what it ran on.
         *
         *     The new profile must run the same runtime kind and version, since the next worker restores checkpoints that runtime took, and must be billed the same way (`billing: none` or not), since the session's cost limit stays as it is. A session created from an agent release runs the release's profile and answers `409 RELEASE_PROFILE_MISMATCH`. The change settles in the request: the receipt is `succeeded` with result `{previous_profile_id, profile_id}`, and a `status` event on the stream carries both. Naming the profile the session already runs changes nothing and still answers `succeeded`.
         *
         *     **Scope:** `sessions:control` (API key or cookie session). **Idempotency-Key:** required.
         */
        post: operations["changeSessionProfile"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{id}/resume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Restore from the last committed checkpoint or cancel a pause
         * @description Brings a `stopped` or `paused` session back to `active`, or cancels a pause that is still draining. The receipt result is `{resulting_admission_state, checkpoint_revision, queued_turn_count}`.
         *
         *     - **From `stopped`:** the session is `active` at once, the next worker restores the last committed checkpoint, queued input is dispatched, and the receipt is `succeeded` in the response.
         *     - **From `paused`:** the session goes `resuming` and a new worker restores the pause's checkpoint. The receipt stays `accepted` until that worker reports ready; then the session is `active` and the receipt `succeeded`. If the restore keeps failing, the receipt fails and the session goes `recovery_required`.
         *     - **From `pausing`, before the stop is committed:** the pause is cancelled (its receipt fails), the session is `active` again, and this receipt is `succeeded`. Once the stop is committed the answer is `409 PAUSE_COMMITTING`.
         *
         *     Each change is a `status` event with `admission_state` on the stream.
         *
         *     **Scope:** `sessions:control` (API key or cookie session). **Idempotency-Key:** required.
         */
        post: operations["resumeSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{id}/recovery-decisions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Operator decision for an unknown outcome or a context no checkpoint covers
         * @description Records an operator's decision where the platform will not guess: a turn whose outcome is unknown, or context no checkpoint covers. Nothing the execution did outside is reverted.
         *
         *     - `abandon`: the `outcome_unknown` turn `target_turn_id` becomes `cancelled` and its input receipt fails; the session is `stopped`.
         *     - `confirm_completed`: with `evidence_ref`, the turn becomes `completed` and its input receipt succeeds; it needs a committed checkpoint that reaches the turn. The session is `stopped`.
         *     - `close`: ends the session for good.
         *     - `start_fresh`: continues on a new engine session that does not remember the turns before; the checkpoints so far are retired and queued input runs.
         *     - `retry_restore`: restores the same checkpoint again after what made the restores fail is fixed; queued input runs.
         *
         *     The decision takes effect in the request: the receipt is `succeeded` in the response, with result `{resulting_admission_state, checkpoint_revision, resumable}`. After `abandon` or `confirm_completed`, resume the session; `resumable: false` means a resume would answer `CHECKPOINT_UNAVAILABLE`. The decision is also recorded as a `system` event on the stream.
         *
         *     **Scope:** `sessions:recover` (API key or cookie session). **Idempotency-Key:** required.
         */
        post: operations["decideSessionRecovery"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/invites": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Invites of the workspace, newest first
         * @description Each invite's status is pending, accepted, revoked or expired. Tokens are never returned.
         *
         *     **Auth:** cookie session only; no scope.
         */
        get: operations["listInvites"];
        put?: never;
        /**
         * Invite a person to the workspace
         * @description The token is returned once and expires in seven days; only its sha256 is stored. Inviting an address that already has a live invite revokes that invite. An address that is already a live member answers 400. Every invite writes an `invite_member` receipt.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        post: operations["createInvite"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/invites/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Revoke an invite
         * @description Writes a `revoke_invite` receipt. Revoking an invite that was already revoked does nothing; an accepted one answers 409.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        delete: operations["revokeInvite"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/invites/accept": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Redeem an invite; sets the session cookie
         * @description An address with no account gets one with this password. An existing account joins with its current password, which is never changed. The token is spent once; a revoked, replaced or expired token answers 410, an accepted one 409. Writes an `accept_invite` receipt.
         *
         *     **Auth:** public; no credential. **Idempotency-Key:** ignored.
         */
        post: operations["acceptInvite"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/members": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Members of the workspace, oldest first
         * @description Lists the workspace's members, disabled ones included, oldest membership first, `limit` per page (default 50, at most 100). Pass `next_cursor` back as `cursor` for the next page; it is null on the last one. `q` keeps the members whose display name or email contains it, ignoring case. Each row's `actions` says, for the caller as the list was read, whether each role change, disable and enable would be accepted, and if not, why: the reason is the lower-cased error code the write answers with, or `unchanged` when it would answer 200 and change nothing. The write checks again when it runs. A client that validates responses strictly needs this version's schema to read the field.
         *
         *     **Auth:** cookie session only; no scope.
         */
        get: operations["listMembers"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/members/{user_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Change a member's role
         * @description When several apply, the first answers: no `member.manage` (403 FORBIDDEN), your own role (403 SELF_PROTECTED), no such member (404), an owner targeted, or the owner role granted, by an admin (403 OWNER_PROTECTED), a suspended account (409 ACCOUNT_DISABLED), a disabled membership (409 MEMBER_DISABLED), the role it already has (200, nothing written), demoting the workspace's last live owner (409 LAST_OWNER). Writes a `change_member_role` receipt when the role changes.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        patch: operations["updateMember"];
        trace?: never;
    };
    "/v1/members/{user_id}/disable": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Disable a member of the workspace
         * @description In the same transaction: the membership is disabled, every web session of the person is revoked (open event streams end), their personal keys in the workspace are revoked, and the sessions they asked for wait for an owner's takeover. Agent keys are untouched. Only an owner disables an owner: an admin targeting one answers 403 OWNER_PROTECTED and nothing changes. Disabling yourself answers 403 SELF_PROTECTED, the last live owner 409 LAST_OWNER. When several apply, the first answers: no `member.manage` (403 FORBIDDEN), no such member (404), yourself (403 SELF_PROTECTED), an owner targeted by an admin (403 OWNER_PROTECTED), already disabled (200, nothing written), the last live owner (409). Writes a `disable_member` receipt unless the membership was already disabled (`receipt_id` null).
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        post: operations["disableMember"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/members/{user_id}/enable": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Enable a disabled member again
         * @description Revoked web sessions and personal keys stay revoked: the person signs in again. Sessions no owner took over go back to them. When several apply, the first answers: no `member.manage` (403 FORBIDDEN), no such member (404), yourself (403 SELF_PROTECTED), an owner targeted by an admin (403 OWNER_PROTECTED), a suspended account (409 ACCOUNT_DISABLED: the membership alone would not bring them back, lift the suspension), already live (200, nothing written). Writes an `enable_member` receipt unless the membership was already live (`receipt_id` null).
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        post: operations["enableMember"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/users/{user_id}/disable": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Suspend an account
         * @description Allowed only when every live membership of the account is in a workspace the caller owns or administers; otherwise 403 FORBIDDEN. An account that is an owner, even with that membership disabled, in any workspace the caller is not a live owner of answers 403 OWNER_PROTECTED first. The account cannot sign in anywhere, and the same cut-off as disabling a member applies in each of its workspaces. Suspending yourself answers 403 SELF_PROTECTED. Writes a `disable_user` receipt unless the account was already suspended (`receipt_id` null).
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        post: operations["disableUser"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/users/{user_id}/enable": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Lift an account suspension
         * @description The same rules as suspending, OWNER_PROTECTED included. Revoked web sessions and personal keys stay revoked. Writes an `enable_user` receipt unless the account was not suspended (`receipt_id` null).
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        post: operations["enableUser"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/takeovers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Sessions waiting for an owner to take them over
         * @description Sessions whose requester was offboarded. Each takes no further input until an owner takes it over. API keys are refused.
         *
         *     **Auth:** cookie session only; no scope.
         */
        get: operations["listTakeovers"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{id}/takeover": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Become the requester of an offboarded member's session
         * @description The caller becomes the session's requester and its queued input runs again. A session shared with less than the whole workspace and not with the caller needs a `justification`, kept on the decision and the receipt; without one it answers 403 with `reason_code` `justification_required`. The body may be empty. API keys are refused.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        post: operations["takeOverSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/linked-accounts/slack/start": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Start linking the caller's Slack account
         * @description Returns Slack's consent URL and sets a one-time state cookie for the callback, valid ten minutes. Scopes are `openid profile`; no email is requested. The consent is for the workspace's link app; a workspace without one gets it made now with its App Configuration Token (once: concurrent starts share it), unless the installation names a fallback OIDC app. Refused with 409 when the workspace has no verified Slack install, or nothing to link with. API keys are refused.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        post: operations["startSlackLink"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/linked-accounts/slack/callback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Finish linking with the code Slack returned
         * @description Spends the state cookie, exchanges the code and verifies the id_token, then links the Slack account to the caller and writes a `link_account` receipt. Refused when the account's Slack team is not installed for the workspace, when the account is linked to someone else (never overwritten), or when the caller already linked another account in that team. API keys are refused.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        post: operations["slackLinkCallback"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/linked-accounts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The caller's linked accounts that are active or stale
         * @description API keys are refused.
         *
         *     **Auth:** cookie session only; no scope.
         */
        get: operations["listLinkedAccounts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/linked-accounts/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Unlink one of the caller's accounts
         * @description Revokes the link and writes an `unlink_account` receipt. Input from that Slack account is refused from then on, including input that was already waiting to be processed. API keys are refused.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        delete: operations["unlinkAccount"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/agents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The workspace's agents
         * @description Lists the workspace's agents oldest `created_at` first, `limit` per page (default 50, at most 100). Pass `next_cursor` back as `cursor` for the next page; it is null on the last one. A cursor that does not decode to a position in that order answers 400; a cursor only positions the read, so one from another workspace shows nothing of it. `include=summary` adds to each item a `summary` of what a card shows (the version people talk to, its runtime profile, live credential bindings and admins), read for the whole page at once; without it the items are as before. API keys are refused.
         *
         *     **Auth:** cookie session only; no scope.
         */
        get: operations["listAgents"];
        put?: never;
        /**
         * Create an agent and its first card version
         * @description Nothing is released or activated. A slug already used in the workspace answers 409 ALREADY_EXISTS. API keys are refused.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        post: operations["createAgent"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/agents/counts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * How many agents the workspace has, and how many the caller administers
         * @description `all` is how many agents GET /v1/agents lists read to the last page; `administered` is how many of them the caller administers now, directly or through a team they are a live member of. Answered for the same callers as the list. API keys are refused. It changes nothing.
         *
         *     **Auth:** cookie session only; no scope.
         */
        get: operations["countAgents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/agents/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * An agent with its versions, releases and active release
         * @description **Auth:** cookie session only; no scope.
         */
        get: operations["getAgent"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Rename an agent or add a card version
         * @description A `card` becomes a new version; existing versions never change. A card equal to one the agent already has adds nothing.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        patch: operations["updateAgent"];
        trace?: never;
    };
    "/v1/agents/{id}/releases": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Release a version against a runtime profile
         * @description The release id is a hash of the card, the profile's digest and the resolved runtime settings; releasing the same content again returns the stored release with `created: false`. A card tool outside the profile, a different model or an unknown profile answers 422. Releasing approves and activates nothing.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        post: operations["createAgentRelease"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/agents/{id}/activate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Point the agent at a release (compare-and-swap)
         * @description `expected_revision` is the agent's current `activation_revision` (-1 before the first activation); a stale one answers 409 REVISION_CONFLICT. Sending the same activation again is a no-op with a null `receipt_id`. A release whose runtime profile changed since answers 409 PROFILE_DIGEST_MISMATCH and has to be released again. A release whose card names a credential not bound to the agent answers 409 CREDENTIAL_UNBOUND with the missing names in `details.missing` (`ActivationCredentialUnboundDetails`). Sessions already pinned keep their release.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        post: operations["activateAgent"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/agents/{id}/credential-bindings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The credential names bound to an agent
         * @description Owners, admins and the agent's admins. Each binding carries `running_sessions`, the sessions of this agent that name it and have not closed, with the `revoke_notice` the unbind screen shows: unbinding stops the next session and the next message of a running one, and cuts its remote MCP calls within 30 seconds. Names only; no value is ever stored.
         *
         *     **Auth:** cookie session only; no scope.
         */
        get: operations["listCredentialBindings"];
        put?: never;
        /**
         * Bind a credential name to an agent
         * @description Owners, admins and the agent's admins; never an API key. `credential_ref` names a credential held outside Werft (a secret store entry, a remote MCP server connection). Binding a name already bound answers `created: false` and a null `receipt_id`; otherwise writes a `bind_credential` receipt. A name an agent identity holds answers 409 CREDENTIAL_REF_IN_USE.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        post: operations["createCredentialBinding"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/agents/{id}/credential-bindings/{binding_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Unbind a credential name from an agent
         * @description Takes what binding takes. The next session of a release naming it, and the next message to a running one, is refused 409 CREDENTIAL_UNBOUND with a failed receipt; a running session's remote MCP calls are refused from the next exchange and an open one is cut within 30 seconds, while a call already sent finishes. The answer's `binding.running_sessions` and `revoke_notice` say so. Writes an `unbind_credential` receipt; a binding already revoked is not found.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        delete: operations["revokeCredentialBinding"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/agents/{id}/identities": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The agent's Slack app identities
         * @description Active first, then revoked, newest first within each; up to 50. Owners, admins and the agent's admins.
         *
         *     **Auth:** cookie session only; no scope.
         */
        get: operations["listAgentIdentities"];
        put?: never;
        /**
         * Pin the agent to its Slack app's install in one team
         * @description Slack events from that app and team then resolve to this agent and no other; events from another app, or after the identity or the install is revoked, are dropped. The install must be verified for the workspace (409 SLACK_NOT_INSTALLED); one already pinned to another agent answers 409 AGENT_IDENTITY_TAKEN, and to this agent 409 ALREADY_EXISTS. `credential_ref` names the bot token in the secret store, never its value, and is this identity's alone: a name bound to an agent or another identity answers 409 CREDENTIAL_REF_IN_USE, and the name is freed when the identity is revoked. Owners, admins and the agent's admins; API keys are refused. Writes a `link_agent_identity` receipt.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        post: operations["linkAgentIdentity"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/agents/{id}/identities/{identity_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Revoke an agent identity
         * @description Events from that app and team are dropped from then on, including events already waiting to be processed. Revoking one already revoked changes nothing and answers a null `receipt_id`; otherwise writes a `revoke_agent_identity` receipt. The agent's Slack channel bindings in that install are revoked with it. Linking again makes a new identity.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        delete: operations["revokeAgentIdentity"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/agents/{id}/slack-bindings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The agent's Slack channel bindings
         * @description Live bindings of the channels of the agent's Slack app, and its DM binding (`surface_kind: dm`, no `external_surface_id`): the home channel first, then oldest first; up to 500. Channel ids only; the console resolves names. Owners, admins and the agent's admins.
         *
         *     **Auth:** cookie session only; no scope.
         */
        get: operations["listSlackBindings"];
        /**
         * Set how the agent answers in one Slack channel or its DMs
         * @description Replaces the binding of `channel_id` in the agent's Slack app install, or the install's one DM binding when `channel_id` is null, creating it the first time. The channel's kind is what Slack's `conversations.info` answers with the bot token; `channel_kind`, when sent, only has to agree on whether this is the DM row (400 when Slack names a DM or does not know the channel, 503 when Slack cannot be read). `mode` is `off` (the channel takes nothing; a mention there is refused) or `mention`. `home: true` makes this channel the agent's home and clears the previous one; a DM is never home. A missing `ceiling` is the default: every Slack action, shown in full. The agent needs a live Slack app identity (409 SLACK_NOT_INSTALLED); a concurrent change to the same channel or home answers 409 REVISION_CONFLICT. The bot does not join the channel here. Owners, admins and the agent's admins; API keys are refused. Writes a `set_surface_binding` receipt.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        put: operations["putSlackBinding"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/agents/{id}/slack-channels": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Resolve up to 50 Slack channel IDs by name
         * @description Accepts comma-separated IDs only, with no cursor or full scan. Reads conversations.info concurrently and caches each app and channel for 60 seconds, coalescing concurrent reads. IDs Slack reports as missing or inaccessible return state and name unknown. Transport failures and upstream errors answer 503 without caching; a revoked or invalid bot token answers 409 SLACK_NOT_INSTALLED. Slack rate limits answer 503 with Retry-After. Agent managers only.
         *
         *     **Auth:** cookie session only; no scope.
         */
        get: operations["lookupSlackChannels"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/agents/{id}/slack/channels": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Search the channels the agent's Slack bot can see
         * @description Channels whose name starts with `q` (any case, a leading `#` ignored), by name, `limit` per page (default 20, at most 50): every public channel of the install and the private ones the bot is already in. `is_member` says whether the bot is in the channel. The server reads the app's whole list from Slack (`conversations.list` with the bot token) and keeps it for 60 seconds per app, up to 10,000 channels (`truncated: true` past that); a binding change in the same API process drops it sooner. Pass `next_cursor` back as `cursor` with the same `q` for the next page; once the list it pages through has been replaced the cursor answers 400 CURSOR_EXPIRED, and the search starts over. When Slack rate limits, the last list read is returned with `stale: true`, or 503 with Slack's `Retry-After` when there is none; Slack is not asked again before then. The agent needs an installed Slack app with a bot token (409 SLACK_NOT_INSTALLED). Owners, admins and the agent's admins.
         *
         *     **Auth:** cookie session only; no scope.
         */
        get: operations["searchSlackChannels"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/agents/{id}/slack/app/manifest": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read the agent app manifest as YAML
         * @description Builds the manifest from the agent and server configuration without reading secret values. Agent managers with a web session only.
         *
         *     **Auth:** cookie session only; no scope.
         */
        get: operations["getSlackAppManifest"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/agents/{id}/slack/app/settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read the default response mode for new Slack channels
         * @description Returns the agent's saved default mode, initially off. Agent managers with a web session only.
         *
         *     **Auth:** cookie session only; no scope.
         */
        get: operations["getSlackAppSettings"];
        /**
         * Save the default response mode for new Slack channels
         * @description Saves off or mention for the agent. Defaults to off. Agent managers with a web session only. Applying this default to new bindings is handled separately.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** required.
         */
        put: operations["putSlackAppSettings"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/agents/{id}/slack/app": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The agent's Slack app, if the platform made one
         * @description The agent's live Slack app (`creating`, `created` or `deleting`), or null when it has none. Secrets appear only as whether each is stored; `secrets.slack_bot_token.configured` says whether Slack handed over a bot token; an install refused after the code exchange keeps it, so the agent's `slack_bot` identity is what says the app is installed. The install link comes from `POST /v1/agents/{id}/slack/install/start`. Owners, admins and the agent's admins; API keys are refused.
         *
         *     **Auth:** cookie session only; no scope.
         */
        get: operations["getSlackApp"];
        put?: never;
        /**
         * Create the agent's Slack app
         * @description Creates one Slack app for the agent with the workspace's App Configuration Token (`apps.manifest.create`): the agent's name, its bot, the agent view and the bot scopes, with no event subscriptions yet. The app is recorded as `creating` before Slack is asked; its signing and client secrets are stored by the server under the app and never returned. Asking again for an agent that has its app returns the same app with `created: false`. If Slack's answer was lost the app stays `creating` and the next request answers 409 SLACK_APP_CREATING; once `uncertain`, check api.slack.com/apps, delete any app made then, and retry with `replace_uncertain: true`. `warnings` says when the config token now belongs to another Slack user than the one who made the workspace's previous app. The agent needs an active release. Installing it into Slack starts at `POST /v1/agents/{id}/slack/install/start`. Owners, admins and the agent's admins from a signed-in console; API keys are refused.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        post: operations["createSlackApp"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/agents/{id}/slack/install/start": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Get a single-use link that installs the agent's Slack app
         * @description Returns Slack's consent URL for the agent's app with a new OAuth `state`, valid 10 minutes; every call makes another. The state is bound to the caller, the workspace, the agent and the app, and only that caller can complete it (`POST /v1/slack/install/complete`). The app must be `created`: none answers 404, one still being created 409 SLACK_APP_CREATING, one being deleted 409 REVISION_CONFLICT. The Slack team it must be installed in is the one the workspace's App Configuration Token belongs to (409 CONFIG_TOKEN_INVALID when none is set). Owners, admins and the agent's admins from a signed-in console; API keys are refused.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        post: operations["startSlackInstall"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/slack/install/complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Finish installing an agent's Slack app with what Slack returned
         * @description The console's callback page sends the `state` and the `code` (or Slack's `error`) from Slack's redirect, with the agent it is for. The state is spent first, whatever happens next: unknown, spent, expired, or issued to another caller, workspace, agent or app answers 409 SLACK_INSTALL_STATE_INVALID with `error.details.reason_code`. An `error` from Slack (e.g. `access_denied`) answers 409 SLACK_INSTALL_DENIED. The code is exchanged with `oauth.v2.access`; unless the answer names the agent's app, the workspace's Slack team, no enterprise install and every bot scope, nothing is stored (409 SLACK_INSTALL_REJECTED). Then the bot token is sealed under the app (never returned), the install is verified with the token itself (`auth.test` and `bots.info`), the agent's identity is linked, and the steps after an install run; `finalized: false` says those failed and the install stands. Installing again with a new link replaces the bot token and keeps the one install. Every answer carries `Referrer-Policy: no-referrer`. Owners, admins and the agent's admins from a signed-in console; API keys are refused. A new identity writes a `link_agent_identity` receipt.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        post: operations["completeSlackInstall"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/slack/events/{agent_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Slack's Events API request URL for one agent's app
         * @description Called by Slack, not by people: each agent app's event subscription points here (Finalize registers it when SLACK_EVENTS_PUBLIC_URL is set). The body is read up to 256 KiB (413 above that), then checked in this order: the `v0` signature (`X-Slack-Signature`) over the raw bytes with the app's signing secret, the `X-Slack-Request-Timestamp` within 300 seconds, then the JSON. An unknown agent, an agent without a created app, an app without a signing secret, a wrong, missing or stale signature all answer the same 401. A signed `url_verification` answers its `challenge`. An `event_callback` is stored once per `(team_id, event_id)`, so Slack's retries (`X-Slack-Retry-Num`) answer 200 without a second row; one for another app or team than the agent's install, from a bot, or of a message subtype other than `thread_broadcast`, is stored as dropped with its reason. `app_uninstalled` and `tokens_revoked` mark the install revoked. Any other envelope type answers 200 and is ignored. A failed write answers 5xx so Slack sends the event again. Rate limited per agent and overall before any database read (429).
         *
         *     **Auth:** public; no credential. **Idempotency-Key:** ignored.
         */
        post: operations["receiveSlackEvent"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/api-keys": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The caller's personal keys and the agent keys they manage
         * @description Owners and admins see every agent key; an agent's admin sees that agent's keys. Who sees which agent keys is read from the caller's role on every page, so a page read after a role change follows the new role. Newest `created_at` first, `limit` per page (default 50, at most 100). Pass `next_cursor` back as `cursor` for the next page; it is null on the last one. A cursor that does not decode to a position in that order answers 400; a cursor only positions the read, so one from another workspace shows nothing of it. Secrets are never returned.
         *
         *     **Auth:** cookie session only; no scope.
         */
        get: operations["listApiKeys"];
        put?: never;
        /**
         * Issue a personal key or an agent key
         * @description A personal key is the caller's own; an agent key names its agent in `agent_id` and takes an owner, an admin, or that agent's admin. No key reaches a whole workspace: an agent key without `agent_id` is a 400. `name` (1-64 characters once trimmed) is optional. `scopes` may not exceed what the caller holds now, and an agent key never holds `sessions:approve` (403 SCOPE_NOT_GRANTABLE). An API key never issues one. The secret is returned once; only its sha256 is stored. Writes a `create_api_key` receipt.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        post: operations["createApiKey"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/api-keys/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Revoke a key
         * @description Takes the right issuing that kind of key takes. Revoking a key already revoked changes nothing and answers a null `receipt_id`; otherwise writes a `revoke_api_key` receipt.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        delete: operations["revokeApiKey"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/teams": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The workspace's teams, by name
         * @description Owners and admins. Archived teams are left out. By `name`, then `id`, `limit` per page (default 50, at most 100). Pass `next_cursor` back as `cursor` for the next page; it is null on the last one. A cursor that does not decode to a position in that order answers 400; a cursor only positions the read, so one from another workspace shows nothing of it. A team renamed while the pages are read can show twice or not at all; every other team shows once.
         *
         *     **Auth:** cookie session only; no scope.
         */
        get: operations["listTeams"];
        put?: never;
        /**
         * Create a team
         * @description Owners and admins (`team.manage`). A live team's name is unique in its workspace (409 ALREADY_EXISTS). Writes a `create_team` receipt.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        post: operations["createTeam"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/my-teams": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The teams the caller belongs to
         * @description Any signed-in person, as of this request: each team's id and name, never who else is in it. By `name`, then `id`, `limit` per page (default 50, at most 100). Pass `next_cursor` back as `cursor` for the next page; it is null on the last one. A cursor that does not decode to a position in that order answers 400; a cursor only positions the read, so one from another workspace shows nothing of it. A team renamed while the pages are read can show twice or not at all; every other team shows once.
         *
         *     **Auth:** cookie session only; no scope.
         */
        get: operations["listMyTeams"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/teams/{team_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * A team and its members
         * @description An owner or an admin reads any team. Anyone else reads only a team they are in now, read only: changing it stays with owners and admins. Any other team is 403.
         *
         *     **Auth:** cookie session only; no scope.
         */
        get: operations["getTeam"];
        put?: never;
        post?: never;
        /**
         * Delete a team
         * @description Every agent the team administered loses it from the next request on; its members keep whatever they hold on their own. Writes a `delete_team` receipt.
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        delete: operations["deleteTeam"];
        options?: never;
        head?: never;
        /**
         * Rename a team
         * @description Writes a `rename_team` receipt unless the name is unchanged (`receipt_id` null).
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        patch: operations["updateTeam"];
        trace?: never;
    };
    "/v1/teams/{team_id}/members": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Add a member of the workspace to a team
         * @description No invite and no acceptance: the person is a member of the team at once. A disabled member is not found. Writes an `add_team_member` receipt naming the person, unless they already were in (`receipt_id` null).
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        post: operations["addTeamMember"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/teams/{team_id}/members/{user_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Take a member out of a team
         * @description What the person held through the team ends from their next request. Writes a `remove_team_member` receipt naming the person, unless they were not in (`receipt_id` null).
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        delete: operations["removeTeamMember"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/agents/{id}/admins": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The people and teams who administer an agent
         * @description Owners, admins and the agent's own admins (`agent.admin.manage`).
         *
         *     **Auth:** cookie session only; no scope.
         */
        get: operations["listAgentAdmins"];
        put?: never;
        /**
         * Name a person or a team an agent's admin
         * @description Owners, admins and the agent's own admins. A team's members administer the agent while they are in it. Writes an `add_agent_admin` receipt unless they already were one (`receipt_id` null).
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        post: operations["addAgentAdmin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/agents/{id}/admins/{kind}/{subject_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Stop a person or a team administering an agent
         * @description `kind` is `users` or `teams`. Writes a `remove_agent_admin` receipt unless they were not one (`receipt_id` null).
         *
         *     **Auth:** cookie session only; no scope. **Idempotency-Key:** ignored.
         */
        delete: operations["removeAgentAdmin"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/administered-agents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The agents the caller administers
         * @description Directly or through a team, as of this request: what an agent's admin needs to issue that agent's own key.
         *
         *     **Auth:** cookie session only; no scope.
         */
        get: operations["listAdministeredAgents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/profiles": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The runtime profiles this installation can run
         * @description Lists the catalog profiles a session's `profile_id` or a release's `runtime_profile_id` may name, by `id`, with the model each one runs and its `repository_mode`: whether a session of it names a repository (`required`), may (`optional`) or never does (`none`). The catalog is the operator's config, read once at startup; this reads it and changes nothing. A profile's provider endpoint and credential are not included.
         *
         *     **Scope:** `sessions:read` (API key or cookie session).
         */
        get: operations["listProfiles"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/limits": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Installation limits and installation-wide usage
         * @description Reads the limits this installation runs under (execution slots, queued input per session, storage, turn length, per-session cost and token limits, provider retries) and the usage against the installation-wide ones, summed over every owner. Use it to explain `STORAGE_LIMIT_EXCEEDED`, a full input queue, or sessions waiting in `queued` for a slot.
         *
         *     Only the workspace owner, signed in, reads it: any other member and every API key get 403. It changes nothing.
         *
         *     **Scope:** `sessions:read` (API key or cookie session).
         */
        get: operations["getInstallationLimits"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/usage/summary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Cost, tokens and run time of the sessions created in a period
         * @description Adds up the sessions created in `[since, until)`: how many, their estimated provider cost, their tokens, and how long their turns ran. `since` and `until` take a date (`2026-10-01`, that day's 00:00 UTC) or a timestamp with an offset, which is moved to UTC; without `until` the period ends when the figures are read, so `since` must then be in the past.
         *
         *     - `scope=me`: the sessions the caller started. A personal API key counts as the person who created it; a key nobody created counts the sessions it started itself. Sessions shared with the caller are not added. A key bound to an agent gets 403, as it does from `GET /v1/sessions`.
         *     - `scope=installation`: every session of every owner. Only the workspace owner, signed in, reads it: any other member and every API key get 403.
         *
         *     `cost_usd` is the sum of `cost.amount_usd` from `GET /v1/sessions/{id}/usage` over the same sessions: an estimate, not a bill. `cost_complete: false` means one of them has a turn still open or one that ended without reporting its cost, so the true total is unknown. `run_seconds` is wall-clock turn time, waiting for an answer included; an open turn counts up to `refreshed_at`. Sessions from before tokens were metered count 0 tokens. It changes nothing.
         *
         *     **Scope:** `sessions:read` (API key or cookie session).
         */
        get: operations["getUsageSummary"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/usage/series": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The usage summary of a period, one bucket per UTC day
         * @description Splits `GET /v1/usage/summary` by the UTC day each session was created on: one bucket per day the period `[since, until)` touches, oldest first, days without sessions included. `scope`, `since`, `until` and who may read which scope are exactly the summary's; the period spans at most 366 days. `bucket` is `day`, the only size.
         *
         *     The buckets of one response add up to the summary of the same period: `session_count`, `cost_usd` and `token_count` sum, and `cost_complete` is false on a day whose sessions include one the summary would mark incomplete. `run_seconds` is the floor of the running total of turn time minus the floor of the one before it, so two days of 0.6 seconds read 0 and 1, as the summary reads 1. A long session's cost and time count on the day it started. It changes nothing.
         *
         *     **Scope:** `sessions:read` (API key or cookie session).
         */
        get: operations["getUsageSeries"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/usage/breakdown": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The usage summary of a period by model or by agent
         * @description Groups the sessions `GET /v1/usage/summary` adds up by the model their metered calls named (`by=model`) or by their agent (`by=agent`), largest cost first, with the input, output, cache read and cache write tokens of those calls. `scope`, `since`, `until` and who may read which scope are exactly the summary's; the period spans at most 366 days.
         *
         *     `token_count` is the four token columns' sum; the 1-hour cache writes are inside `cache_creation_input_tokens`. `totals` is the summary of the same period: its `session_count`, `token_count` and `cost_usd` equal it.
         *
         *     - `by=agent`: each session counts once under its agent (`key` is the agent id, `label` its name), so the rows add up to `totals` in every column. Sessions without an agent are the row whose `key` and `label` are null.
         *     - `by=model`: a session counts under every model it called, so the rows' `session_count` may add up to more than the totals'. A session's cost its metered calls do not explain, such as an engine's turn totals from before proxy metering, is the row whose `key` and `label` are null, with no tokens.
         *
         *     It changes nothing.
         *
         *     **Scope:** `sessions:read` (API key or cookie session).
         */
        get: operations["getUsageBreakdown"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/usage/tools": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Calls, failures and time per tool in a period
         * @description Counts the tool calls whose `tool_use` event was stored in `[since, until)`, per tool name, the most-called first and at most 200 names. `scope`, `since` and `until` work as in `GET /v1/usage/summary`; `agent_id` narrows to the sessions pinned to a release of that agent. Subagent calls count too.
         *
         *     A call is timed from its `tool_use` to the `tool_result` paired with it in the same session and attempt by `tool_use_id`. A call with no result yet, or with either event's time missing, counts in `calls` but in no `_ms` figure. `failed` counts results with `is_error: true`; a result without `is_error` is a success, and one whose `is_error` is not a boolean is neither. `median_ms` is read from a histogram: the middle call's time, or the mean of the two middle calls' for an even count, each read within 5% or 1 ms, except that a call of about 65 minutes or more reads as about 65 minutes, so a median that takes in such a call reads low. It is never above `max_ms`. Over whole UTC days `max_ms` is the largest time a call has had: if an earlier result later replaces a call's time, it does not come down there. Figures come from a table the reconciler fills on each pass, so a call shows up within one pass of being stored, usually seconds. Each finding names a row of `tools`: `most_time` the largest `total_ms`, `fails_often` the highest `failed / calls`, `slowest` the largest `median_ms`; a kind no tool qualifies for is left out. The response names tools and figures only, never a session. It changes nothing.
         *
         *     **Scope:** `sessions:read` (API key or cookie session).
         */
        get: operations["getUsageTools"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/usage/tools/{name}/calls": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Recent or slowest calls of one tool, and its calls per day
         * @description Lists the calls of the tool `name` whose `tool_use` event was stored in `[since, until)`, with the scopes, period and `agent_id` of `GET /v1/usage/tools`; the period spans at most 366 days. `sort=recent` (the default) lists the latest `occurred_at` first, `sort=slowest` the longest `duration_ms` first with untimed calls last; ties go to the later event. Read the next page with `next_cursor`, which is null on the last page; a cursor from the other sort is 400.
         *
         *     `session_id` and `title` are null for a session the caller may not read (one in another owner, or private and not shared with the caller); the call's time, duration, outcome and agent still show. `agent` is null for a session made without an agent. `outcome` is `unknown` while no result is paired or when the result's `is_error` is not a boolean; `duration_ms` is null without a paired result or with either time missing, and set even when `outcome` is `unknown`. `per_day` counts the tool's calls on every UTC date the period touches, zeros included. Calls show up within one reconciler pass of being stored. It changes nothing.
         *
         *     **Scope:** `sessions:read` (API key or cookie session).
         */
        get: operations["getUsageToolCalls"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/receipts/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Current outcome of an accepted command
         * @description Reads the current outcome of a command by the `receipt_id` its response returned: `accepted` while it is in progress, then `succeeded`, `failed` (with `error`) or `unknown` (nobody can say; `error` explains). Poll until it leaves `accepted`. `result` depends on `operation`:
         *
         *     - `create_session`, `append_message`: the acceptance response exactly as first returned, never rewritten. The turn's outcome is read from `GET /v1/sessions/{session_id}/turns/{turn_id}` using `target_ref`.
         *     - `interrupt`: `{turn_id, terminal, no_op}` once settled.
         *     - `pause`, `resume`: `{resulting_admission_state, checkpoint_revision, queued_turn_count}`.
         *     - `close`: `{resulting_admission_state, checkpoint_revision, cancelled_turn_count}`; `checkpoint_revision` is null only for a session that never ran a turn.
         *     - `terminate`: `{execution_gone, checkpoint_revision, unconfirmed_turn_id, external_effects_reverted}`.
         *     - `recovery_decision`: `{resulting_admission_state, checkpoint_revision, resumable}`.
         *     - `answer`: null; only `status` and `error` change.
         *     - `request_push`, `decide_push`, `push`: `{push_request_id, decision, verdict, refusal, repository_id, checkpoint_revision, git_commit, target_branch}`; `verdict` is `allow` or `refuse`, a refused attempt is `failed` with the reason in `refusal` and `error`, and fields the attempt never read are null. `actor` names who made it.
         *     - `open_pull_request`, `comment_pull_request`: `{push_request_id, verdict, refusal, repository_id, number, url, head, base, created}`, and for a comment also `{comment_id, comment_url, marker}`; `created` is false when the call answered an open pull request or edited the marked comment.
         *     - `set_slack_secret`, `delete_slack_secret`: `{purpose, last4}`; the value itself is never in a receipt.
         *
         *     Any credential of the same owner can read a receipt. It changes nothing.
         *
         *     **Scope:** `sessions:read` (API key or cookie session).
         */
        get: operations["getReceipt"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        CreateSessionRequest: {
            profile_id: string;
            /** @description The session's name. Omitted, it is derived from `message`: whitespace and line breaks collapsed to one space, the ends trimmed, and text longer than 80 characters cut to 79 and an ellipsis (…). Rename it later with `PATCH /v1/sessions/{id}`. */
            title?: string;
            /** @description The catalog repository the session works on. Required when the profile's `repository_mode` is `required`, refused when it is `none`, either when it is `optional`; omitted, the session starts in an empty workspace with no repository to push to. */
            repository_id?: string;
            /** @description At most 32768 bytes of UTF-8 */
            message: string;
            agent_release_id?: string;
            /** @description One of the models the profile offers (its `model` or one of its `models` in the catalog). Omitted, the model of the agent release's card when `agent_release_id` is sent, else the profile's default `model`. Kept until the session's profile is changed, after which the new profile's default `model` runs. */
            model?: string;
        };
        ListSessionsQuery: {
            cursor?: string;
            /** @default 50 */
            limit: number;
            /**
             * @description Filters on the status each item reports, needs_input included as derived when read.
             * @enum {string}
             */
            status?: "queued" | "running" | "needs_input" | "idle" | "failed" | "stopped";
            /**
             * Format: uuid
             * @description Keeps the sessions created for this agent, whichever of its releases they are pinned to. An agent with no session the caller can read, or no such agent, gives an empty page.
             */
            agent_id?: string;
            /**
             * @description Narrows the sessions the caller can read, never widens them; omitted, `all`. `started`: the caller started it (for an API key, the key or the person who created it). `shared`: someone else's session shared with the caller by name or through a team the caller is a member of; sessions every workspace member sees appear only under `all`. `administered`: a session of an agent the caller administers, directly or through a team.
             * @enum {string}
             */
            relation?: "all" | "started" | "shared" | "administered";
            /** @description Matches a session whose title contains it, ignoring case, or whose id starts with it. */
            q?: string;
        };
        ListAgentsQuery: {
            cursor?: string;
            /** @default 50 */
            limit: number;
            /** @constant */
            include?: "summary";
        };
        ListApiKeysQuery: {
            cursor?: string;
            /** @default 50 */
            limit: number;
        };
        ListTeamsQuery: {
            cursor?: string;
            /** @default 50 */
            limit: number;
        };
        ListMyTeamsQuery: {
            cursor?: string;
            /** @default 50 */
            limit: number;
        };
        ListMembersQuery: {
            cursor?: string;
            /** @default 50 */
            limit: number;
            /** @description Matches a member whose display name or email contains it, ignoring case. `%` and `_` match themselves. */
            q?: string;
        };
        CountSessionsQuery: {
            /**
             * @description Narrows the sessions the caller can read, never widens them; omitted, `all`. `started`: the caller started it (for an API key, the key or the person who created it). `shared`: someone else's session shared with the caller by name or through a team the caller is a member of; sessions every workspace member sees appear only under `all`. `administered`: a session of an agent the caller administers, directly or through a team.
             * @enum {string}
             */
            relation?: "all" | "started" | "shared" | "administered";
            /** @description Matches a session whose title contains it, ignoring case, or whose id starts with it. */
            q?: string;
        };
        UsageSummaryQuery: {
            /** @enum {string} */
            scope: "installation" | "me";
            since: string;
            until?: string;
        };
        UsageSeriesQuery: {
            /** @enum {string} */
            scope: "installation" | "me";
            since: string;
            until?: string;
            /**
             * @default day
             * @enum {string}
             */
            bucket: "day";
        };
        UsageBreakdownQuery: {
            /** @enum {string} */
            scope: "installation" | "me";
            since: string;
            until?: string;
            /** @enum {string} */
            by: "model" | "agent";
        };
        UsageToolsQuery: {
            /** @enum {string} */
            scope: "installation" | "me";
            since: string;
            until?: string;
            /** Format: uuid */
            agent_id?: string;
        };
        UsageToolCallsQuery: {
            /** @enum {string} */
            scope: "installation" | "me";
            since: string;
            until?: string;
            /** Format: uuid */
            agent_id?: string;
            /**
             * @default recent
             * @enum {string}
             */
            sort: "recent" | "slowest";
            /** @default 20 */
            limit: number;
            cursor?: string;
        };
        PostSessionMessageRequest: {
            /** @description At most 32768 bytes of UTF-8 */
            message: string;
            /**
             * @default enqueue
             * @constant
             */
            mode: "enqueue";
        };
        ListTurnsQuery: {
            cursor?: string;
            /** @default 50 */
            limit: number;
        };
        SearchSlackChannelsQuery: {
            /**
             * @description A prefix of the channel name, any case; a leading `#` is ignored. Empty matches every channel.
             * @default
             */
            q: string;
            cursor?: string;
            /** @default 20 */
            limit: number;
        };
        LookupSlackChannelsQuery: {
            ids: string;
        };
        PostSessionAnswerRequest: {
            request_id: string;
            /** @constant */
            kind: "permission";
            /** @enum {string} */
            decision: "allow" | "deny";
            reason?: string;
        } | {
            request_id: string;
            /** @constant */
            kind: "question";
            answers: {
                question_id: string;
                selected_option_ids: string[];
                free_text?: string;
            }[];
        };
        PostSessionAnswerResponse: {
            /** Format: uuid */
            receipt_id: string;
            /** @enum {string} */
            receipt_status: "accepted" | "succeeded" | "failed" | "unknown";
            approval?: {
                answered_by: {
                    principal: {
                        /** @enum {string} */
                        kind: "api_key" | "user" | "installation";
                        id: string;
                    };
                    actor_user_id: string | null;
                    agent_id: string | null;
                } | null;
                /** @enum {string} */
                surface: "web" | "slack" | "api";
                /** Format: uuid */
                decision_id: string;
            };
        };
        InterruptSessionRequest: {
            target_turn_id: string;
        };
        PauseSessionRequest: {
            expected_revision: number;
            reason?: string;
        };
        TerminateSessionRequest: {
            expected_revision: number;
            reason?: string;
        };
        CloseSessionRequest: {
            expected_revision: number;
            reason?: string;
        };
        ResumeSessionRequest: {
            expected_revision: number;
        };
        ChangeSessionProfileRequest: {
            expected_revision: number;
            profile_id: string;
        };
        RecoveryDecisionRequest: {
            expected_revision: number;
            reason: string;
            /** @constant */
            decision: "abandon";
            target_turn_id: string;
        } | {
            expected_revision: number;
            reason: string;
            /** @constant */
            decision: "confirm_completed";
            target_turn_id: string;
            evidence_ref: string;
        } | {
            expected_revision: number;
            reason: string;
            /** @constant */
            decision: "close";
        } | {
            expected_revision: number;
            reason: string;
            /** @constant */
            decision: "start_fresh";
        } | {
            expected_revision: number;
            reason: string;
            /** @constant */
            decision: "retry_restore";
        };
        CreatePushRequestRequest: Record<string, never>;
        DecidePushRequestRequest: {
            /** @enum {string} */
            decision: "approve" | "reject";
            git_commit: string;
            reason?: string;
        };
        OpenPullRequestRequest: {
            title?: string;
            body?: string;
        };
        CommentPullRequestRequest: {
            body: string;
            marker?: string;
        };
        BootstrapRequest: {
            bootstrap_token: string;
            /** Format: email */
            email: string;
            password: string;
            display_name: string;
            workspace_name: string;
            workspace_slug: string;
        };
        LoginRequest: {
            /** Format: email */
            email: string;
            password: string;
        };
        PasswordResetRequest: {
            token: string;
            password: string;
        };
        SlackLinkCallbackRequest: {
            code: string;
            state: string;
        };
        CreateInviteRequest: {
            /** Format: email */
            email: string;
            /** @enum {string} */
            role: "owner" | "admin" | "member";
        };
        AcceptInviteRequest: {
            token: string;
            password: string;
            display_name?: string;
        };
        UpdateMemberRequest: {
            /** @enum {string} */
            role: "owner" | "admin" | "member";
        };
        UpdateSessionRequest: {
            /** @description Stored with runs of whitespace and line breaks collapsed to one space and the ends trimmed; at most 80 characters (grapheme clusters) after that. */
            title: string;
        };
        SetAccessRequest: {
            /** @description At most 1024 bytes of UTF-8 */
            reason?: string;
        };
        GoogleLoginCallbackRequest: {
            code: string;
            state: string;
        };
        AuditRetentionRequest: {
            audit_retention_days: number;
        };
        SlackGuestRequest: {
            slack_guest_enabled: boolean;
        };
        PutSlackSecretRequest: {
            value: string;
        };
        CreateSlackAppRequest: {
            /** @default false */
            replace_uncertain: boolean;
        };
        CompleteSlackInstallRequest: {
            /** Format: uuid */
            agent_id: string;
            state: string;
            code?: string;
            error?: string;
        };
        SlackEventEnvelope: ({
            /** @constant */
            type: "url_verification";
            challenge: string;
        } & {
            [key: string]: unknown;
        }) | ({
            /** @constant */
            type: "event_callback";
            team_id: string;
            api_app_id: string;
            event_id: string;
            event_time?: number;
            event: {
                type: string;
                subtype?: string;
                user?: string;
                bot_id?: string;
            } & {
                [key: string]: unknown;
            };
        } & {
            [key: string]: unknown;
        }) | ({
            type: string;
        } & {
            [key: string]: unknown;
        });
        CreateAgentRequest: {
            slug: string;
            name: string;
            card: {
                role: string;
                instructions: string;
                tone?: string;
                /**
                 * @default ko
                 * @enum {string}
                 */
                language: "ko" | "en";
                model: string;
                capabilities: {
                    tools: string[] | null;
                    mcp: {
                        server: string;
                    }[] | null;
                    /** @default [] */
                    forbidden: string[];
                    tool_policy?: {
                        default?: {
                            /** @enum {string} */
                            builtin?: "allow" | "ask" | "deny";
                            /** @enum {string} */
                            mcp?: "allow" | "ask" | "deny";
                        };
                        per_tool?: {
                            [key: string]: "allow" | "ask" | "deny";
                        };
                    };
                    credential_refs?: string[];
                };
                /** @default [] */
                rules: {
                    id: string;
                    text: string;
                    /** @enum {string} */
                    source: "user" | "correction";
                }[];
            };
        };
        UpdateAgentRequest: {
            name?: string;
            card?: {
                role: string;
                instructions: string;
                tone?: string;
                /**
                 * @default ko
                 * @enum {string}
                 */
                language: "ko" | "en";
                model: string;
                capabilities: {
                    tools: string[] | null;
                    mcp: {
                        server: string;
                    }[] | null;
                    /** @default [] */
                    forbidden: string[];
                    tool_policy?: {
                        default?: {
                            /** @enum {string} */
                            builtin?: "allow" | "ask" | "deny";
                            /** @enum {string} */
                            mcp?: "allow" | "ask" | "deny";
                        };
                        per_tool?: {
                            [key: string]: "allow" | "ask" | "deny";
                        };
                    };
                    credential_refs?: string[];
                };
                /** @default [] */
                rules: {
                    id: string;
                    text: string;
                    /** @enum {string} */
                    source: "user" | "correction";
                }[];
            };
        };
        CreateAgentReleaseRequest: {
            /** Format: uuid */
            version_id: string;
            runtime_profile_id: string;
        };
        ActivateAgentRequest: {
            release_id: string;
            expected_revision: number;
        };
        CreateApiKeyRequest: {
            /** @enum {string} */
            kind: "personal" | "agent";
            /** @description A label the issuer gives the key, so a list tells one integration's key from another's. */
            name?: string;
            scopes: ("sessions:read" | "sessions:write" | "sessions:approve" | "sessions:control" | "sessions:recover")[];
            /** Format: uuid */
            agent_id?: string;
            /** Format: date-time */
            expires_at?: string;
        };
        CreateTeamRequest: {
            name: string;
        };
        SetSessionShareRequest: {
            /** @enum {string} */
            scope: "private" | "people" | "team" | "workspace";
            user_ids?: string[];
            team_ids?: string[];
            expected_revision?: number;
        };
        AuditReadRequest: {
            justification: string;
            cursor?: string;
            /** @default 50 */
            limit: number;
        };
        AdminTerminateSessionRequest: {
            expected_revision: number;
            justification: string;
        };
        TakeOverSessionRequest: {
            justification?: string;
        };
        UpdateTeamRequest: {
            name: string;
        };
        AddTeamMemberRequest: {
            /** Format: uuid */
            user_id: string;
        };
        AddAgentAdminRequest: {
            /** Format: uuid */
            user_id?: string;
            /** Format: uuid */
            team_id?: string;
        };
        LinkAgentIdentityRequest: {
            /** @enum {string} */
            provider: "slack_bot";
            app_id: string;
            team_id: string;
            credential_ref: string;
        };
        PutSlackBindingRequest: {
            channel_id: string | null;
            /** @enum {string} */
            channel_kind?: "public_channel" | "private_channel" | "dm";
            /** @enum {string} */
            mode: "off" | "mention";
            /** @default false */
            home: boolean;
            ceiling?: {
                actions: ("session.read" | "session.submit" | "session.control" | "session.approve")[];
                /** @enum {string} */
                disclosure: "full" | "summary";
            };
        };
        ApiErrorResponse: {
            error: {
                /** @enum {string} */
                code: "BAD_REQUEST" | "UNAUTHORIZED" | "FORBIDDEN" | "BOOTSTRAP_DONE" | "NOT_FOUND" | "PAYLOAD_TOO_LARGE" | "REQUEST_TIMEOUT" | "UNSUPPORTED_CAPABILITY" | "RATE_LIMITED" | "STORAGE_LIMIT_EXCEEDED" | "BUDGET_EXCEEDED" | "INTERNAL_ERROR" | "REVISION_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "REQUEST_EXPIRED" | "REQUEST_STALE" | "SESSION_PAUSED" | "SESSION_RESUMING" | "SESSION_CLOSED" | "SESSION_CLOSING" | "SESSION_STOPPED" | "RECOVERY_REQUIRED" | "CHECKPOINT_UNAVAILABLE" | "PAUSE_COMMITTING" | "PAUSE_CANCELLED" | "CONTROL_SUPERSEDED" | "TURN_NOT_STARTED" | "BACKEND_UNAVAILABLE" | "LAUNCH_FAILED" | "CATALOG_MISMATCH" | "TAKEOVER_REQUIRED" | "SLACK_NOT_INSTALLED" | "LINK_TEAM_MISMATCH" | "LINK_TAKEN" | "LINK_EXISTS" | "AGENT_IDENTITY_TAKEN" | "CONFIG_TOKEN_INVALID" | "SLACK_APP_CREATING" | "AGENT_NOT_ACTIVE" | "SLACK_INSTALL_STATE_INVALID" | "SLACK_INSTALL_DENIED" | "SLACK_INSTALL_REJECTED" | "SLACK_INSTALL_CONFLICT" | "SLACK_LINK_NOT_CONFIGURED" | "INVITE_EXPIRED" | "INVITE_USED" | "LAST_OWNER" | "OWNER_PROTECTED" | "SELF_PROTECTED" | "MEMBER_DISABLED" | "ACCOUNT_DISABLED" | "SCOPE_NOT_GRANTABLE" | "RELEASE_PROFILE_MISMATCH" | "CREDENTIAL_UNBOUND" | "CREDENTIAL_REF_IN_USE" | "LOGIN_LINK_REQUIRED" | "PROFILE_DIGEST_MISMATCH" | "ALREADY_EXISTS" | "NOT_READY" | "CURSOR_EXPIRED" | "LEASE_EXPIRED" | "STALE_EPOCH" | "PUSH_SOURCE_MISSING" | "PUSH_REQUEST_OPEN" | "PUSH_REQUEST_DECIDED" | "CHECKPOINT_MOVED" | "PUSH_NOT_PUSHED" | "PULL_REQUEST_MISSING";
                message: string;
                retryable: boolean;
                request_id: string;
                details: unknown | null;
            };
        };
        ApiRootResponse: {
            /** @constant */
            status: "ok";
            owner_id: string;
        };
        HealthResponse: {
            /** @constant */
            status: "ok";
        };
        ReadyResponse: {
            /** @constant */
            status: "ready";
            checks: {
                [key: string]: "ok";
            };
        };
        CreateSessionResponse: {
            /** Format: uuid */
            session_id: string;
            turn_id: string;
            /** Format: uuid */
            receipt_id: string;
            /** @enum {string} */
            receipt_status: "accepted" | "succeeded" | "failed" | "unknown";
            /** @enum {string} */
            status: "queued" | "running" | "needs_input" | "idle" | "failed" | "stopped";
        };
        ListSessionsResponse: {
            items: components["schemas"]["SessionSummary"][];
            next_cursor: string | null;
        };
        CountSessionsResponse: {
            /** @description For each status, how many items GET /v1/sessions would list with that `status` and the same `relation` and `q`, read to the last page. */
            counts: {
                queued: number;
                running: number;
                needs_input: number;
                idle: number;
                failed: number;
                stopped: number;
            };
            total: number;
        };
        SessionSummary: {
            /** Format: uuid */
            id: string;
            /**
             * @description The session's name: the `title` it was created or renamed with, or else one derived from its first message (whitespace collapsed, cut to 80 characters with a trailing ellipsis). Null for sessions created before titles existed and for a first message with no text.
             * @default null
             */
            title: string | null;
            /**
             * @description The agent the session was created for and the version number of the release it is pinned to. `name` is the agent's name now, not when the session started. Null for a session created without `agent_release_id`.
             * @default null
             */
            agent: {
                /** Format: uuid */
                id: string;
                name: string;
                release_version_no: number;
            } | null;
            /**
             * @description Who started the session: the signed-in person, or for an API key the person who created the key. It stays the same after a takeover hands the session to someone else. Null for sessions from before people were recorded and for a key with no creator.
             * @default null
             */
            created_by: {
                /** Format: uuid */
                user_id: string;
                display_name: string;
            } | null;
            /**
             * @description Where the request that created the session came from: `web` for the console, `api` for an API key, `slack` for a chat surface. Null for an older session whose creating request cannot be told from what was recorded.
             * @default null
             */
            channel: ("web" | "slack" | "api") | null;
            revision: number;
            /** @enum {string} */
            admission_state: "active" | "pausing" | "paused" | "resuming" | "stopping" | "stopped" | "recovery_required" | "closing" | "closed";
            /**
             * @description needs_input is derived when read: a running session or turn with at least one pending request a client can still answer (open, unexpired, raised by the attempt that holds the turn). It returns to running as soon as none is left, whether by an answer, the worker settling the request, expiry or the attempt losing the session, with no change to updated_at. The event stream reports both edges as status events: needs_input right after the question that opened the wait, and the status read here once the wait ends — at the answer or settlement that ended it, or within one reconciler pass when nothing was written (expiry, a lost attempt).
             * @enum {string}
             */
            status: "queued" | "running" | "needs_input" | "idle" | "failed" | "stopped";
            runtime: {
                /** @enum {string} */
                kind: "claude_agent_sdk" | "codex_app_server" | "pi_coding_agent";
                version: string;
                profile_id: string;
                /** @description The model the session runs: the one named at create, or the profile's default. */
                model: string;
                /** @enum {string} */
                permission_mode: "default" | "acceptEdits" | "dontAsk" | "plan" | "bypassPermissions" | "auto";
            } | null;
            /** @description The model the session was created to run: the one named at create, else the agent release's card model, else the profile's default. Changing the session's profile sets it to the new profile's default. Null for a session from before the field whose model could not be told from its catalog entry. */
            model: string | null;
            repository_id: string | null;
            /**
             * @description The repository the session was created against, as the session recorded it then: a later catalog change or removal does not alter it. Null for a session created without a repository.
             * @default null
             */
            repository: components["schemas"]["SessionRepository"] | null;
            current_turn_id: string | null;
            queued_turn_count: number;
            last_event_at: string | null;
            /** @description What the session's newest events did, for a list card. Absent from a server older than the field. */
            activity?: {
                /** @description The newest text with a non-blank line or tool call in the window's `assistant` and `tool_use` events, a subagent's included. Null when the window has neither. */
                last: ({
                    /** @constant */
                    kind: "text";
                    /** @description The first non-blank line of the text, trimmed and cut to 200 code points. */
                    text: string;
                } | {
                    /** @constant */
                    kind: "tool";
                    /** @description The tool_use name; empty when the call named none. */
                    name: string;
                    /** @description What the call acts on, the first of its input's `command`, `file_path`, `path`, `pattern`, `url`, `query` or `description` that is a non-empty string; empty when none is. */
                    target: string;
                }) | null;
                /** @description Distinct tool_use ids called in the window. */
                tool_count: number;
                /** @description Of those calls, the ones whose tool_result has `is_error: true`. A call left without a result is not counted. */
                error_count: number;
                /** @description Subagent runs in the window: one per `Task` or `Agent` call, and one per call the window's events name as `parent_tool_use_id`, whether or not that call is in the window. */
                subagent_count: number;
                /** @description The newest call still open: no tool_result yet, and neither a `result` of its turn nor a status of a session that stopped working (anything but `running`, `needs_input`, `interrupting`) came after it. Such a call reads `interrupted` and is never current. */
                current_tool: {
                    id: string;
                    /** @description The tool_use name; empty when the call named none. */
                    name: string;
                    /** @description What the call acts on, the first of its input's `command`, `file_path`, `path`, `pattern`, `url`, `query` or `description` that is a non-empty string; empty when none is. */
                    target: string;
                    /**
                     * @description `waiting` while a question for the call is unanswered: the session has not moved past `needs_input` since it was asked.
                     * @enum {string}
                     */
                    state: "running" | "waiting";
                    /**
                     * Format: date-time
                     * @description When the call was made, or for `waiting` when its question was asked.
                     */
                    since: string;
                    /** @description What the call waits on: the newest question the session asked for it. Null unless `state` is `waiting`. */
                    request: {
                        /** @enum {string} */
                        kind: "permission" | "question";
                        /** @description For `question`, the first question's text, trimmed and cut to 200 code points; null for `permission` and for a question with no text. */
                        prompt: string | null;
                    } | null;
                } | null;
                /** @description The events the counts read: the session's newest 500 as recorded. They are ordered by `occurred_at`, and events at the same instant in the order they were recorded. */
                window: {
                    events: number;
                    /** @description True when the window holds every event of the session, so the counts are the session's own. */
                    complete: boolean;
                    /** @description When the oldest event of the window was recorded; null for a session with none. */
                    since: string | null;
                };
            };
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            updated_at: string;
        };
        SessionRepository: {
            /** @description The catalog key, as `repository_id`. Null for a session created before the catalog existed. */
            id: string | null;
            /** @description A name to show: the path of the repository's http(s) URL without host, credentials, query or `.git` (`owner/name`, or `group/sub/name`), or else the catalog key; null when neither exists. Never the URL itself, which may embed a credential. */
            full_name: string | null;
            /** @description The branch the session's workspace was cloned from. Not the branch a push writes to (`agent/<session-id>`). */
            branch: string;
        };
        SessionDetail: {
            /** Format: uuid */
            id: string;
            /**
             * @description The session's name: the `title` it was created or renamed with, or else one derived from its first message (whitespace collapsed, cut to 80 characters with a trailing ellipsis). Null for sessions created before titles existed and for a first message with no text.
             * @default null
             */
            title: string | null;
            /**
             * @description The agent the session was created for and the version number of the release it is pinned to. `name` is the agent's name now, not when the session started. Null for a session created without `agent_release_id`.
             * @default null
             */
            agent: {
                /** Format: uuid */
                id: string;
                name: string;
                release_version_no: number;
            } | null;
            /**
             * @description Who started the session: the signed-in person, or for an API key the person who created the key. It stays the same after a takeover hands the session to someone else. Null for sessions from before people were recorded and for a key with no creator.
             * @default null
             */
            created_by: {
                /** Format: uuid */
                user_id: string;
                display_name: string;
            } | null;
            /**
             * @description Where the request that created the session came from: `web` for the console, `api` for an API key, `slack` for a chat surface. Null for an older session whose creating request cannot be told from what was recorded.
             * @default null
             */
            channel: ("web" | "slack" | "api") | null;
            revision: number;
            /** @enum {string} */
            admission_state: "active" | "pausing" | "paused" | "resuming" | "stopping" | "stopped" | "recovery_required" | "closing" | "closed";
            /**
             * @description needs_input is derived when read: a running session or turn with at least one pending request a client can still answer (open, unexpired, raised by the attempt that holds the turn). It returns to running as soon as none is left, whether by an answer, the worker settling the request, expiry or the attempt losing the session, with no change to updated_at. The event stream reports both edges as status events: needs_input right after the question that opened the wait, and the status read here once the wait ends — at the answer or settlement that ended it, or within one reconciler pass when nothing was written (expiry, a lost attempt).
             * @enum {string}
             */
            status: "queued" | "running" | "needs_input" | "idle" | "failed" | "stopped";
            runtime: {
                /** @enum {string} */
                kind: "claude_agent_sdk" | "codex_app_server" | "pi_coding_agent";
                version: string;
                profile_id: string;
                /** @description The model the session runs: the one named at create, or the profile's default. */
                model: string;
                /** @enum {string} */
                permission_mode: "default" | "acceptEdits" | "dontAsk" | "plan" | "bypassPermissions" | "auto";
            } | null;
            /** @description The model the session was created to run: the one named at create, else the agent release's card model, else the profile's default. Changing the session's profile sets it to the new profile's default. Null for a session from before the field whose model could not be told from its catalog entry. */
            model: string | null;
            repository_id: string | null;
            /**
             * @description The repository the session was created against, as the session recorded it then: a later catalog change or removal does not alter it. Null for a session created without a repository.
             * @default null
             */
            repository: components["schemas"]["SessionRepository"] | null;
            current_turn_id: string | null;
            queued_turn_count: number;
            last_event_at: string | null;
            /** @description What the session's newest events did, for a list card. Absent from a server older than the field. */
            activity?: {
                /** @description The newest text with a non-blank line or tool call in the window's `assistant` and `tool_use` events, a subagent's included. Null when the window has neither. */
                last: ({
                    /** @constant */
                    kind: "text";
                    /** @description The first non-blank line of the text, trimmed and cut to 200 code points. */
                    text: string;
                } | {
                    /** @constant */
                    kind: "tool";
                    /** @description The tool_use name; empty when the call named none. */
                    name: string;
                    /** @description What the call acts on, the first of its input's `command`, `file_path`, `path`, `pattern`, `url`, `query` or `description` that is a non-empty string; empty when none is. */
                    target: string;
                }) | null;
                /** @description Distinct tool_use ids called in the window. */
                tool_count: number;
                /** @description Of those calls, the ones whose tool_result has `is_error: true`. A call left without a result is not counted. */
                error_count: number;
                /** @description Subagent runs in the window: one per `Task` or `Agent` call, and one per call the window's events name as `parent_tool_use_id`, whether or not that call is in the window. */
                subagent_count: number;
                /** @description The newest call still open: no tool_result yet, and neither a `result` of its turn nor a status of a session that stopped working (anything but `running`, `needs_input`, `interrupting`) came after it. Such a call reads `interrupted` and is never current. */
                current_tool: {
                    id: string;
                    /** @description The tool_use name; empty when the call named none. */
                    name: string;
                    /** @description What the call acts on, the first of its input's `command`, `file_path`, `path`, `pattern`, `url`, `query` or `description` that is a non-empty string; empty when none is. */
                    target: string;
                    /**
                     * @description `waiting` while a question for the call is unanswered: the session has not moved past `needs_input` since it was asked.
                     * @enum {string}
                     */
                    state: "running" | "waiting";
                    /**
                     * Format: date-time
                     * @description When the call was made, or for `waiting` when its question was asked.
                     */
                    since: string;
                    /** @description What the call waits on: the newest question the session asked for it. Null unless `state` is `waiting`. */
                    request: {
                        /** @enum {string} */
                        kind: "permission" | "question";
                        /** @description For `question`, the first question's text, trimmed and cut to 200 code points; null for `permission` and for a question with no text. */
                        prompt: string | null;
                    } | null;
                } | null;
                /** @description The events the counts read: the session's newest 500 as recorded. They are ordered by `occurred_at`, and events at the same instant in the order they were recorded. */
                window: {
                    events: number;
                    /** @description True when the window holds every event of the session, so the counts are the session's own. */
                    complete: boolean;
                    /** @description When the oldest event of the window was recorded; null for a session with none. */
                    since: string | null;
                };
            };
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            updated_at: string;
            execution: {
                /** @enum {string} */
                backend: "local_docker" | "kubernetes" | "lambda_microvm";
                /** @enum {string} */
                state: "pending" | "running" | "suspended" | "terminating" | "terminated" | "unknown";
                observed_at: string | null;
            } | null;
            checkpoint_revision: number | null;
            /** @description The requests GET /v1/sessions/{id}/pending-requests lists, counted in the same read as status: status reads needs_input exactly when this is above zero and the session would otherwise read running. */
            pending_request_count: number;
            attention: ({
                /** @constant */
                code: "PAUSE_BLOCKED";
                /** @enum {string} */
                reason: "long_turn" | "pending_request" | "mirror_error" | "checkpoint_unavailable";
            } | {
                /** @constant */
                code: "CLOSE_BLOCKED";
                /** @enum {string} */
                reason: "long_turn" | "pending_request" | "mirror_error" | "checkpoint_unavailable" | "execution_pending";
            } | {
                /** @constant */
                code: "BUDGET_EXCEEDED";
                reason: string;
            } | {
                /** @constant */
                code: "CONTEXT_GAP";
                last_ran_turn_id: string;
                checkpointed_turn_id: string | null;
            } | {
                /** @constant */
                code: "CATALOG_MISMATCH";
                reason: string;
            } | {
                /** @constant */
                code: "RESTORE_FAILED";
                reason: string;
                failures: number;
                retry_at: string | null;
            } | {
                /** @constant */
                code: "STARTUP_FAILED";
                reason: string;
                failures: number;
                retry_at: string | null;
            } | {
                /** @constant */
                code: "TRANSCRIPT_LIMIT";
                /** @enum {string} */
                reason: "transcript_near_limit" | "transcript_too_large" | "transcript_part_too_large";
                transcript_bytes: number | null;
                limit_bytes: number;
            }) | null;
            durability: components["schemas"]["SessionDurability"];
        };
        SessionDurability: {
            last_transcript_persisted_at: string | null;
            checkpoint_committed_at: string | null;
            checkpoint_revision: number | null;
            last_completed_turn_id: string | null;
            last_checkpointed_turn_id: string | null;
            checkpoint_pending_reason: string | null;
            checkpoint_fallback_revision: number | null;
            context_reset_turn_id: string | null;
        };
        PostSessionMessageResponse: {
            turn_id: string;
            /** Format: uuid */
            receipt_id: string;
            /** @enum {string} */
            receipt_status: "accepted" | "succeeded" | "failed" | "unknown";
        };
        ListTurnsResponse: {
            items: components["schemas"]["TurnSummary"][];
            next_cursor: string | null;
        };
        TurnSummary: {
            turn_id: string;
            /** Format: uuid */
            session_id: string;
            /**
             * @description needs_input is derived when read, as for the session: a running turn with a pending request a client can still answer.
             * @enum {string}
             */
            status: "queued" | "running" | "needs_input" | "completed" | "failed" | "interrupted" | "cancelled" | "outcome_unknown";
            message: string;
            terminal_reason: string | null;
            /** @description The newest checkpoint this turn committed that a restore can still reach. A revision garbage collection removed, or one a start_fresh recovery decision retired, is not reported; null when none is left. */
            checkpoint_revision: number | null;
            /** Format: date-time */
            created_at: string;
            started_at: string | null;
            ended_at: string | null;
        };
        TurnDetail: {
            turn_id: string;
            /** Format: uuid */
            session_id: string;
            /**
             * @description needs_input is derived when read, as for the session: a running turn with a pending request a client can still answer.
             * @enum {string}
             */
            status: "queued" | "running" | "needs_input" | "completed" | "failed" | "interrupted" | "cancelled" | "outcome_unknown";
            message: string;
            terminal_reason: string | null;
            /** @description The newest checkpoint this turn committed that a restore can still reach. A revision garbage collection removed, or one a start_fresh recovery decision retired, is not reported; null when none is left. */
            checkpoint_revision: number | null;
            /** Format: date-time */
            created_at: string;
            started_at: string | null;
            ended_at: string | null;
            result: unknown | null;
            usage: unknown | null;
            attempts: {
                attempt_id: string;
                /** @enum {string} */
                state: "allocated" | "starting" | "running" | "draining" | "exited" | "lost";
                lease_epoch: number;
                execution_generation: number;
                started_at: string | null;
                ended_at: string | null;
                /** @description The profile the attempt ran: the session's when the attempt claimed it. A profile change reaches the next attempt, so this is what a turn ran on. Null for an attempt from before it was recorded. */
                profile_id: string | null;
            }[];
        };
        SseEvent: {
            id: string;
            /** @constant */
            event: "system";
            data: {
                /** @constant */
                schema_version: 1;
                /** Format: uuid */
                session_id: string;
                turn_id: string | null;
                attempt_id: string | null;
                /** Format: date-time */
                occurred_at: string;
                data: {
                    /** @constant */
                    type: "system";
                } & {
                    [key: string]: unknown;
                };
            };
        } | {
            id: string;
            /** @constant */
            event: "assistant";
            data: {
                /** @constant */
                schema_version: 1;
                /** Format: uuid */
                session_id: string;
                turn_id: string | null;
                attempt_id: string | null;
                /** Format: date-time */
                occurred_at: string;
                data: {
                    /** @constant */
                    type: "assistant";
                    message: unknown;
                    parent_tool_use_id?: string | null;
                };
            };
        } | {
            id: string;
            /** @constant */
            event: "tool_use";
            data: {
                /** @constant */
                schema_version: 1;
                /** Format: uuid */
                session_id: string;
                turn_id: string | null;
                attempt_id: string | null;
                /** Format: date-time */
                occurred_at: string;
                data: {
                    /** @constant */
                    type: "assistant";
                    message: unknown;
                    parent_tool_use_id?: string | null;
                };
            };
        } | {
            id: string;
            /** @constant */
            event: "tool_result";
            data: {
                /** @constant */
                schema_version: 1;
                /** Format: uuid */
                session_id: string;
                turn_id: string | null;
                attempt_id: string | null;
                /** Format: date-time */
                occurred_at: string;
                data: unknown;
            };
        } | {
            id: string;
            /** @constant */
            event: "question";
            data: {
                /** @constant */
                schema_version: 1;
                /** Format: uuid */
                session_id: string;
                turn_id: string | null;
                attempt_id: string | null;
                /** Format: date-time */
                occurred_at: string;
                data: {
                    request_id: string;
                    tool_use_id: string;
                    /** @enum {string} */
                    kind: "permission" | "question";
                    tool?: string;
                    input: unknown;
                    /** Format: date-time */
                    expires_at?: string;
                };
            };
        } | {
            id: string;
            /** @constant */
            event: "result";
            data: {
                /** @constant */
                schema_version: 1;
                /** Format: uuid */
                session_id: string;
                turn_id: string | null;
                attempt_id: string | null;
                /** Format: date-time */
                occurred_at: string;
                data: {
                    /** @constant */
                    type: "result";
                    subtype: string;
                    session_id: string;
                    usage?: unknown;
                } & {
                    [key: string]: unknown;
                };
            };
        } | {
            id: string;
            /** @constant */
            event: "status";
            data: {
                /** @constant */
                schema_version: 1;
                /** Format: uuid */
                session_id: string;
                turn_id: string | null;
                attempt_id: string | null;
                /** Format: date-time */
                occurred_at: string;
                data: {
                    /** @enum {string} */
                    phase: "queued" | "running" | "needs_input" | "idle" | "failed" | "stopped" | "interrupting" | "engine_stopped";
                    /** @enum {string} */
                    admission_state?: "active" | "pausing" | "paused" | "resuming" | "stopping" | "stopped" | "recovery_required" | "closing" | "closed";
                    title?: string;
                } & {
                    [key: string]: unknown;
                };
            };
        } | {
            id: string;
            /** @constant */
            event: "error";
            data: {
                /** @constant */
                schema_version: 1;
                /** Format: uuid */
                session_id: string;
                turn_id: string | null;
                attempt_id: string | null;
                /** Format: date-time */
                occurred_at: string;
                data: {
                    message: string;
                    code?: string;
                } & {
                    [key: string]: unknown;
                };
            };
        };
        ListPendingRequestsResponse: {
            items: ({
                request_id: string;
                turn_id: string;
                attempt_id: string;
                /** Format: date-time */
                created_at: string;
                /** Format: date-time */
                expires_at: string;
                /** @constant */
                kind: "permission";
                tool: string;
                input: unknown;
            } | {
                request_id: string;
                turn_id: string;
                attempt_id: string;
                /** Format: date-time */
                created_at: string;
                /** Format: date-time */
                expires_at: string;
                /** @constant */
                kind: "question";
                questions: {
                    question_id: string;
                    prompt: string;
                    options: {
                        option_id: string;
                        label: string;
                    }[];
                    multi_select: boolean;
                    allow_free_text: boolean;
                }[];
            })[];
            /** @description Whether this caller may answer the session's requests: its creator, its agent's admins and the workspace's owners and admins may; someone who only sees it through its share may not (POST /answers is then 403). A hint for what to offer; the answer is judged again. */
            answerable: boolean;
        };
        ListTakeoversResponse: {
            items: {
                /** Format: uuid */
                session_id: string;
                /** Format: uuid */
                departed_user_id: string;
                /** @enum {string} */
                status: "queued" | "running" | "needs_input" | "idle" | "failed" | "stopped";
                /** Format: date-time */
                created_at: string;
                /** Format: date-time */
                takeover_required_at: string;
            }[];
        };
        SessionShare: {
            /** Format: uuid */
            session_id: string;
            /** @enum {string} */
            scope: "private" | "people" | "team" | "workspace";
            user_ids: string[];
            team_ids: string[];
            revision: number;
            updated_by: string | null;
            updated_at: string | null;
        };
        SetSessionShareResponse: {
            share: components["schemas"]["SessionShare"];
            receipt_id: string | null;
        };
        AuditReadResponse: {
            session: components["schemas"]["SessionDetail"];
            turns: components["schemas"]["ListTurnsResponse"];
        };
        ListAdminSessionsResponse: {
            items: {
                /** Format: uuid */
                session_id: string;
                created_by_user_id: string | null;
                created_by_api_key_id: string | null;
                agent_release_id: string | null;
                /** @enum {string} */
                status: "queued" | "running" | "needs_input" | "idle" | "failed" | "stopped";
                /** @enum {string} */
                admission_state: "active" | "pausing" | "paused" | "resuming" | "stopping" | "stopped" | "recovery_required" | "closing" | "closed";
                /** @enum {string} */
                share_scope: "private" | "people" | "team" | "workspace";
                /** Format: date-time */
                created_at: string;
                takeover_required_at: string | null;
            }[];
        };
        StartSlackLinkResponse: {
            /** Format: uri */
            authorize_url: string;
            /** Format: date-time */
            expires_at: string;
        };
        SlackLinkCallbackResponse: {
            linked_account: {
                /** Format: uuid */
                id: string;
                /** Format: uuid */
                user_id: string;
                /** @enum {string} */
                provider: "slack";
                external_tenant: string;
                external_user_id: string;
                external_tenant_name: string | null;
                external_user_name: string | null;
                /** @enum {string} */
                status: "active" | "stale" | "revoked";
                /** Format: date-time */
                verified_at: string;
                revision: number;
            };
            /** Format: uuid */
            receipt_id: string;
        };
        ListLinkedAccountsResponse: {
            items: {
                /** Format: uuid */
                id: string;
                /** Format: uuid */
                user_id: string;
                /** @enum {string} */
                provider: "slack";
                external_tenant: string;
                external_user_id: string;
                external_tenant_name: string | null;
                external_user_name: string | null;
                /** @enum {string} */
                status: "active" | "stale" | "revoked";
                /** Format: date-time */
                verified_at: string;
                revision: number;
            }[];
        };
        CreateInviteResponse: {
            /** Format: uuid */
            invite_id: string;
            invite_token: string;
            /** Format: date-time */
            expires_at: string;
        };
        ListInvitesResponse: {
            items: {
                /** Format: uuid */
                id: string;
                /** Format: uuid */
                workspace_id: string;
                /** Format: email */
                email: string;
                /** @enum {string} */
                role: "owner" | "admin" | "member";
                /** Format: uuid */
                invited_by: string;
                /** @enum {string} */
                status: "pending" | "accepted" | "revoked" | "expired";
                /** Format: date-time */
                expires_at: string;
                accepted_at: string | null;
                revoked_at: string | null;
                /** Format: date-time */
                created_at: string;
            }[];
        };
        AcceptInviteResponse: {
            /** Format: uuid */
            user_id: string;
            workspace: {
                /** Format: uuid */
                id: string;
                slug: string;
                name: string;
                settings: {
                    /** @default null */
                    dispatch_model: string | null;
                    /** @default false */
                    kill_switch: boolean;
                    /** @default null */
                    daily_cost_limit_usd: number | null;
                    /** @default 30 */
                    idle_pause_minutes: number;
                    /** @default 90 */
                    audit_retention_days: number;
                    /** @default false */
                    slack_guest_enabled: boolean;
                };
                /** Format: date-time */
                created_at: string;
            };
            /** @enum {string} */
            role: "owner" | "admin" | "member";
        };
        ListMembersResponse: {
            items: {
                /** Format: uuid */
                user_id: string;
                /** Format: email */
                email: string;
                display_name: string;
                /** @enum {string} */
                role: "owner" | "admin" | "member";
                disabled_at: string | null;
                /** Format: date-time */
                created_at: string;
                actions: {
                    change_role: {
                        owner: {
                            /** @constant */
                            allowed: true;
                        } | {
                            /** @constant */
                            allowed: false;
                            /** @enum {string} */
                            reason: "self_protected" | "owner_protected" | "last_owner" | "member_disabled" | "account_disabled" | "unchanged";
                        };
                        admin: {
                            /** @constant */
                            allowed: true;
                        } | {
                            /** @constant */
                            allowed: false;
                            /** @enum {string} */
                            reason: "self_protected" | "owner_protected" | "last_owner" | "member_disabled" | "account_disabled" | "unchanged";
                        };
                        member: {
                            /** @constant */
                            allowed: true;
                        } | {
                            /** @constant */
                            allowed: false;
                            /** @enum {string} */
                            reason: "self_protected" | "owner_protected" | "last_owner" | "member_disabled" | "account_disabled" | "unchanged";
                        };
                    };
                    disable: {
                        /** @constant */
                        allowed: true;
                    } | {
                        /** @constant */
                        allowed: false;
                        /** @enum {string} */
                        reason: "self_protected" | "owner_protected" | "last_owner" | "member_disabled" | "account_disabled" | "unchanged";
                    };
                    enable: {
                        /** @constant */
                        allowed: true;
                    } | {
                        /** @constant */
                        allowed: false;
                        /** @enum {string} */
                        reason: "self_protected" | "owner_protected" | "last_owner" | "member_disabled" | "account_disabled" | "unchanged";
                    };
                };
            }[];
            next_cursor: string | null;
            /** @description The roles the caller may invite someone as now (POST /v1/invites refuses any other with OWNER_PROTECTED). The same on every page and search. */
            assignable_roles: ("owner" | "admin" | "member")[];
        };
        MemberView: {
            /** Format: uuid */
            user_id: string;
            /** Format: email */
            email: string;
            display_name: string;
            /** @enum {string} */
            role: "owner" | "admin" | "member";
            disabled_at: string | null;
            /** Format: date-time */
            created_at: string;
        };
        SetAccessResponse: {
            member: components["schemas"]["MemberView"];
            receipt_id: string | null;
        };
        PushRequest: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            session_id: string;
            repository_id: string;
            checkpoint_revision: number;
            git_commit: string;
            target_branch: string;
            /** @enum {string} */
            state: "requested" | "approved" | "rejected" | "pushing" | "pushed" | "failed";
            requested_by: {
                principal: {
                    /** @enum {string} */
                    kind: "api_key" | "user" | "installation";
                    id: string;
                };
                actor_user_id: string | null;
                agent_id: string | null;
            };
            /** Format: date-time */
            requested_at: string;
            decided_by: {
                principal: {
                    /** @enum {string} */
                    kind: "api_key" | "user" | "installation";
                    id: string;
                };
                actor_user_id: string | null;
                agent_id: string | null;
            } | null;
            decided_at: string | null;
            decision_reason: string | null;
            /** Format: uuid */
            request_receipt_id: string;
            decision_receipt_id: string | null;
            finished_at: string | null;
            push_receipt_id: string | null;
        };
        ListPushRequestsResponse: {
            items: components["schemas"]["PushRequest"][];
        };
        OpenPullRequestResponse: {
            pull_request: {
                /** Format: uuid */
                push_request_id: string;
                /** Format: uuid */
                session_id: string;
                repository_id: string;
                number: number;
                /** Format: uri */
                url: string;
                head: string;
                base: string;
                /** Format: date-time */
                created_at: string;
                /** Format: uuid */
                receipt_id: string;
            };
            created: boolean;
            /** Format: uuid */
            receipt_id: string;
        };
        CommentPullRequestResponse: {
            pull_request: {
                /** Format: uuid */
                push_request_id: string;
                /** Format: uuid */
                session_id: string;
                repository_id: string;
                number: number;
                /** Format: uri */
                url: string;
                head: string;
                base: string;
                /** Format: date-time */
                created_at: string;
                /** Format: uuid */
                receipt_id: string;
            };
            comment: {
                id: number;
                /** Format: uri */
                url: string;
                marker: string;
                created: boolean;
            };
            /** Format: uuid */
            receipt_id: string;
        };
        ReceiptAcceptedResponse: {
            /** Format: uuid */
            receipt_id: string;
            /** @enum {string} */
            receipt_status: "accepted" | "succeeded" | "failed" | "unknown";
        };
        TerminateSessionResponse: {
            /** Format: uuid */
            receipt_id: string;
            /** @enum {string} */
            receipt_status: "accepted" | "succeeded" | "failed" | "unknown";
            /** @constant */
            external_effects_reverted: false;
        };
        Receipt: {
            /** Format: uuid */
            id: string;
            /** @enum {string} */
            operation: "create_session" | "append_message" | "answer" | "interrupt" | "pause" | "close" | "terminate" | "resume" | "recovery_decision" | "change_profile" | "revoke_execution" | "issue_password_reset" | "reset_password" | "recover_owner" | "takeover" | "link_account" | "unlink_account" | "invite_member" | "accept_invite" | "revoke_invite" | "change_member_role" | "disable_member" | "enable_member" | "disable_user" | "enable_user" | "create_agent" | "update_agent" | "create_agent_release" | "activate_agent" | "create_api_key" | "revoke_api_key" | "create_team" | "rename_team" | "delete_team" | "add_team_member" | "remove_team_member" | "add_agent_admin" | "remove_agent_admin" | "bind_credential" | "unbind_credential" | "link_agent_identity" | "revoke_agent_identity" | "set_surface_binding" | "share_session" | "request_push" | "decide_push" | "push" | "open_pull_request" | "comment_pull_request" | "call_mcp" | "set_slack_secret" | "delete_slack_secret";
            target_ref: {
                /** Format: uuid */
                session_id: string;
                turn_id: string | null;
                request_id: string | null;
            } | {
                resource: {
                    /** @enum {string} */
                    kind: "workspace" | "session" | "invite" | "agent" | "agent_release" | "surface_binding" | "session_link" | "dispatch" | "memory" | "routine" | "artifact" | "api_key" | "team";
                    id: string;
                };
                workspace_id: string | null;
            } | {
                /** Format: uuid */
                user_id: string;
                /** Format: uuid */
                workspace_id: string;
            };
            actor?: {
                principal: {
                    /** @enum {string} */
                    kind: "api_key" | "user" | "installation";
                    id: string;
                };
                actor_user_id: string | null;
                agent_id: string | null;
            };
            /** @enum {string} */
            status: "accepted" | "succeeded" | "failed" | "unknown";
            /** @description For create_session and append_message: the acceptance response exactly as first returned, never rewritten; its receipt_status and status are acceptance-time values. The current outcome is this receipt's status and error; the turn's result is read from GET /v1/sessions/{session_id}/turns/{turn_id} using target_ref. For interrupt: `{turn_id, terminal, no_op}` once settled, where `no_op: true` means the turn reached `terminal` on its own and the interrupt did nothing. */
            result: unknown | null;
            error: {
                /** @enum {string} */
                code: "BAD_REQUEST" | "UNAUTHORIZED" | "FORBIDDEN" | "BOOTSTRAP_DONE" | "NOT_FOUND" | "PAYLOAD_TOO_LARGE" | "REQUEST_TIMEOUT" | "UNSUPPORTED_CAPABILITY" | "RATE_LIMITED" | "STORAGE_LIMIT_EXCEEDED" | "BUDGET_EXCEEDED" | "INTERNAL_ERROR" | "REVISION_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "REQUEST_EXPIRED" | "REQUEST_STALE" | "SESSION_PAUSED" | "SESSION_RESUMING" | "SESSION_CLOSED" | "SESSION_CLOSING" | "SESSION_STOPPED" | "RECOVERY_REQUIRED" | "CHECKPOINT_UNAVAILABLE" | "PAUSE_COMMITTING" | "PAUSE_CANCELLED" | "CONTROL_SUPERSEDED" | "TURN_NOT_STARTED" | "BACKEND_UNAVAILABLE" | "LAUNCH_FAILED" | "CATALOG_MISMATCH" | "TAKEOVER_REQUIRED" | "SLACK_NOT_INSTALLED" | "LINK_TEAM_MISMATCH" | "LINK_TAKEN" | "LINK_EXISTS" | "AGENT_IDENTITY_TAKEN" | "CONFIG_TOKEN_INVALID" | "SLACK_APP_CREATING" | "AGENT_NOT_ACTIVE" | "SLACK_INSTALL_STATE_INVALID" | "SLACK_INSTALL_DENIED" | "SLACK_INSTALL_REJECTED" | "SLACK_INSTALL_CONFLICT" | "SLACK_LINK_NOT_CONFIGURED" | "INVITE_EXPIRED" | "INVITE_USED" | "LAST_OWNER" | "OWNER_PROTECTED" | "SELF_PROTECTED" | "MEMBER_DISABLED" | "ACCOUNT_DISABLED" | "SCOPE_NOT_GRANTABLE" | "RELEASE_PROFILE_MISMATCH" | "CREDENTIAL_UNBOUND" | "CREDENTIAL_REF_IN_USE" | "LOGIN_LINK_REQUIRED" | "PROFILE_DIGEST_MISMATCH" | "ALREADY_EXISTS" | "NOT_READY" | "CURSOR_EXPIRED" | "LEASE_EXPIRED" | "STALE_EPOCH" | "PUSH_SOURCE_MISSING" | "PUSH_REQUEST_OPEN" | "PUSH_REQUEST_DECIDED" | "CHECKPOINT_MOVED" | "PUSH_NOT_PUSHED" | "PULL_REQUEST_MISSING";
                message: string;
            } | null;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            updated_at: string;
        };
        BootstrapResponse: {
            /** Format: uuid */
            user_id: string;
            workspace: {
                /** Format: uuid */
                id: string;
                slug: string;
                name: string;
                settings: {
                    /** @default null */
                    dispatch_model: string | null;
                    /** @default false */
                    kill_switch: boolean;
                    /** @default null */
                    daily_cost_limit_usd: number | null;
                    /** @default 30 */
                    idle_pause_minutes: number;
                    /** @default 90 */
                    audit_retention_days: number;
                    /** @default false */
                    slack_guest_enabled: boolean;
                };
                /** Format: date-time */
                created_at: string;
            };
            /** @constant */
            role: "owner";
        };
        LoginResponse: {
            /** Format: uuid */
            user_id: string;
            /** Format: uuid */
            workspace_id: string;
            /** @enum {string} */
            role: "owner" | "admin" | "member";
            scopes: ("sessions:read" | "sessions:write" | "sessions:approve" | "sessions:control" | "sessions:recover")[];
            /** Format: date-time */
            expires_at: string;
        };
        LoginMethodsResponse: {
            methods: ("password" | "google")[];
        };
        StartGoogleLoginResponse: {
            /** Format: uri */
            authorization_url: string;
        };
        IssuePasswordResetRequest: {
            current_password: string;
        };
        IssuePasswordResetResponse: {
            /** Format: uuid */
            user_id: string;
            token: string;
            /** Format: date-time */
            expires_at: string;
        };
        AuditRetentionResponse: {
            audit_retention_days: number;
        };
        SlackGuestResponse: {
            slack_guest_enabled: boolean;
        };
        SlackSecretSummary: {
            configured: boolean;
            last4: string | null;
            updated_at: string | null;
            updated_by: {
                /** Format: uuid */
                user_id: string;
                display_name: string;
            } | null;
        };
        PutSlackSecretResponse: {
            configured: boolean;
            last4: string | null;
            updated_at: string | null;
            updated_by: {
                /** Format: uuid */
                user_id: string;
                display_name: string;
            } | null;
            /** Format: uuid */
            receipt_id: string;
        };
        DeleteSlackSecretResponse: {
            /** Format: uuid */
            receipt_id: string;
        };
        SlackConfigTokenSummary: {
            configured: boolean;
            last4: string | null;
            updated_at: string | null;
            updated_by: {
                /** Format: uuid */
                user_id: string;
                display_name: string;
            } | null;
            /** @enum {string} */
            state: "unset" | "active" | "needs_reentry";
            expires_at: string | null;
            issuer: {
                user_id: string;
                team_id: string;
            } | null;
        };
        PutSlackConfigTokenResponse: {
            configured: boolean;
            last4: string | null;
            updated_at: string | null;
            updated_by: {
                /** Format: uuid */
                user_id: string;
                display_name: string;
            } | null;
            /** @enum {string} */
            state: "unset" | "active" | "needs_reentry";
            expires_at: string | null;
            issuer: {
                user_id: string;
                team_id: string;
            } | null;
            /** Format: uuid */
            receipt_id: string;
            warnings: {
                /** @constant */
                code: "config_token_issuer_changed";
                previous_user_id: string;
                user_id: string;
            }[];
        };
        GetSlackAppResponse: {
            slack_app: {
                /** Format: uuid */
                id: string;
                /** @enum {string} */
                kind: "agent" | "link" | "manual";
                agent_id: string | null;
                /** @enum {string} */
                state: "creating" | "created" | "failed" | "abandoned" | "deleting" | "deleted";
                app_id: string | null;
                client_id: string | null;
                /** Format: uri */
                redirect_url: string;
                created_by_token_user: string | null;
                /** Format: date-time */
                created_at: string;
                /** Format: date-time */
                updated_at: string;
                secrets: {
                    slack_signing_secret: components["schemas"]["SlackSecretSummary"];
                    slack_client_secret: components["schemas"]["SlackSecretSummary"];
                    slack_bot_token: components["schemas"]["SlackSecretSummary"];
                };
            } | null;
            event_url: string | null;
            events: {
                /** @enum {string} */
                state: "verified" | "pending" | "failed";
                checked_at: string | null;
                error?: string;
            };
        };
        GetSlackAppManifestResponse: {
            manifest_yaml: string;
        };
        SlackAppSettings: {
            /** @enum {string} */
            default_mode: "off" | "mention";
        };
        CreateSlackAppResponse: {
            slack_app: {
                /** Format: uuid */
                id: string;
                /** @enum {string} */
                kind: "agent" | "link" | "manual";
                agent_id: string | null;
                /** @enum {string} */
                state: "creating" | "created" | "failed" | "abandoned" | "deleting" | "deleted";
                app_id: string | null;
                client_id: string | null;
                /** Format: uri */
                redirect_url: string;
                created_by_token_user: string | null;
                /** Format: date-time */
                created_at: string;
                /** Format: date-time */
                updated_at: string;
                secrets: {
                    slack_signing_secret: components["schemas"]["SlackSecretSummary"];
                    slack_client_secret: components["schemas"]["SlackSecretSummary"];
                    slack_bot_token: components["schemas"]["SlackSecretSummary"];
                };
            };
            created: boolean;
            warnings: {
                /** @constant */
                code: "config_token_issuer_changed";
                previous_user_id: string;
                user_id: string;
            }[];
        };
        DeleteSlackAppResponse: {
            slack_app: {
                /** Format: uuid */
                id: string;
                /** @enum {string} */
                kind: "agent" | "link" | "manual";
                agent_id: string | null;
                /** @enum {string} */
                state: "creating" | "created" | "failed" | "abandoned" | "deleting" | "deleted";
                app_id: string | null;
                client_id: string | null;
                /** Format: uri */
                redirect_url: string;
                created_by_token_user: string | null;
                /** Format: date-time */
                created_at: string;
                /** Format: date-time */
                updated_at: string;
                secrets: {
                    slack_signing_secret: components["schemas"]["SlackSecretSummary"];
                    slack_client_secret: components["schemas"]["SlackSecretSummary"];
                    slack_bot_token: components["schemas"]["SlackSecretSummary"];
                };
            };
        };
        StartSlackInstallResponse: {
            /** Format: uri */
            authorize_url: string;
            /** Format: date-time */
            expires_at: string;
        };
        CompleteSlackInstallResponse: {
            slack_app: {
                /** Format: uuid */
                id: string;
                /** @enum {string} */
                kind: "agent" | "link" | "manual";
                agent_id: string | null;
                /** @enum {string} */
                state: "creating" | "created" | "failed" | "abandoned" | "deleting" | "deleted";
                app_id: string | null;
                client_id: string | null;
                /** Format: uri */
                redirect_url: string;
                created_by_token_user: string | null;
                /** Format: date-time */
                created_at: string;
                /** Format: date-time */
                updated_at: string;
                secrets: {
                    slack_signing_secret: components["schemas"]["SlackSecretSummary"];
                    slack_client_secret: components["schemas"]["SlackSecretSummary"];
                    slack_bot_token: components["schemas"]["SlackSecretSummary"];
                };
            };
            installation: {
                /** Format: uuid */
                id: string;
                app_id: string;
                team_id: string;
                bot_user_id: string;
                /** @constant */
                status: "verified";
            };
            agent_identity: {
                /** Format: uuid */
                id: string;
                /** Format: uuid */
                agent_id: string;
                /** @enum {string} */
                provider: "slack_bot";
                app_id: string;
                team_id: string;
                bot_user_id: string;
                credential_ref: string;
                /** @enum {string} */
                status: "active" | "revoked";
                revision: number;
                created_by: string | null;
                /** Format: date-time */
                created_at: string;
                revoked_at: string | null;
            };
            receipt_id: string | null;
            finalized: boolean;
            warnings: {
                /** @enum {string} */
                code: "events_url_unset" | "reinstall_required" | "finalize_failed" | "awaiting_invite" | "config_error" | "join_failed";
                channel_id?: string;
                error?: string;
            }[];
        };
        SlackEventsResponse: {
            challenge: string;
        } | {
            /** @constant */
            ok: true;
        };
        PasswordResetResponse: {
            /** Format: uuid */
            user_id: string;
            /** Format: uuid */
            receipt_id: string;
        };
        AuthMeResponse: {
            principal: {
                /** @constant */
                kind: "api_key";
                id: string;
                owner_id: string;
                workspace_id: string | null;
                scopes: ("sessions:read" | "sessions:write" | "sessions:approve" | "sessions:control" | "sessions:recover")[];
            } | {
                /** @constant */
                kind: "user";
                /** Format: uuid */
                id: string;
                /** Format: uuid */
                workspace_id: string;
                /** @enum {string} */
                role: "owner" | "admin" | "member";
                scopes: ("sessions:read" | "sessions:write" | "sessions:approve" | "sessions:control" | "sessions:recover")[];
            } | {
                /** @constant */
                kind: "installation";
                /** Format: uuid */
                id: string;
                owner_id: string;
                /** Format: uuid */
                workspace_id: string;
                scopes: ("sessions:read" | "sessions:write" | "sessions:approve" | "sessions:control")[];
            };
            user: {
                /** Format: uuid */
                id: string;
                /** Format: email */
                email: string;
                display_name: string;
            } | null;
            workspace: {
                /** Format: uuid */
                id: string;
                slug: string;
                name: string;
                settings: {
                    /** @default null */
                    dispatch_model: string | null;
                    /** @default false */
                    kill_switch: boolean;
                    /** @default null */
                    daily_cost_limit_usd: number | null;
                    /** @default 30 */
                    idle_pause_minutes: number;
                    /** @default 90 */
                    audit_retention_days: number;
                    /** @default false */
                    slack_guest_enabled: boolean;
                };
                /** Format: date-time */
                created_at: string;
            } | null;
            scopes: ("sessions:read" | "sessions:write" | "sessions:approve" | "sessions:control" | "sessions:recover")[];
            permissions: ("workspace.read" | "workspace.manage" | "audit_retention.manage" | "member.manage" | "team.manage" | "api_key.manage" | "api_key.manage_own" | "account.link" | "agent.create" | "agent.manage" | "agent.restore" | "agent.admin.manage" | "credential.bind" | "binding.manage" | "routine.manage" | "session.read" | "session.submit" | "session.approve" | "session.control" | "session.recover" | "session.share" | "session.rename" | "session.audit_read" | "session.admin_list" | "usage.installation_read" | "memory.read" | "memory.write" | "artifact.read" | "delivery.send")[];
        };
        InstallationLimitsResponse: {
            /** @constant */
            scope: "installation";
            /** Format: date-time */
            refreshed_at: string;
            limits: {
                execution_slot_limit: number;
                queued_input_limit_per_session: number;
                storage_limit_bytes: number;
                max_turn_seconds: number;
                session_cost_limit_usd: string;
                session_token_limit: number | null;
                provider_max_retries: number;
            };
            usage: {
                execution_slots_used: number;
                queued_input_count: number;
                storage: {
                    used_bytes: number;
                    accounted_content: "input_messages"[];
                    updated_at: string | null;
                };
            };
        };
        UsageSummaryResponse: {
            /** @enum {string} */
            scope: "installation" | "me";
            period: {
                /** Format: date-time */
                since: string;
                /** Format: date-time */
                until: string;
            };
            /** Format: date-time */
            refreshed_at: string;
            session_count: number;
            cost_usd: string;
            cost_complete: boolean;
            token_count: number;
            run_seconds: number;
            basis: {
                /** @constant */
                sessions: "created_in_period";
                /** @constant */
                cost: "provider_usage_estimate";
                /** @constant */
                run_time: "turn_wall_clock";
            };
        };
        UsageSeriesResponse: {
            period: {
                /** Format: date-time */
                since: string;
                /** Format: date-time */
                until: string;
            };
            /** Format: date-time */
            refreshed_at: string;
            buckets: {
                /** Format: date */
                date: string;
                session_count: number;
                cost_usd: string;
                cost_complete: boolean;
                token_count: number;
                run_seconds: number;
            }[];
        };
        UsageBreakdownResponse: {
            rows: {
                session_count: number;
                input_tokens: number;
                output_tokens: number;
                cache_read_input_tokens: number;
                cache_creation_input_tokens: number;
                token_count: number;
                cost_usd: string;
                key: string | null;
                label: string | null;
            }[];
            totals: {
                session_count: number;
                input_tokens: number;
                output_tokens: number;
                cache_read_input_tokens: number;
                cache_creation_input_tokens: number;
                token_count: number;
                cost_usd: string;
            };
        };
        UsageToolsResponse: {
            tools: {
                name: string;
                calls: number;
                failed: number;
                total_ms: number;
                median_ms: number;
                max_ms: number;
            }[];
            findings: {
                /** @enum {string} */
                kind: "most_time" | "fails_often" | "slowest";
                name: string;
            }[];
        };
        UsageToolCallsResponse: {
            calls: {
                session_id: string | null;
                title: string | null;
                agent: string | null;
                /** Format: date-time */
                occurred_at: string;
                duration_ms: number | null;
                /** @enum {string} */
                outcome: "ok" | "failed" | "unknown";
            }[];
            next_cursor: string | null;
            per_day: {
                /** Format: date */
                date: string;
                calls: number;
            }[];
        };
        SessionUsageResponse: {
            /** Format: uuid */
            session_id: string;
            /** @constant */
            period: "session_lifetime";
            /** Format: date-time */
            refreshed_at: string;
            cost: {
                amount_usd: string;
                /** @enum {string} */
                kind: "estimated" | "unmetered";
                /** @constant */
                source: "provider_usage";
                /** @constant */
                completeness_scope: "turn_reports";
                complete: boolean;
                reported_turn_count: number;
                unreported_turn_count: number;
                open_turn_count: number;
            };
            cost_limit_usd: string | null;
            token_count: number;
            token_limit: number | null;
            budget_exceeded: boolean;
            queued_input_count: number;
            queued_input_limit: number;
        };
        ListSessionOutputsResponse: {
            /** Format: uuid */
            session_id: string;
            checkpoint_revision: number | null;
            items: {
                path: string;
                bytes: number;
                sha256: string | null;
                omitted: "too_large" | null;
            }[];
        };
        ListAgentsResponse: {
            items: {
                /** Format: uuid */
                id: string;
                /** Format: uuid */
                workspace_id: string;
                slug: string;
                name: string;
                /** @enum {string} */
                status: "active" | "paused" | "archived";
                active_release_id: string | null;
                activation_revision: number;
                created_by: string | null;
                /** Format: date-time */
                created_at: string;
                /** Format: date-time */
                updated_at: string;
                summary?: {
                    version: {
                        version_no: number;
                        role: string;
                        instructions: string;
                        mcp_servers: string[];
                        credential_refs: string[];
                    };
                    runtime_profile_id: string | null;
                    bound_credential_refs: string[];
                    admins: string[];
                };
            }[];
            next_cursor: string | null;
        };
        CountAgentsResponse: {
            counts: {
                /** @description How many agents GET /v1/agents lists, read to the last page. */
                all: number;
                /** @description How many of those the caller administers now, directly or through a team. */
                administered: number;
            };
        };
        ListProfilesResponse: {
            items: {
                id: string;
                model: string;
                tools: string[];
                /** @constant */
                runtime_kind: "claude_agent_sdk";
                runtime_version: string;
                /** @enum {string} */
                billing: "metered" | "none";
                /** @enum {string} */
                repository_mode: "required" | "optional" | "none";
            }[];
        };
        AgentDetail: {
            agent: {
                /** Format: uuid */
                id: string;
                /** Format: uuid */
                workspace_id: string;
                slug: string;
                name: string;
                /** @enum {string} */
                status: "active" | "paused" | "archived";
                active_release_id: string | null;
                activation_revision: number;
                created_by: string | null;
                /** Format: date-time */
                created_at: string;
                /** Format: date-time */
                updated_at: string;
            };
            versions: {
                /** Format: uuid */
                id: string;
                /** Format: uuid */
                agent_id: string;
                version_no: number;
                card: {
                    role: string;
                    instructions: string;
                    tone?: string;
                    /**
                     * @default ko
                     * @enum {string}
                     */
                    language: "ko" | "en";
                    model: string;
                    capabilities: {
                        tools: string[] | null;
                        mcp: {
                            server: string;
                        }[] | null;
                        /** @default [] */
                        forbidden: string[];
                        tool_policy?: {
                            default?: {
                                /** @enum {string} */
                                builtin?: "allow" | "ask" | "deny";
                                /** @enum {string} */
                                mcp?: "allow" | "ask" | "deny";
                            };
                            per_tool?: {
                                [key: string]: "allow" | "ask" | "deny";
                            };
                        };
                        credential_refs?: string[];
                    };
                    /** @default [] */
                    rules: {
                        id: string;
                        text: string;
                        /** @enum {string} */
                        source: "user" | "correction";
                    }[];
                };
                content_sha256: string;
                created_by: string | null;
                /** Format: date-time */
                created_at: string;
            }[];
            releases: {
                id: string;
                /** Format: uuid */
                agent_id: string;
                /** Format: uuid */
                version_id: string;
                card_sha256: string;
                runtime_profile_id: string;
                profile_digest: string;
                runtime_config_snapshot: {
                    [key: string]: unknown;
                };
                effective_tools: {
                    tools: string[];
                    mcp: string[];
                };
                policy_pins: {
                    tools?: {
                        default: {
                            /** @enum {string} */
                            builtin: "allow" | "ask" | "deny";
                            /** @enum {string} */
                            mcp: "allow" | "ask" | "deny";
                        };
                        per_tool: {
                            [key: string]: "allow" | "ask" | "deny";
                        };
                    };
                };
                created_by: string | null;
                /** Format: date-time */
                created_at: string;
                approved_by: string | null;
                approved_at: string | null;
            }[];
            active_release: {
                id: string;
                /** Format: uuid */
                agent_id: string;
                /** Format: uuid */
                version_id: string;
                card_sha256: string;
                runtime_profile_id: string;
                profile_digest: string;
                runtime_config_snapshot: {
                    [key: string]: unknown;
                };
                effective_tools: {
                    tools: string[];
                    mcp: string[];
                };
                policy_pins: {
                    tools?: {
                        default: {
                            /** @enum {string} */
                            builtin: "allow" | "ask" | "deny";
                            /** @enum {string} */
                            mcp: "allow" | "ask" | "deny";
                        };
                        per_tool: {
                            [key: string]: "allow" | "ask" | "deny";
                        };
                    };
                };
                created_by: string | null;
                /** Format: date-time */
                created_at: string;
                approved_by: string | null;
                approved_at: string | null;
            } | null;
        };
        CreateAgentReleaseResponse: {
            release: {
                id: string;
                /** Format: uuid */
                agent_id: string;
                /** Format: uuid */
                version_id: string;
                card_sha256: string;
                runtime_profile_id: string;
                profile_digest: string;
                runtime_config_snapshot: {
                    [key: string]: unknown;
                };
                effective_tools: {
                    tools: string[];
                    mcp: string[];
                };
                policy_pins: {
                    tools?: {
                        default: {
                            /** @enum {string} */
                            builtin: "allow" | "ask" | "deny";
                            /** @enum {string} */
                            mcp: "allow" | "ask" | "deny";
                        };
                        per_tool: {
                            [key: string]: "allow" | "ask" | "deny";
                        };
                    };
                };
                created_by: string | null;
                /** Format: date-time */
                created_at: string;
                approved_by: string | null;
                approved_at: string | null;
            };
            created: boolean;
        };
        ActivateAgentResponse: {
            active_release_id: string;
            previous_release_id: string | null;
            activation_revision: number;
            receipt_id: string | null;
        };
        SessionCredentialUnboundDetails: {
            /** @constant */
            reason_code: "credential_unbound";
            /** @constant */
            guidance: "연결 설정이 바뀌어 시작하지 못했어요. 에이전트 관리자에게 문의하세요";
            /** Format: uuid */
            agent_id: string;
            /** Format: uuid */
            receipt_id: string;
            admins: {
                /** Format: uuid */
                user_id: string;
                display_name: string;
                email: string;
            }[];
            admin_link: string | null;
        };
        ActivationCredentialUnboundDetails: {
            /** @constant */
            reason_code: "credential_unbound";
            missing: string[];
        };
        CreateApiKeyResponse: {
            key: {
                /** Format: uuid */
                id: string;
                /** @enum {string} */
                kind: "personal" | "agent";
                name: string | null;
                /** Format: uuid */
                workspace_id: string;
                agent_id: string | null;
                created_by: string | null;
                /** @description Who issued the key, with their display name as it is now. It stays after the issuer leaves the workspace or their account is disabled. Null on a key issued before keys recorded who issued them. */
                created_by_user: {
                    /** Format: uuid */
                    id: string;
                    display_name: string;
                } | null;
                scopes: ("sessions:read" | "sessions:write" | "sessions:approve" | "sessions:control" | "sessions:recover")[];
                /** Format: date-time */
                created_at: string;
                expires_at: string | null;
                revoked_at: string | null;
                /** @description When the key last authenticated a request, recorded at most once a minute. A use made while another request is writing a session with the key is recorded on the next use instead, so it can lag by more. Null means no use has been recorded since last-use recording began, not that the key was never used. */
                last_used_at: string | null;
            };
            secret: string;
            /** Format: uuid */
            receipt_id: string;
        };
        ListApiKeysResponse: {
            items: {
                /** Format: uuid */
                id: string;
                /** @enum {string} */
                kind: "personal" | "agent";
                name: string | null;
                /** Format: uuid */
                workspace_id: string;
                agent_id: string | null;
                created_by: string | null;
                /** @description Who issued the key, with their display name as it is now. It stays after the issuer leaves the workspace or their account is disabled. Null on a key issued before keys recorded who issued them. */
                created_by_user: {
                    /** Format: uuid */
                    id: string;
                    display_name: string;
                } | null;
                scopes: ("sessions:read" | "sessions:write" | "sessions:approve" | "sessions:control" | "sessions:recover")[];
                /** Format: date-time */
                created_at: string;
                expires_at: string | null;
                revoked_at: string | null;
                /** @description When the key last authenticated a request, recorded at most once a minute. A use made while another request is writing a session with the key is recorded on the next use instead, so it can lag by more. Null means no use has been recorded since last-use recording began, not that the key was never used. */
                last_used_at: string | null;
            }[];
            next_cursor: string | null;
        };
        RevokeApiKeyResponse: {
            key: {
                /** Format: uuid */
                id: string;
                /** @enum {string} */
                kind: "personal" | "agent";
                name: string | null;
                /** Format: uuid */
                workspace_id: string;
                agent_id: string | null;
                created_by: string | null;
                /** @description Who issued the key, with their display name as it is now. It stays after the issuer leaves the workspace or their account is disabled. Null on a key issued before keys recorded who issued them. */
                created_by_user: {
                    /** Format: uuid */
                    id: string;
                    display_name: string;
                } | null;
                scopes: ("sessions:read" | "sessions:write" | "sessions:approve" | "sessions:control" | "sessions:recover")[];
                /** Format: date-time */
                created_at: string;
                expires_at: string | null;
                revoked_at: string | null;
                /** @description When the key last authenticated a request, recorded at most once a minute. A use made while another request is writing a session with the key is recorded on the next use instead, so it can lag by more. Null means no use has been recorded since last-use recording began, not that the key was never used. */
                last_used_at: string | null;
            };
            receipt_id: string | null;
        };
        ListTeamsResponse: {
            items: {
                /** Format: uuid */
                id: string;
                /** Format: uuid */
                workspace_id: string;
                name: string;
                member_count: number;
                created_by: string | null;
                /** Format: date-time */
                created_at: string;
                revision: number;
            }[];
            next_cursor: string | null;
        };
        TeamDetail: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            workspace_id: string;
            name: string;
            member_count: number;
            created_by: string | null;
            /** Format: date-time */
            created_at: string;
            revision: number;
            members: {
                /** Format: uuid */
                user_id: string;
                email: string;
                display_name: string | null;
                added_by: string | null;
                /** Format: date-time */
                added_at: string;
            }[];
        };
        TeamChangeResponse: {
            team: {
                /** Format: uuid */
                id: string;
                /** Format: uuid */
                workspace_id: string;
                name: string;
                member_count: number;
                created_by: string | null;
                /** Format: date-time */
                created_at: string;
                revision: number;
            };
            receipt_id: string | null;
        };
        DeleteTeamResponse: {
            /** Format: uuid */
            receipt_id: string;
        };
        AgentAdmins: {
            users: {
                /** Format: uuid */
                user_id: string;
                email: string;
                display_name: string | null;
                created_by: string | null;
                /** Format: date-time */
                created_at: string;
            }[];
            teams: {
                /** Format: uuid */
                team_id: string;
                name: string;
                created_by: string | null;
                /** Format: date-time */
                created_at: string;
            }[];
        };
        AgentAdminChangeResponse: {
            admins: components["schemas"]["AgentAdmins"];
            receipt_id: string | null;
        };
        ListAdministeredAgentsResponse: {
            items: {
                /** Format: uuid */
                id: string;
                /** Format: uuid */
                workspace_id: string;
                slug: string;
                name: string;
                /** @enum {string} */
                status: "active" | "paused" | "archived";
                active_release_id: string | null;
                activation_revision: number;
                created_by: string | null;
                /** Format: date-time */
                created_at: string;
                /** Format: date-time */
                updated_at: string;
            }[];
        };
        ListMyTeamsResponse: {
            items: {
                /** Format: uuid */
                id: string;
                name: string;
            }[];
            next_cursor: string | null;
        };
        CreateCredentialBindingRequest: {
            credential_ref: string;
        };
        CreateCredentialBindingResponse: {
            binding: {
                /** Format: uuid */
                id: string;
                /** Format: uuid */
                agent_id: string;
                credential_ref: string;
                /** Format: uuid */
                bound_by: string;
                /** Format: date-time */
                bound_at: string;
                revoked_at: string | null;
                running_sessions: number;
            };
            created: boolean;
            receipt_id: string | null;
        };
        ListCredentialBindingsResponse: {
            items: {
                /** Format: uuid */
                id: string;
                /** Format: uuid */
                agent_id: string;
                credential_ref: string;
                /** Format: uuid */
                bound_by: string;
                /** Format: date-time */
                bound_at: string;
                revoked_at: string | null;
                running_sessions: number;
            }[];
            /** @constant */
            revoke_notice: "해제하면 실행 중인 세션도 다음 메시지부터 막히고, 원격 MCP 호출은 30초 안에 끊겨요. 이미 보낸 호출은 끝까지 실행되니 값 자체는 외부 서비스에서 폐기하세요";
        };
        RevokeCredentialBindingResponse: {
            binding: {
                /** Format: uuid */
                id: string;
                /** Format: uuid */
                agent_id: string;
                credential_ref: string;
                /** Format: uuid */
                bound_by: string;
                /** Format: date-time */
                bound_at: string;
                revoked_at: string | null;
                running_sessions: number;
            };
            /** @constant */
            revoke_notice: "해제하면 실행 중인 세션도 다음 메시지부터 막히고, 원격 MCP 호출은 30초 안에 끊겨요. 이미 보낸 호출은 끝까지 실행되니 값 자체는 외부 서비스에서 폐기하세요";
            /** Format: uuid */
            receipt_id: string;
        };
        LinkAgentIdentityResponse: {
            agent_identity: {
                /** Format: uuid */
                id: string;
                /** Format: uuid */
                agent_id: string;
                /** @enum {string} */
                provider: "slack_bot";
                app_id: string;
                team_id: string;
                bot_user_id: string;
                credential_ref: string;
                /** @enum {string} */
                status: "active" | "revoked";
                revision: number;
                created_by: string | null;
                /** Format: date-time */
                created_at: string;
                revoked_at: string | null;
            };
            /** Format: uuid */
            receipt_id: string;
        };
        ListAgentIdentitiesResponse: {
            items: {
                /** Format: uuid */
                id: string;
                /** Format: uuid */
                agent_id: string;
                /** @enum {string} */
                provider: "slack_bot";
                app_id: string;
                team_id: string;
                bot_user_id: string;
                credential_ref: string;
                /** @enum {string} */
                status: "active" | "revoked";
                revision: number;
                created_by: string | null;
                /** Format: date-time */
                created_at: string;
                revoked_at: string | null;
            }[];
        };
        RevokeAgentIdentityResponse: {
            agent_identity: {
                /** Format: uuid */
                id: string;
                /** Format: uuid */
                agent_id: string;
                /** @enum {string} */
                provider: "slack_bot";
                app_id: string;
                team_id: string;
                bot_user_id: string;
                credential_ref: string;
                /** @enum {string} */
                status: "active" | "revoked";
                revision: number;
                created_by: string | null;
                /** Format: date-time */
                created_at: string;
                revoked_at: string | null;
            };
            receipt_id: string | null;
        };
        ListSlackBindingsResponse: {
            items: {
                /** Format: uuid */
                id: string;
                /** Format: uuid */
                workspace_id: string;
                owner_id: string;
                /** @enum {string} */
                surface: "web" | "slack" | "api";
                installation_id: string | null;
                external_surface_id: string | null;
                surface_kind: ("public_channel" | "private_channel" | "dm") | null;
                /** Format: uuid */
                agent_id: string;
                /** @enum {string} */
                mode: "off" | "mention" | "ambient";
                ceiling: {
                    actions: ("session.read" | "session.submit" | "session.control" | "session.approve")[];
                    /** @enum {string} */
                    disclosure: "full" | "summary";
                };
                home: boolean;
                /** @enum {string} */
                memory_write_policy: "deny" | "allow_explicit";
                /** @enum {string} */
                status: "ready" | "partial" | "failed" | "revoked";
                membership?: {
                    /** @enum {string} */
                    state: "joined" | "awaiting_invite" | "config_error" | "join_failed";
                    error: string | null;
                };
                muted: boolean;
                revision: number;
                /** Format: date-time */
                created_at: string;
                revoked_at: string | null;
            }[];
        };
        PutSlackBindingResponse: {
            slack_binding: {
                /** Format: uuid */
                id: string;
                /** Format: uuid */
                workspace_id: string;
                owner_id: string;
                /** @enum {string} */
                surface: "web" | "slack" | "api";
                installation_id: string | null;
                external_surface_id: string | null;
                surface_kind: ("public_channel" | "private_channel" | "dm") | null;
                /** Format: uuid */
                agent_id: string;
                /** @enum {string} */
                mode: "off" | "mention" | "ambient";
                ceiling: {
                    actions: ("session.read" | "session.submit" | "session.control" | "session.approve")[];
                    /** @enum {string} */
                    disclosure: "full" | "summary";
                };
                home: boolean;
                /** @enum {string} */
                memory_write_policy: "deny" | "allow_explicit";
                /** @enum {string} */
                status: "ready" | "partial" | "failed" | "revoked";
                membership?: {
                    /** @enum {string} */
                    state: "joined" | "awaiting_invite" | "config_error" | "join_failed";
                    error: string | null;
                };
                muted: boolean;
                revision: number;
                /** Format: date-time */
                created_at: string;
                revoked_at: string | null;
            };
            /** Format: uuid */
            receipt_id: string;
        };
        SearchSlackChannelsResponse: {
            items: {
                id: string;
                name: string;
                is_private: boolean;
                is_member: boolean;
            }[];
            next_cursor: string | null;
            truncated: boolean;
            stale: boolean;
        };
        LookupSlackChannelsResponse: {
            items: {
                id: string;
                name: string;
                /** @enum {string} */
                state: "known" | "unknown";
            }[];
        };
        OpenApiDocument: {
            /** @constant */
            openapi: "3.1.0";
        } & {
            [key: string]: unknown;
        };
    };
    responses: {
        /** @description - `INTERNAL_ERROR`: An unexpected server failure. Report it with the `X-Request-Id`. */
        InternalError: {
            headers: {
                "X-Request-Id": components["headers"]["RequestId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ApiErrorResponse"] & {
                    error?: {
                        /** @enum {string} */
                        code?: "INTERNAL_ERROR";
                    };
                };
            };
        };
    };
    parameters: never;
    requestBodies: never;
    headers: {
        /** @description A fresh id for this request, on every response; an error body's `request_id` carries the same value. */
        RequestId: string;
        /** @description Seconds to wait before sending the same request again. */
        RetryAfter: number;
    };
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    getHealth: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The process is up. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "status": "ok"
                     *     }
                     */
                    "application/json": components["schemas"]["HealthResponse"];
                };
            };
            500: components["responses"]["InternalError"];
        };
    };
    getReady: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Every check passed. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "status": "ready",
                     *       "checks": {
                     *         "database": "ok",
                     *         "schema": "ok",
                     *         "config": "ok"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["ReadyResponse"];
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `NOT_READY`: A readiness check failed; `error.details.check` names it (`database`, `schema` or `config`), or is `shutdown` while the process is shutting down. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_READY";
                        };
                    };
                };
            };
        };
    };
    getOpenApiDocument: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The OpenAPI 3.1 document. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "openapi": "3.1.0",
                     *       "info": {
                     *         "title": "Werft API",
                     *         "version": "0.1.0-alpha"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["OpenApiDocument"];
                };
            };
            500: components["responses"]["InternalError"];
        };
    };
    getApiRoot: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The credential is valid. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "status": "ok",
                     *       "owner_id": "7b0e5c1e-2f4a-4d7e-9a51-3c6f0b8d2e14"
                     *     }
                     */
                    "application/json": components["schemas"]["ApiRootResponse"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Scope: the credential does not hold `sessions:read`, checked before the body or the resource is read. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    bootstrap: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "bootstrap_token": "<the BOOTSTRAP_TOKEN printed at install>",
                 *       "email": "owner@example.com",
                 *       "password": "correct horse battery staple",
                 *       "display_name": "Ada Owner",
                 *       "workspace_name": "Acme",
                 *       "workspace_slug": "acme"
                 *     }
                 */
                "application/json": components["schemas"]["BootstrapRequest"];
            };
        };
        responses: {
            /** @description The owner, the workspace and the membership are created, or the owner is restored in the existing workspace. */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "user_id": "3e7f1a90-5c2d-4b8e-8f61-2a9d0c4b7e35",
                     *       "workspace": {
                     *         "id": "9d2c4e61-8a3b-4f70-b1e5-6c0a7d3f2b98",
                     *         "slug": "acme",
                     *         "name": "Acme",
                     *         "settings": {
                     *           "dispatch_model": null,
                     *           "kill_switch": false,
                     *           "daily_cost_limit_usd": null,
                     *           "idle_pause_minutes": 30,
                     *           "audit_retention_days": 90,
                     *           "slack_guest_enabled": false
                     *         },
                     *         "created_at": "2026-10-01T09:00:00Z"
                     *       },
                     *       "role": "owner"
                     *     }
                     */
                    "application/json": components["schemas"]["BootstrapResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: The submitted credentials were rejected. `bootstrap_token` is missing, does not match the installation's token, or was already used; checked first, before the owner state and the rest of the body. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /** @description - `BOOTSTRAP_DONE`: An owner already exists; bootstrap runs once. A live owner exists, checked only after the token matched (the token is then spent); also the answer to the loser of two concurrent bootstraps. */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BOOTSTRAP_DONE";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    listLoginMethods: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LoginMethodsResponse"];
                };
            };
            500: components["responses"]["InternalError"];
        };
    };
    login: {
        parameters: {
            query?: never;
            header: {
                /** @description Always required: the literal `agent-platform-web`. */
                "X-Requested-With": "agent-platform-web";
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "email": "owner@example.com",
                 *       "password": "correct horse battery staple"
                 *     }
                 */
                "application/json": components["schemas"]["LoginRequest"];
            };
        };
        responses: {
            /** @description Signed in; the response sets the session cookie. `scopes` are the ones the workspace role holds. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "user_id": "3e7f1a90-5c2d-4b8e-8f61-2a9d0c4b7e35",
                     *       "workspace_id": "9d2c4e61-8a3b-4f70-b1e5-6c0a7d3f2b98",
                     *       "role": "owner",
                     *       "scopes": [
                     *         "sessions:read",
                     *         "sessions:write",
                     *         "sessions:approve",
                     *         "sessions:control",
                     *         "sessions:recover"
                     *       ],
                     *       "expires_at": "2026-10-25T09:00:00Z"
                     *     }
                     */
                    "application/json": components["schemas"]["LoginResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: The submitted credentials were rejected. Unknown email, wrong password, or a user with no live workspace membership. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: The request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); every caller must send the header. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            /** @description - `RATE_LIMITED`: Too many requests; wait for `Retry-After` and retry. Five failed logins for this email within 15 minutes lock it until the window ends (`Retry-After` is the time left), or too many logins are being checked at once (`Retry-After: 1`). */
            429: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "RATE_LIMITED";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    startGoogleLogin: {
        parameters: {
            query?: never;
            header: {
                /** @description Always required: the literal `agent-platform-web`. */
                "X-Requested-With": "agent-platform-web";
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StartGoogleLoginResponse"];
                };
            };
            /** @description - `FORBIDDEN`: The request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); every caller must send the header. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    googleLoginCallback: {
        parameters: {
            query?: never;
            header: {
                /** @description Always required: the literal `agent-platform-web`. */
                "X-Requested-With": "agent-platform-web";
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["GoogleLoginCallbackRequest"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LoginResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: The submitted credentials were rejected. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: The request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); every caller must send the header. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /** @description - `LOGIN_LINK_REQUIRED`: The verified address already has an account. It is never joined by email: sign in with the existing account and link the external login there. */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "LOGIN_LINK_REQUIRED";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    resetPassword: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PasswordResetRequest"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PasswordResetResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: The submitted credentials were rejected. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            /** @description - `RATE_LIMITED`: Too many requests; wait for `Retry-After` and retry. */
            429: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "RATE_LIMITED";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    issuePasswordReset: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
                userId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["IssuePasswordResetRequest"];
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IssuePasswordResetResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            /** @description - `RATE_LIMITED`: Too many requests; wait for `Retry-After` and retry. */
            429: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "RATE_LIMITED";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    setAuditRetention: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AuditRetentionRequest"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuditRetentionResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    setSlackGuest: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SlackGuestRequest"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SlackGuestResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    getSlackConfigToken: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The token's state; never its value. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "configured": true,
                     *       "last4": "a9f3",
                     *       "updated_at": "2026-10-23T09:00:00Z",
                     *       "updated_by": {
                     *         "user_id": "3e7f1a90-5c2d-4b8e-8f61-2a9d0c4b7e35",
                     *         "display_name": "Jae"
                     *       },
                     *       "state": "active",
                     *       "expires_at": "2026-10-23T21:00:00Z",
                     *       "issuer": {
                     *         "user_id": "U0ISSUER",
                     *         "team_id": "T0TEAM"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["SlackConfigTokenSummary"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. Also when the API runs without a master key (PLATFORM_SECRET_KEY). */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    putSlackConfigToken: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "value": "<refresh-token-from-api.slack.com>"
                 *     }
                 */
                "application/json": components["schemas"]["PutSlackSecretRequest"];
            };
        };
        responses: {
            /** @description Stored; the summary as GET now answers it, the receipt and any warnings. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "configured": true,
                     *       "last4": "a9f3",
                     *       "updated_at": "2026-10-23T09:00:00Z",
                     *       "updated_by": {
                     *         "user_id": "3e7f1a90-5c2d-4b8e-8f61-2a9d0c4b7e35",
                     *         "display_name": "Jae"
                     *       },
                     *       "state": "active",
                     *       "expires_at": "2026-10-23T21:00:00Z",
                     *       "issuer": {
                     *         "user_id": "U0ISSUER",
                     *         "team_id": "T0TEAM"
                     *       },
                     *       "receipt_id": "c4a1e9d2-7b3f-4e8a-a6c5-1d2e3f4a5b6c",
                     *       "warnings": []
                     *     }
                     */
                    "application/json": components["schemas"]["PutSlackConfigTokenResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /** @description - `CONFIG_TOKEN_INVALID`: The workspace's Slack App Configuration Token cannot be used. `error.details.reason_code` is `not_set` (none stored), `rejected` (Slack refused it; paste another) or `needs_reentry` (Slack no longer takes the stored token, or a rotation's answer was lost; an owner or admin pastes a new one). */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "CONFIG_TOKEN_INVALID";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. Also when the API runs without a master key (PLATFORM_SECRET_KEY), or Slack could not be reached; nothing stored changed. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    deleteSlackConfigToken: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deleted; the receipt. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "receipt_id": "c4a1e9d2-7b3f-4e8a-a6c5-1d2e3f4a5b6c"
                     *     }
                     */
                    "application/json": components["schemas"]["DeleteSlackSecretResponse"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. Also when the API runs without a master key (PLATFORM_SECRET_KEY). */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    deleteSlackApp: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
                app_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deleted in Slack, or already gone there; the app as now stored, its secrets dropped. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "slack_app": {
                     *         "id": "6a1d3e5f-2b4c-4d8e-9f0a-1b2c3d4e5f60",
                     *         "kind": "agent",
                     *         "agent_id": "8d2c4f1a-6b3e-4a9d-b7c5-2e1f0a9b8c7d",
                     *         "state": "deleted",
                     *         "app_id": "A0B1C2D3E4F",
                     *         "client_id": "1234567890.9876543210",
                     *         "redirect_url": "https://console.example.ts.net/agents/8d2c4f1a-6b3e-4a9d-b7c5-2e1f0a9b8c7d/slack/callback",
                     *         "created_by_token_user": "U0ISSUER",
                     *         "created_at": "2026-10-23T09:00:00Z",
                     *         "updated_at": "2026-10-23T09:00:00Z",
                     *         "secrets": {
                     *           "slack_signing_secret": {
                     *             "configured": false,
                     *             "last4": null,
                     *             "updated_at": null,
                     *             "updated_by": null
                     *           },
                     *           "slack_client_secret": {
                     *             "configured": false,
                     *             "last4": null,
                     *             "updated_at": null,
                     *             "updated_by": null
                     *           },
                     *           "slack_bot_token": {
                     *             "configured": false,
                     *             "last4": null,
                     *             "updated_at": null,
                     *             "updated_by": null
                     *           }
                     *         }
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["DeleteSlackAppResponse"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /**
             * @description - `CONFIG_TOKEN_INVALID`: The workspace's Slack App Configuration Token cannot be used. `error.details.reason_code` is `not_set` (none stored), `rejected` (Slack refused it; paste another) or `needs_reentry` (Slack no longer takes the stored token, or a rotation's answer was lost; an owner or admin pastes a new one).
             *     - `SLACK_APP_CREATING`: The Slack app (the agent's, or the workspace's link app) is still being created. `error.details.uncertain: true` means Slack's answer was lost: check api.slack.com/apps for an app made at that time, delete it, then retry with `replace_uncertain: true`.
             */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "CONFIG_TOKEN_INVALID" | "SLACK_APP_CREATING";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. Also when the API runs without a master key (PLATFORM_SECRET_KEY), or Slack could not be reached or refused; the app stays `deleting` and the same request retries it. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    putSlackAppSecret: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
                app_id: string;
                purpose: "slack_signing_secret" | "slack_client_secret" | "slack_bot_token";
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "value": "<value-from-api.slack.com>"
                 *     }
                 */
                "application/json": components["schemas"]["PutSlackSecretRequest"];
            };
        };
        responses: {
            /** @description Stored; its summary and the receipt. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "configured": true,
                     *       "last4": "a9f3",
                     *       "updated_at": "2026-10-23T09:00:00Z",
                     *       "updated_by": {
                     *         "user_id": "3e7f1a90-5c2d-4b8e-8f61-2a9d0c4b7e35",
                     *         "display_name": "Jae"
                     *       },
                     *       "receipt_id": "c4a1e9d2-7b3f-4e8a-a6c5-1d2e3f4a5b6c"
                     *     }
                     */
                    "application/json": components["schemas"]["PutSlackSecretResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. Also when `app_id` is not a UUID or `purpose` is not one of the three, `slack_config_token` included. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. Also when the API runs without a master key (PLATFORM_SECRET_KEY). */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    logout: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The session is revoked and the cookie cleared. */
            204: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. Also when the caller is not a cookie session (an API key). */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    getAuthMe: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The authenticated principal; `scopes` is what it may do. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "principal": {
                     *         "kind": "user",
                     *         "id": "3e7f1a90-5c2d-4b8e-8f61-2a9d0c4b7e35",
                     *         "workspace_id": "9d2c4e61-8a3b-4f70-b1e5-6c0a7d3f2b98",
                     *         "role": "owner",
                     *         "scopes": [
                     *           "sessions:read",
                     *           "sessions:write",
                     *           "sessions:approve",
                     *           "sessions:control",
                     *           "sessions:recover"
                     *         ]
                     *       },
                     *       "user": {
                     *         "id": "3e7f1a90-5c2d-4b8e-8f61-2a9d0c4b7e35",
                     *         "email": "owner@example.com",
                     *         "display_name": "Ada Owner"
                     *       },
                     *       "workspace": {
                     *         "id": "9d2c4e61-8a3b-4f70-b1e5-6c0a7d3f2b98",
                     *         "slug": "acme",
                     *         "name": "Acme",
                     *         "settings": {
                     *           "dispatch_model": null,
                     *           "kill_switch": false,
                     *           "daily_cost_limit_usd": null,
                     *           "idle_pause_minutes": 30,
                     *           "audit_retention_days": 90,
                     *           "slack_guest_enabled": false
                     *         },
                     *         "created_at": "2026-10-01T09:00:00Z"
                     *       },
                     *       "scopes": [
                     *         "sessions:read",
                     *         "sessions:write",
                     *         "sessions:approve",
                     *         "sessions:control",
                     *         "sessions:recover"
                     *       ],
                     *       "permissions": [
                     *         "workspace.manage",
                     *         "audit_retention.manage",
                     *         "member.manage",
                     *         "team.manage",
                     *         "api_key.manage",
                     *         "api_key.manage_own",
                     *         "account.link",
                     *         "agent.create",
                     *         "agent.manage",
                     *         "agent.restore",
                     *         "agent.admin.manage",
                     *         "credential.bind",
                     *         "binding.manage",
                     *         "session.audit_read",
                     *         "session.admin_list",
                     *         "usage.installation_read"
                     *       ]
                     *     }
                     */
                    "application/json": components["schemas"]["AuthMeResponse"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. Also when the session's workspace no longer exists. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Scope: the credential does not hold `sessions:read`, checked before the body or the resource is read. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    listSessions: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
                status?: "queued" | "running" | "needs_input" | "idle" | "failed" | "stopped";
                agent_id?: string;
                relation?: "all" | "started" | "shared" | "administered";
                q?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of session summaries. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "items": [
                     *         {
                     *           "id": "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01",
                     *           "title": "Fix the flaky checkout test",
                     *           "agent": {
                     *             "id": "8f6c1d2e-4b3a-4c5d-9e8f-7a6b5c4d3e2f",
                     *             "name": "Checkout fixer",
                     *             "release_version_no": 3
                     *           },
                     *           "created_by": {
                     *             "user_id": "1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b",
                     *             "display_name": "Mina Park"
                     *           },
                     *           "channel": "web",
                     *           "revision": 7,
                     *           "admission_state": "active",
                     *           "status": "running",
                     *           "runtime": {
                     *             "kind": "claude_agent_sdk",
                     *             "version": "0.2.1",
                     *             "profile_id": "claude-coding-real",
                     *             "model": "claude-sonnet-5",
                     *             "permission_mode": "default"
                     *           },
                     *           "model": "claude-sonnet-5",
                     *           "repository_id": "sample-app",
                     *           "repository": {
                     *             "id": "sample-app",
                     *             "full_name": "acme/sample-app",
                     *             "branch": "main"
                     *           },
                     *           "current_turn_id": "3",
                     *           "queued_turn_count": 1,
                     *           "last_event_at": "2026-10-11T08:15:42Z",
                     *           "created_at": "2026-10-11T08:00:00Z",
                     *           "updated_at": "2026-10-11T08:15:40Z"
                     *         }
                     *       ],
                     *       "next_cursor": null
                     *     }
                     */
                    "application/json": components["schemas"]["ListSessionsResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: a query parameter or the page cursor is invalid. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Scope: the credential does not hold `sessions:read`, checked before the body or the resource is read. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    createSession: {
        parameters: {
            query?: never;
            header: {
                /** @description Required, 1–255 characters; a UUID per user intent works. A retry with the same key and the same body returns the original response and runs the command once; the same key with a different body answers `409 IDEMPOTENCY_CONFLICT`. A missing or invalid key answers `400 BAD_REQUEST`, after the body is read. */
                "Idempotency-Key": string;
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "profile_id": "claude-coding-real",
                 *       "repository_id": "sample-app",
                 *       "message": "Add a health check endpoint and a test for it."
                 *     }
                 */
                "application/json": components["schemas"]["CreateSessionRequest"];
            };
        };
        responses: {
            /** @description The session and its first turn are stored; `receipt_id` tracks the acceptance. */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "session_id": "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01",
                     *       "turn_id": "1",
                     *       "receipt_id": "c4a1e9d2-7b3f-4e8a-a6c5-1d2e3f4a5b6c",
                     *       "receipt_status": "accepted",
                     *       "status": "queued"
                     *     }
                     */
                    "application/json": components["schemas"]["CreateSessionResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema; the `Idempotency-Key` header is missing, empty or longer than 255 characters. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Scope: the credential does not hold `sessions:write`, checked before the body or the resource is read. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /**
             * @description - `IDEMPOTENCY_CONFLICT`: This `Idempotency-Key` was already used for this operation and resource with a different body. Use a new key for a new intent.
             *     - `RELEASE_PROFILE_MISMATCH`: The release was made for another runtime profile than the one named.
             *     - `PROFILE_DIGEST_MISMATCH`: The runtime profile's settings changed since the release was made; release the agent again.
             *     - `CREDENTIAL_UNBOUND`: The release names a credential its agent has no live binding for; an agent admin must bind it first.
             */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "IDEMPOTENCY_CONFLICT" | "RELEASE_PROFILE_MISMATCH" | "PROFILE_DIGEST_MISMATCH" | "CREDENTIAL_UNBOUND";
                        };
                    };
                };
            };
            /**
             * @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB, or `message` is longer than 32 KiB of UTF-8.
             *     - `STORAGE_LIMIT_EXCEEDED`: Accepting this message would exceed the installation's storage limit (`GET /v1/limits`). Retrying does not free space.
             */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE" | "STORAGE_LIMIT_EXCEEDED";
                        };
                    };
                };
            };
            /** @description - `UNSUPPORTED_CAPABILITY`: This installation or the session's runtime cannot serve the request. `profile_id` or `repository_id` is not in the catalog, the catalog does not allow the pair, the profile does not offer `model`, `repository_id` is missing for a profile whose `repository_mode` is `required` (`Profile <id> needs a repository: send repository_id`), or sent for one whose `repository_mode` is `none` (`Profile <id> runs without a repository: omit repository_id`). */
            422: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNSUPPORTED_CAPABILITY";
                        };
                    };
                };
            };
            /** @description - `RATE_LIMITED`: Too many requests; wait for `Retry-After` and retry. Reserved here: the per-session input queue limit applies to later messages, not to the first, so this operation does not currently return it. */
            429: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "RATE_LIMITED";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    countSessions: {
        parameters: {
            query?: {
                relation?: "all" | "started" | "shared" | "administered";
                q?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The number of sessions per status. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "counts": {
                     *         "queued": 0,
                     *         "running": 2,
                     *         "needs_input": 1,
                     *         "idle": 5,
                     *         "failed": 1,
                     *         "stopped": 3
                     *       },
                     *       "total": 12
                     *     }
                     */
                    "application/json": components["schemas"]["CountSessionsResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: a query parameter or the page cursor is invalid. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Scope: the credential does not hold `sessions:read`, checked before the body or the resource is read. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    getSession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The session as it stands now. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "id": "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01",
                     *       "title": "Fix the flaky checkout test",
                     *       "agent": {
                     *         "id": "8f6c1d2e-4b3a-4c5d-9e8f-7a6b5c4d3e2f",
                     *         "name": "Checkout fixer",
                     *         "release_version_no": 3
                     *       },
                     *       "created_by": {
                     *         "user_id": "1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b",
                     *         "display_name": "Mina Park"
                     *       },
                     *       "channel": "web",
                     *       "revision": 7,
                     *       "admission_state": "active",
                     *       "status": "running",
                     *       "runtime": {
                     *         "kind": "claude_agent_sdk",
                     *         "version": "0.2.1",
                     *         "profile_id": "claude-coding-real",
                     *         "model": "claude-sonnet-5",
                     *         "permission_mode": "default"
                     *       },
                     *       "model": "claude-sonnet-5",
                     *       "repository_id": "sample-app",
                     *       "repository": {
                     *         "id": "sample-app",
                     *         "full_name": "acme/sample-app",
                     *         "branch": "main"
                     *       },
                     *       "current_turn_id": "3",
                     *       "queued_turn_count": 1,
                     *       "last_event_at": "2026-10-11T08:15:42Z",
                     *       "created_at": "2026-10-11T08:00:00Z",
                     *       "updated_at": "2026-10-11T08:15:40Z",
                     *       "execution": {
                     *         "backend": "local_docker",
                     *         "state": "running",
                     *         "observed_at": "2026-10-11T08:15:38Z"
                     *       },
                     *       "checkpoint_revision": 2,
                     *       "pending_request_count": 0,
                     *       "attention": null,
                     *       "durability": {
                     *         "last_transcript_persisted_at": "2026-10-11T08:15:41Z",
                     *         "checkpoint_committed_at": "2026-10-11T08:10:02Z",
                     *         "checkpoint_revision": 2,
                     *         "last_completed_turn_id": "2",
                     *         "last_checkpointed_turn_id": "2",
                     *         "checkpoint_pending_reason": null,
                     *         "checkpoint_fallback_revision": null,
                     *         "context_reset_turn_id": null
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["SessionDetail"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Scope: the credential does not hold `sessions:read`, checked before the body or the resource is read. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    updateSession: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "title": "Fix the flaky checkout test"
                 *     }
                 */
                "application/json": components["schemas"]["UpdateSessionRequest"];
            };
        };
        responses: {
            /** @description The session with its new title. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "id": "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01",
                     *       "title": "Fix the flaky checkout test",
                     *       "agent": {
                     *         "id": "8f6c1d2e-4b3a-4c5d-9e8f-7a6b5c4d3e2f",
                     *         "name": "Checkout fixer",
                     *         "release_version_no": 3
                     *       },
                     *       "created_by": {
                     *         "user_id": "1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b",
                     *         "display_name": "Mina Park"
                     *       },
                     *       "channel": "web",
                     *       "revision": 7,
                     *       "admission_state": "active",
                     *       "status": "running",
                     *       "runtime": {
                     *         "kind": "claude_agent_sdk",
                     *         "version": "0.2.1",
                     *         "profile_id": "claude-coding-real",
                     *         "model": "claude-sonnet-5",
                     *         "permission_mode": "default"
                     *       },
                     *       "model": "claude-sonnet-5",
                     *       "repository_id": "sample-app",
                     *       "repository": {
                     *         "id": "sample-app",
                     *         "full_name": "acme/sample-app",
                     *         "branch": "main"
                     *       },
                     *       "current_turn_id": "3",
                     *       "queued_turn_count": 1,
                     *       "last_event_at": "2026-10-11T08:15:42Z",
                     *       "created_at": "2026-10-11T08:00:00Z",
                     *       "updated_at": "2026-10-11T08:15:40Z",
                     *       "execution": {
                     *         "backend": "local_docker",
                     *         "state": "running",
                     *         "observed_at": "2026-10-11T08:15:38Z"
                     *       },
                     *       "checkpoint_revision": 2,
                     *       "pending_request_count": 0,
                     *       "attention": null,
                     *       "durability": {
                     *         "last_transcript_persisted_at": "2026-10-11T08:15:41Z",
                     *         "checkpoint_committed_at": "2026-10-11T08:10:02Z",
                     *         "checkpoint_revision": 2,
                     *         "last_completed_turn_id": "2",
                     *         "last_checkpointed_turn_id": "2",
                     *         "checkpoint_pending_reason": null,
                     *         "checkpoint_fallback_revision": null,
                     *         "context_reset_turn_id": null
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["SessionDetail"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Scope: the credential does not hold `sessions:write`, checked before the body or the resource is read. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    getSessionShare: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionShare"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Scope: the credential does not hold `sessions:read`, checked before the body or the resource is read. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    setSessionShare: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SetSessionShareRequest"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SetSessionShareResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /** @description - `REVISION_CONFLICT`: `expected_revision` is not the session's current `revision`. Reread the session, check the intent still holds, and retry with the new revision. */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REVISION_CONFLICT";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    auditReadSession: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AuditReadRequest"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuditReadResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    listAdminSessions: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ListAdminSessionsResponse"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    adminTerminateSession: {
        parameters: {
            query?: never;
            header: {
                /** @description Required, 1–255 characters; a UUID per user intent works. A retry with the same key and the same body returns the original response and runs the command once; the same key with a different body answers `409 IDEMPOTENCY_CONFLICT`. A missing or invalid key answers `400 BAD_REQUEST`, after the body is read. */
                "Idempotency-Key": string;
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdminTerminateSessionRequest"];
            };
        };
        responses: {
            /** @description Success */
            202: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TerminateSessionResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema; the `Idempotency-Key` header is missing, empty or longer than 255 characters. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /**
             * @description - `IDEMPOTENCY_CONFLICT`: This `Idempotency-Key` was already used for this operation and resource with a different body. Use a new key for a new intent.
             *     - `REVISION_CONFLICT`: `expected_revision` is not the session's current `revision`. Reread the session, check the intent still holds, and retry with the new revision.
             *     - `SESSION_PAUSED`: The session is pausing or paused; resume it first.
             *     - `SESSION_RESUMING`: The session is resuming; wait for the resume receipt.
             *     - `SESSION_STOPPED`: The session is stopping or stopped; resume it first.
             *     - `RECOVERY_REQUIRED`: The session needs a recovery decision first (`POST /v1/sessions/{id}/recovery-decisions`).
             *     - `SESSION_CLOSED`: The session is closed and accepts no further commands.
             */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "IDEMPOTENCY_CONFLICT" | "REVISION_CONFLICT" | "SESSION_PAUSED" | "SESSION_RESUMING" | "SESSION_STOPPED" | "RECOVERY_REQUIRED" | "SESSION_CLOSED";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            /** @description - `UNSUPPORTED_CAPABILITY`: This installation or the session's runtime cannot serve the request. */
            422: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNSUPPORTED_CAPABILITY";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    adminDecideSessionRecovery: {
        parameters: {
            query?: never;
            header: {
                /** @description Required, 1–255 characters; a UUID per user intent works. A retry with the same key and the same body returns the original response and runs the command once; the same key with a different body answers `409 IDEMPOTENCY_CONFLICT`. A missing or invalid key answers `400 BAD_REQUEST`, after the body is read. */
                "Idempotency-Key": string;
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RecoveryDecisionRequest"];
            };
        };
        responses: {
            /** @description Success */
            202: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReceiptAcceptedResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema; the `Idempotency-Key` header is missing, empty or longer than 255 characters. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /**
             * @description - `IDEMPOTENCY_CONFLICT`: This `Idempotency-Key` was already used for this operation and resource with a different body. Use a new key for a new intent.
             *     - `REVISION_CONFLICT`: `expected_revision` is not the session's current `revision`. Reread the session, check the intent still holds, and retry with the new revision.
             *     - `REQUEST_STALE`: The request was made against state that has since moved on.
             *     - `SESSION_PAUSED`: The session is pausing or paused; resume it first.
             *     - `SESSION_RESUMING`: The session is resuming; wait for the resume receipt.
             *     - `SESSION_STOPPED`: The session is stopping or stopped; resume it first.
             *     - `RECOVERY_REQUIRED`: The session needs a recovery decision first (`POST /v1/sessions/{id}/recovery-decisions`).
             *     - `SESSION_CLOSED`: The session is closed and accepts no further commands.
             *     - `CHECKPOINT_UNAVAILABLE`: The session has no committed checkpoint that can serve this request.
             */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "IDEMPOTENCY_CONFLICT" | "REVISION_CONFLICT" | "REQUEST_STALE" | "SESSION_PAUSED" | "SESSION_RESUMING" | "SESSION_STOPPED" | "RECOVERY_REQUIRED" | "SESSION_CLOSED" | "CHECKPOINT_UNAVAILABLE";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            /** @description - `UNSUPPORTED_CAPABILITY`: This installation or the session's runtime cannot serve the request. */
            422: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNSUPPORTED_CAPABILITY";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    getSessionUsage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The session's usage as of `refreshed_at`. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "session_id": "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01",
                     *       "period": "session_lifetime",
                     *       "refreshed_at": "2026-10-11T08:15:43Z",
                     *       "cost": {
                     *         "amount_usd": "0.4231",
                     *         "kind": "estimated",
                     *         "source": "provider_usage",
                     *         "completeness_scope": "turn_reports",
                     *         "complete": false,
                     *         "reported_turn_count": 2,
                     *         "unreported_turn_count": 0,
                     *         "open_turn_count": 1
                     *       },
                     *       "cost_limit_usd": "20",
                     *       "token_count": 182450,
                     *       "token_limit": null,
                     *       "budget_exceeded": false,
                     *       "queued_input_count": 1,
                     *       "queued_input_limit": 20
                     *     }
                     */
                    "application/json": components["schemas"]["SessionUsageResponse"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Scope: the credential does not hold `sessions:read`, checked before the body or the resource is read. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    listSessionOutputs: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The outputs of the session's latest committed checkpoint. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "session_id": "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01",
                     *       "checkpoint_revision": 2,
                     *       "items": [
                     *         {
                     *           "path": "out/report.md",
                     *           "bytes": 2048,
                     *           "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
                     *           "omitted": null
                     *         },
                     *         {
                     *           "path": "out/recording.mp4",
                     *           "bytes": 734003200,
                     *           "sha256": null,
                     *           "omitted": "too_large"
                     *         }
                     *       ]
                     *     }
                     */
                    "application/json": components["schemas"]["ListSessionOutputsResponse"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Scope: the credential does not hold `sessions:read`, checked before the body or the resource is read. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `CHECKPOINT_UNAVAILABLE`: The session has no committed checkpoint that can serve this request. The latest checkpoint's manifest is missing, damaged or unreadable; `message` names it. */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "CHECKPOINT_UNAVAILABLE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    downloadSessionOutput: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                path: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The file's bytes. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    /** @description Always `attachment`, with the file's name as `filename*` (RFC 6266, UTF-8) and an ASCII `filename` fallback. */
                    "Content-Disposition"?: string;
                    /** @description The file's size in bytes. */
                    "Content-Length"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": string;
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Scope: the credential does not hold `sessions:read`, checked before the body or the resource is read. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. Also when the path is not listed, is listed as `omitted`, or the session has no committed checkpoint. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `CHECKPOINT_UNAVAILABLE`: The session has no committed checkpoint that can serve this request. The latest checkpoint's manifest or this file's stored object is missing, damaged or unreadable; `message` names it. */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "CHECKPOINT_UNAVAILABLE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    appendSessionMessage: {
        parameters: {
            query?: never;
            header: {
                /** @description Required, 1–255 characters; a UUID per user intent works. A retry with the same key and the same body returns the original response and runs the command once; the same key with a different body answers `409 IDEMPOTENCY_CONFLICT`. A missing or invalid key answers `400 BAD_REQUEST`, after the body is read. */
                "Idempotency-Key": string;
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "message": "Now add the endpoint to the README."
                 *     }
                 */
                "application/json": components["schemas"]["PostSessionMessageRequest"];
            };
        };
        responses: {
            /** @description The input is stored as a queued turn. */
            202: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "turn_id": "4",
                     *       "receipt_id": "c4a1e9d2-7b3f-4e8a-a6c5-1d2e3f4a5b6c",
                     *       "receipt_status": "accepted"
                     *     }
                     */
                    "application/json": components["schemas"]["PostSessionMessageResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema; the `Idempotency-Key` header is missing, empty or longer than 255 characters. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Scope: the credential does not hold `sessions:write`, checked before the body or the resource is read. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /**
             * @description - `IDEMPOTENCY_CONFLICT`: This `Idempotency-Key` was already used for this operation and resource with a different body. Use a new key for a new intent.
             *     - `SESSION_PAUSED`: The session is pausing or paused; resume it first.
             *     - `SESSION_RESUMING`: The session is resuming; wait for the resume receipt.
             *     - `SESSION_STOPPED`: The session is stopping or stopped; resume it first.
             *     - `RECOVERY_REQUIRED`: The session needs a recovery decision first (`POST /v1/sessions/{id}/recovery-decisions`).
             *     - `SESSION_CLOSING`: The session is closing; wait for the close receipt. A close that cannot finish returns the session to `active`.
             *     - `SESSION_CLOSED`: The session is closed and accepts no further commands.
             *     - `CHECKPOINT_UNAVAILABLE`: The session has no committed checkpoint that can serve this request. A pending checkpoint problem holds new work, so a new turn could not be checkpointed; `message` names it.
             *     - `TAKEOVER_REQUIRED`: The person who asked for the session was offboarded; it takes no input until an owner takes it over.
             */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "IDEMPOTENCY_CONFLICT" | "SESSION_PAUSED" | "SESSION_RESUMING" | "SESSION_STOPPED" | "RECOVERY_REQUIRED" | "SESSION_CLOSING" | "SESSION_CLOSED" | "CHECKPOINT_UNAVAILABLE" | "TAKEOVER_REQUIRED";
                        };
                    };
                };
            };
            /**
             * @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB, or `message` is longer than 32 KiB of UTF-8.
             *     - `STORAGE_LIMIT_EXCEEDED`: Accepting this message would exceed the installation's storage limit (`GET /v1/limits`). Retrying does not free space.
             */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE" | "STORAGE_LIMIT_EXCEEDED";
                        };
                    };
                };
            };
            /** @description - `RATE_LIMITED`: Too many requests; wait for `Retry-After` and retry. The session already holds the installation's maximum of queued inputs; `Retry-After` is 5. */
            429: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "RATE_LIMITED";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    listSessionTurns: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of turn summaries. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "items": [
                     *         {
                     *           "turn_id": "1",
                     *           "session_id": "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01",
                     *           "status": "completed",
                     *           "message": "Add a health check endpoint and a test for it.",
                     *           "terminal_reason": null,
                     *           "checkpoint_revision": 2,
                     *           "created_at": "2026-10-11T08:00:00Z",
                     *           "started_at": "2026-10-11T08:00:05Z",
                     *           "ended_at": "2026-10-11T08:03:12Z"
                     *         },
                     *         {
                     *           "turn_id": "2",
                     *           "session_id": "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01",
                     *           "status": "running",
                     *           "message": "Now add the endpoint to the README.",
                     *           "terminal_reason": null,
                     *           "checkpoint_revision": null,
                     *           "created_at": "2026-10-11T08:14:00Z",
                     *           "started_at": "2026-10-11T08:14:02Z",
                     *           "ended_at": null
                     *         }
                     *       ],
                     *       "next_cursor": null
                     *     }
                     */
                    "application/json": components["schemas"]["ListTurnsResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: a query parameter or the page cursor is invalid. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Scope: the credential does not hold `sessions:read`, checked before the body or the resource is read. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    getSessionTurn: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                turn_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The turn as it stands now. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "turn_id": "1",
                     *       "session_id": "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01",
                     *       "status": "completed",
                     *       "message": "Add a health check endpoint and a test for it.",
                     *       "terminal_reason": null,
                     *       "checkpoint_revision": 2,
                     *       "created_at": "2026-10-11T08:00:00Z",
                     *       "started_at": "2026-10-11T08:00:05Z",
                     *       "ended_at": "2026-10-11T08:03:12Z",
                     *       "result": {
                     *         "type": "result",
                     *         "subtype": "success",
                     *         "result": "Added GET /health and a test for it."
                     *       },
                     *       "usage": {
                     *         "input_tokens": 48210,
                     *         "output_tokens": 3120
                     *       },
                     *       "attempts": [
                     *         {
                     *           "attempt_id": "att_01",
                     *           "state": "exited",
                     *           "lease_epoch": 1,
                     *           "execution_generation": 1,
                     *           "started_at": "2026-10-11T08:00:05Z",
                     *           "ended_at": "2026-10-11T08:03:12Z",
                     *           "profile_id": "claude-coding-real"
                     *         }
                     *       ]
                     *     }
                     */
                    "application/json": components["schemas"]["TurnDetail"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Scope: the credential does not hold `sessions:read`, checked before the body or the resource is read. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. Also when `turn_id` names no turn of the session. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    streamSessionEvents: {
        parameters: {
            query?: never;
            header?: {
                /** @description The `id` of the last complete event received. Replay resumes strictly after it; omit it (or send it empty) to replay from the start. A malformed value answers `400 BAD_REQUEST`. */
                "Last-Event-ID"?: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description `text/event-stream`: one frame per event, each an `id:`, an `event:` and a `data:` line, with the envelope as JSON on the `data:` line. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "id": "ev_2s",
                     *       "event": "status",
                     *       "data": {
                     *         "schema_version": 1,
                     *         "session_id": "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01",
                     *         "turn_id": "2",
                     *         "attempt_id": "att_01",
                     *         "occurred_at": "2026-10-11T08:14:02Z",
                     *         "data": {
                     *           "phase": "running"
                     *         }
                     *       }
                     *     }
                     */
                    "text/event-stream": components["schemas"]["SseEvent"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: `Last-Event-ID` is malformed. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Scope: the credential does not hold `sessions:read`, checked before the body or the resource is read. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `CURSOR_EXPIRED`: The cursor fell outside retained history; reread the resource state and start a new stream. Reserved: alpha does not trim events. */
            410: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "CURSOR_EXPIRED";
                        };
                    };
                };
            };
            /** @description - `RATE_LIMITED`: Too many requests; wait for `Retry-After` and retry. This owner already has 8 open streams, or the process 256; `Retry-After` is 15. */
            429: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "RATE_LIMITED";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    listPendingRequests: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Every request that can be answered now; empty when none. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "items": [
                     *         {
                     *           "request_id": "req_7f3a",
                     *           "turn_id": "2",
                     *           "attempt_id": "att_01",
                     *           "created_at": "2026-10-11T08:14:30Z",
                     *           "expires_at": "2026-10-11T08:44:30Z",
                     *           "kind": "permission",
                     *           "tool": "Bash",
                     *           "input": {
                     *             "command": "npm test",
                     *             "description": "Run the tests"
                     *           }
                     *         }
                     *       ],
                     *       "answerable": true
                     *     }
                     */
                    "application/json": components["schemas"]["ListPendingRequestsResponse"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Scope: the credential does not hold `sessions:read`, checked before the body or the resource is read. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    answerPendingRequest: {
        parameters: {
            query?: never;
            header: {
                /** @description Required, 1–255 characters; a UUID per user intent works. A retry with the same key and the same body returns the original response and runs the command once; the same key with a different body answers `409 IDEMPOTENCY_CONFLICT`. A missing or invalid key answers `400 BAD_REQUEST`, after the body is read. */
                "Idempotency-Key": string;
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "request_id": "req_7f3a",
                 *       "kind": "permission",
                 *       "decision": "allow"
                 *     }
                 */
                "application/json": components["schemas"]["PostSessionAnswerRequest"];
            };
        };
        responses: {
            /** @description The answer is stored; the receipt tracks its delivery, and `approval` records who answered and the decision that let them. */
            202: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "receipt_id": "c4a1e9d2-7b3f-4e8a-a6c5-1d2e3f4a5b6c",
                     *       "receipt_status": "accepted",
                     *       "approval": {
                     *         "answered_by": {
                     *           "principal": {
                     *             "kind": "user",
                     *             "id": "3e7f1a90-5c2d-4b8e-8f61-2a9d0c4b7e35"
                     *           },
                     *           "actor_user_id": "3e7f1a90-5c2d-4b8e-8f61-2a9d0c4b7e35",
                     *           "agent_id": null
                     *         },
                     *         "surface": "web",
                     *         "decision_id": "5b9e2d7a-1c4f-4a83-b6e0-8d3f7a2c1e94"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["PostSessionAnswerResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema; the `Idempotency-Key` header is missing, empty or longer than 255 characters. Fix the request before retrying. Also when the answer does not fit the pending request (its kind, question or option ids); `message` says how. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Scope: the credential does not hold `sessions:approve`, checked before the body or the resource is read. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. Also when `request_id` names no request of the session. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /**
             * @description - `IDEMPOTENCY_CONFLICT`: This `Idempotency-Key` was already used for this operation and resource with a different body. Use a new key for a new intent.
             *     - `REQUEST_EXPIRED`: The pending request was already answered, expired or closed.
             *     - `REQUEST_STALE`: The request was made against state that has since moved on. The attempt that asked is no longer the session's live attempt: it ended, lost its lease, or the turn moved on.
             */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "IDEMPOTENCY_CONFLICT" | "REQUEST_EXPIRED" | "REQUEST_STALE";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    listPushRequests: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The session's push requests. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "items": [
                     *         {
                     *           "id": "5b9e2c17-4f3a-4d6e-8a1b-7c0d9e2f3a41",
                     *           "session_id": "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01",
                     *           "repository_id": "sample-app",
                     *           "checkpoint_revision": 3,
                     *           "git_commit": "4f2a9c1e7b3d5a8f0c6e2b9d1a4f7c3e5b8d0a2c",
                     *           "target_branch": "agent/0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01",
                     *           "state": "requested",
                     *           "requested_by": {
                     *             "principal": {
                     *               "kind": "user",
                     *               "id": "3e7f1a90-5c2d-4b8e-8f61-2a9d0c4b7e35"
                     *             },
                     *             "actor_user_id": "3e7f1a90-5c2d-4b8e-8f61-2a9d0c4b7e35",
                     *             "agent_id": null
                     *           },
                     *           "requested_at": "2026-10-11T08:30:00Z",
                     *           "decided_by": null,
                     *           "decided_at": null,
                     *           "decision_reason": null,
                     *           "request_receipt_id": "c4a1e9d2-7b3f-4e8a-a6c5-1d2e3f4a5b6c",
                     *           "decision_receipt_id": null,
                     *           "finished_at": null,
                     *           "push_receipt_id": null
                     *         }
                     *       ]
                     *     }
                     */
                    "application/json": components["schemas"]["ListPushRequestsResponse"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Scope: the credential does not hold `sessions:read`, checked before the body or the resource is read. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    createPushRequest: {
        parameters: {
            query?: never;
            header: {
                /** @description Required, 1–255 characters; a UUID per user intent works. A retry with the same key and the same body returns the original response and runs the command once; the same key with a different body answers `409 IDEMPOTENCY_CONFLICT`. A missing or invalid key answers `400 BAD_REQUEST`, after the body is read. */
                "Idempotency-Key": string;
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /** @example {} */
                "application/json": components["schemas"]["CreatePushRequestRequest"];
            };
        };
        responses: {
            /** @description The request, pinned and waiting for a decision. */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "id": "5b9e2c17-4f3a-4d6e-8a1b-7c0d9e2f3a41",
                     *       "session_id": "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01",
                     *       "repository_id": "sample-app",
                     *       "checkpoint_revision": 3,
                     *       "git_commit": "4f2a9c1e7b3d5a8f0c6e2b9d1a4f7c3e5b8d0a2c",
                     *       "target_branch": "agent/0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01",
                     *       "state": "requested",
                     *       "requested_by": {
                     *         "principal": {
                     *           "kind": "user",
                     *           "id": "3e7f1a90-5c2d-4b8e-8f61-2a9d0c4b7e35"
                     *         },
                     *         "actor_user_id": "3e7f1a90-5c2d-4b8e-8f61-2a9d0c4b7e35",
                     *         "agent_id": null
                     *       },
                     *       "requested_at": "2026-10-11T08:30:00Z",
                     *       "decided_by": null,
                     *       "decided_at": null,
                     *       "decision_reason": null,
                     *       "request_receipt_id": "c4a1e9d2-7b3f-4e8a-a6c5-1d2e3f4a5b6c",
                     *       "decision_receipt_id": null,
                     *       "finished_at": null,
                     *       "push_receipt_id": null
                     *     }
                     */
                    "application/json": components["schemas"]["PushRequest"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema; the `Idempotency-Key` header is missing, empty or longer than 255 characters. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Scope: the credential does not hold `sessions:write`, checked before the body or the resource is read. Also when the deployment does not authenticate callers (`AUTH_MODE=none`): push requests need a verified credential. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /**
             * @description - `IDEMPOTENCY_CONFLICT`: This `Idempotency-Key` was already used for this operation and resource with a different body. Use a new key for a new intent.
             *     - `PUSH_SOURCE_MISSING`: The session has no repository, or no committed checkpoint, to push.
             *     - `PUSH_REQUEST_OPEN`: The session already has an open push request (`requested`, `approved` or `pushing`); the refusal receipt's `result.push_request_id` names it.
             *     - `CHECKPOINT_UNAVAILABLE`: The session has no committed checkpoint that can serve this request. Here: the latest checkpoint's manifest did not verify; a push never falls back to an older one.
             *     - `CHECKPOINT_MOVED`: The commit or checkpoint named no longer matches what the push request pinned. Here: the session checkpointed again while the request was being pinned; send it again.
             */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "IDEMPOTENCY_CONFLICT" | "PUSH_SOURCE_MISSING" | "PUSH_REQUEST_OPEN" | "CHECKPOINT_UNAVAILABLE" | "CHECKPOINT_MOVED";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    getPushRequest: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                push_request_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The push request as it stands now. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "id": "5b9e2c17-4f3a-4d6e-8a1b-7c0d9e2f3a41",
                     *       "session_id": "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01",
                     *       "repository_id": "sample-app",
                     *       "checkpoint_revision": 3,
                     *       "git_commit": "4f2a9c1e7b3d5a8f0c6e2b9d1a4f7c3e5b8d0a2c",
                     *       "target_branch": "agent/0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01",
                     *       "state": "requested",
                     *       "requested_by": {
                     *         "principal": {
                     *           "kind": "user",
                     *           "id": "3e7f1a90-5c2d-4b8e-8f61-2a9d0c4b7e35"
                     *         },
                     *         "actor_user_id": "3e7f1a90-5c2d-4b8e-8f61-2a9d0c4b7e35",
                     *         "agent_id": null
                     *       },
                     *       "requested_at": "2026-10-11T08:30:00Z",
                     *       "decided_by": null,
                     *       "decided_at": null,
                     *       "decision_reason": null,
                     *       "request_receipt_id": "c4a1e9d2-7b3f-4e8a-a6c5-1d2e3f4a5b6c",
                     *       "decision_receipt_id": null,
                     *       "finished_at": null,
                     *       "push_receipt_id": null
                     *     }
                     */
                    "application/json": components["schemas"]["PushRequest"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Scope: the credential does not hold `sessions:read`, checked before the body or the resource is read. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    decidePushRequest: {
        parameters: {
            query?: never;
            header: {
                /** @description Required, 1–255 characters; a UUID per user intent works. A retry with the same key and the same body returns the original response and runs the command once; the same key with a different body answers `409 IDEMPOTENCY_CONFLICT`. A missing or invalid key answers `400 BAD_REQUEST`, after the body is read. */
                "Idempotency-Key": string;
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
                push_request_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "decision": "approve",
                 *       "git_commit": "4f2a9c1e7b3d5a8f0c6e2b9d1a4f7c3e5b8d0a2c"
                 *     }
                 */
                "application/json": components["schemas"]["DecidePushRequestRequest"];
            };
        };
        responses: {
            /** @description The decided request. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "id": "5b9e2c17-4f3a-4d6e-8a1b-7c0d9e2f3a41",
                     *       "session_id": "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01",
                     *       "repository_id": "sample-app",
                     *       "checkpoint_revision": 3,
                     *       "git_commit": "4f2a9c1e7b3d5a8f0c6e2b9d1a4f7c3e5b8d0a2c",
                     *       "target_branch": "agent/0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01",
                     *       "state": "approved",
                     *       "requested_by": {
                     *         "principal": {
                     *           "kind": "user",
                     *           "id": "3e7f1a90-5c2d-4b8e-8f61-2a9d0c4b7e35"
                     *         },
                     *         "actor_user_id": "3e7f1a90-5c2d-4b8e-8f61-2a9d0c4b7e35",
                     *         "agent_id": null
                     *       },
                     *       "requested_at": "2026-10-11T08:30:00Z",
                     *       "decided_by": {
                     *         "principal": {
                     *           "kind": "user",
                     *           "id": "3e7f1a90-5c2d-4b8e-8f61-2a9d0c4b7e35"
                     *         },
                     *         "actor_user_id": "3e7f1a90-5c2d-4b8e-8f61-2a9d0c4b7e35",
                     *         "agent_id": null
                     *       },
                     *       "decided_at": "2026-10-11T08:35:00Z",
                     *       "decision_reason": null,
                     *       "request_receipt_id": "c4a1e9d2-7b3f-4e8a-a6c5-1d2e3f4a5b6c",
                     *       "decision_receipt_id": "e1d2c3b4-a5f6-4789-9abc-def012345678",
                     *       "finished_at": null,
                     *       "push_receipt_id": null
                     *     }
                     */
                    "application/json": components["schemas"]["PushRequest"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema; the `Idempotency-Key` header is missing, empty or longer than 255 characters. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Scope: the credential does not hold `sessions:approve`, checked before the body or the resource is read. Also when the principal is not one that may decide, or the deployment does not authenticate callers (`AUTH_MODE=none`). */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /**
             * @description - `IDEMPOTENCY_CONFLICT`: This `Idempotency-Key` was already used for this operation and resource with a different body. Use a new key for a new intent.
             *     - `PUSH_REQUEST_DECIDED`: The push request was already approved or rejected.
             *     - `CHECKPOINT_MOVED`: The commit or checkpoint named no longer matches what the push request pinned. Here: an approval whose `git_commit` is not the pinned one, or a session that checkpointed after the request; the request stays `requested`.
             */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "IDEMPOTENCY_CONFLICT" | "PUSH_REQUEST_DECIDED" | "CHECKPOINT_MOVED";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    openPullRequest: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
                push_request_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "title": "Add retry to the sync job"
                 *     }
                 */
                "application/json": components["schemas"]["OpenPullRequestRequest"];
            };
        };
        responses: {
            /** @description The pull request: 201 when this call opened it, 200 with `created: false` when it was already open. */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "pull_request": {
                     *         "push_request_id": "5b9e2c17-4f3a-4d6e-8a1b-7c0d9e2f3a41",
                     *         "session_id": "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01",
                     *         "repository_id": "sample-app",
                     *         "number": 42,
                     *         "url": "https://github.com/acme/sample-app/pull/42",
                     *         "head": "agent/0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01",
                     *         "base": "main",
                     *         "created_at": "2026-10-11T08:40:00Z",
                     *         "receipt_id": "a7b8c9d0-e1f2-4a3b-8c4d-5e6f7a8b9c0d"
                     *       },
                     *       "created": true,
                     *       "receipt_id": "a7b8c9d0-e1f2-4a3b-8c4d-5e6f7a8b9c0d"
                     *     }
                     */
                    "application/json": components["schemas"]["OpenPullRequestResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Scope: the credential does not hold `sessions:approve`, checked before the body or the resource is read. Also when the principal may not decide pushes, the deployment does not authenticate callers (`AUTH_MODE=none`), or the repository has no GitHub credential (an App or a github.com PAT). */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /**
             * @description - `PUSH_NOT_PUSHED`: The push request has not been pushed (`state` is not `pushed`); a pull request opens only from a pushed branch.
             *     - `CATALOG_MISMATCH`: The catalog no longer allows what the request depends on: the session's (profile, repository) pair, or the repository entry a push request pinned. Here: the catalog entry for the repository changed after the push request pinned it.
             */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PUSH_NOT_PUSHED" | "CATALOG_MISMATCH";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. Here: GitHub refused or failed the call, after waiting out any rate limit it named (at most two retries). */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    commentPullRequest: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
                push_request_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "body": "Tests pass on the pushed commit.",
                 *       "marker": "status"
                 *     }
                 */
                "application/json": components["schemas"]["CommentPullRequestRequest"];
            };
        };
        responses: {
            /** @description The comment: 201 when this call posted it, 200 with `created: false` when it edited the marked one. */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "pull_request": {
                     *         "push_request_id": "5b9e2c17-4f3a-4d6e-8a1b-7c0d9e2f3a41",
                     *         "session_id": "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01",
                     *         "repository_id": "sample-app",
                     *         "number": 42,
                     *         "url": "https://github.com/acme/sample-app/pull/42",
                     *         "head": "agent/0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01",
                     *         "base": "main",
                     *         "created_at": "2026-10-11T08:40:00Z",
                     *         "receipt_id": "a7b8c9d0-e1f2-4a3b-8c4d-5e6f7a8b9c0d"
                     *       },
                     *       "comment": {
                     *         "id": 2401,
                     *         "url": "https://github.com/acme/sample-app/pull/42#issuecomment-2401",
                     *         "marker": "status",
                     *         "created": true
                     *       },
                     *       "receipt_id": "b8c9d0e1-f2a3-4b4c-9d5e-6f7a8b9c0d1e"
                     *     }
                     */
                    "application/json": components["schemas"]["CommentPullRequestResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Scope: the credential does not hold `sessions:approve`, checked before the body or the resource is read. Also when the principal may not decide pushes, the deployment does not authenticate callers, or the repository has no GitHub credential. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /**
             * @description - `PULL_REQUEST_MISSING`: No pull request was opened from this push request yet; open it first.
             *     - `CATALOG_MISMATCH`: The catalog no longer allows what the request depends on: the session's (profile, repository) pair, or the repository entry a push request pinned. Here: the catalog entry for the repository changed after the push request pinned it.
             */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PULL_REQUEST_MISSING" | "CATALOG_MISMATCH";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. Here: GitHub refused or failed the call, after waiting out any rate limit it named (at most two retries). */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    interruptSession: {
        parameters: {
            query?: never;
            header: {
                /** @description Required, 1–255 characters; a UUID per user intent works. A retry with the same key and the same body returns the original response and runs the command once; the same key with a different body answers `409 IDEMPOTENCY_CONFLICT`. A missing or invalid key answers `400 BAD_REQUEST`, after the body is read. */
                "Idempotency-Key": string;
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "target_turn_id": "2"
                 *     }
                 */
                "application/json": components["schemas"]["InterruptSessionRequest"];
            };
        };
        responses: {
            /** @description The interrupt is stored (`accepted`), or the turn had already ended (`succeeded`, `no_op: true` on the receipt). */
            202: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "receipt_id": "c4a1e9d2-7b3f-4e8a-a6c5-1d2e3f4a5b6c",
                     *       "receipt_status": "accepted"
                     *     }
                     */
                    "application/json": components["schemas"]["ReceiptAcceptedResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema; the `Idempotency-Key` header is missing, empty or longer than 255 characters. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Scope: the credential does not hold `sessions:control`, checked before the body or the resource is read. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. Also when `target_turn_id` names no turn of the session. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /**
             * @description - `IDEMPOTENCY_CONFLICT`: This `Idempotency-Key` was already used for this operation and resource with a different body. Use a new key for a new intent.
             *     - `TURN_NOT_STARTED`: The target turn is still queued; there is nothing to interrupt yet.
             */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "IDEMPOTENCY_CONFLICT" | "TURN_NOT_STARTED";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            /** @description - `UNSUPPORTED_CAPABILITY`: This installation or the session's runtime cannot serve the request. The turn runs on a legacy pod binding, which no worker polls for control. */
            422: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNSUPPORTED_CAPABILITY";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    pauseSession: {
        parameters: {
            query?: never;
            header: {
                /** @description Required, 1–255 characters; a UUID per user intent works. A retry with the same key and the same body returns the original response and runs the command once; the same key with a different body answers `409 IDEMPOTENCY_CONFLICT`. A missing or invalid key answers `400 BAD_REQUEST`, after the body is read. */
                "Idempotency-Key": string;
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "expected_revision": 7,
                 *       "reason": "Done for the day"
                 *     }
                 */
                "application/json": components["schemas"]["PauseSessionRequest"];
            };
        };
        responses: {
            /** @description The pause is stored (`accepted`), or the session had no execution and is `paused` already (`succeeded`). */
            202: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "receipt_id": "c4a1e9d2-7b3f-4e8a-a6c5-1d2e3f4a5b6c",
                     *       "receipt_status": "accepted"
                     *     }
                     */
                    "application/json": components["schemas"]["ReceiptAcceptedResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema; the `Idempotency-Key` header is missing, empty or longer than 255 characters. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Scope: the credential does not hold `sessions:control`, checked before the body or the resource is read. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /**
             * @description - `IDEMPOTENCY_CONFLICT`: This `Idempotency-Key` was already used for this operation and resource with a different body. Use a new key for a new intent.
             *     - `REVISION_CONFLICT`: `expected_revision` is not the session's current `revision`. Reread the session, check the intent still holds, and retry with the new revision. Checked before the admission state, so a stale revision answers this even on a session that is already paused.
             *     - `SESSION_PAUSED`: The session is pausing or paused; resume it first.
             *     - `SESSION_RESUMING`: The session is resuming; wait for the resume receipt.
             *     - `SESSION_STOPPED`: The session is stopping or stopped; resume it first.
             *     - `RECOVERY_REQUIRED`: The session needs a recovery decision first (`POST /v1/sessions/{id}/recovery-decisions`).
             *     - `SESSION_CLOSING`: The session is closing; wait for the close receipt. A close that cannot finish returns the session to `active`.
             *     - `SESSION_CLOSED`: The session is closed and accepts no further commands.
             *     - `CHECKPOINT_UNAVAILABLE`: The session has no committed checkpoint that can serve this request. No live worker can drain the turn and no committed checkpoint covers the last turn; terminate instead.
             */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "IDEMPOTENCY_CONFLICT" | "REVISION_CONFLICT" | "SESSION_PAUSED" | "SESSION_RESUMING" | "SESSION_STOPPED" | "RECOVERY_REQUIRED" | "SESSION_CLOSING" | "SESSION_CLOSED" | "CHECKPOINT_UNAVAILABLE";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            /** @description - `UNSUPPORTED_CAPABILITY`: This installation or the session's runtime cannot serve the request. The session runs on a legacy pod binding. */
            422: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNSUPPORTED_CAPABILITY";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    closeSession: {
        parameters: {
            query?: never;
            header: {
                /** @description Required, 1–255 characters; a UUID per user intent works. A retry with the same key and the same body returns the original response and runs the command once; the same key with a different body answers `409 IDEMPOTENCY_CONFLICT`. A missing or invalid key answers `400 BAD_REQUEST`, after the body is read. */
                "Idempotency-Key": string;
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "expected_revision": 7,
                 *       "reason": "Work is done"
                 *     }
                 */
                "application/json": components["schemas"]["CloseSessionRequest"];
            };
        };
        responses: {
            /** @description The close is stored (`accepted`), or the session had nothing to wait on and is `closed` already (`succeeded`). */
            202: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "receipt_id": "c4a1e9d2-7b3f-4e8a-a6c5-1d2e3f4a5b6c",
                     *       "receipt_status": "accepted"
                     *     }
                     */
                    "application/json": components["schemas"]["ReceiptAcceptedResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema; the `Idempotency-Key` header is missing, empty or longer than 255 characters. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Scope: the credential does not hold `sessions:control`, checked before the body or the resource is read. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /**
             * @description - `IDEMPOTENCY_CONFLICT`: This `Idempotency-Key` was already used for this operation and resource with a different body. Use a new key for a new intent.
             *     - `REVISION_CONFLICT`: `expected_revision` is not the session's current `revision`. Reread the session, check the intent still holds, and retry with the new revision. Checked before the admission state, but after `closed`: a closed session answers `SESSION_CLOSED` whatever the revision.
             *     - `SESSION_PAUSED`: The session is pausing or paused; resume it first. The session is pausing; close it once it is paused.
             *     - `SESSION_RESUMING`: The session is resuming; wait for the resume receipt.
             *     - `SESSION_STOPPED`: The session is stopping or stopped; resume it first. The session is stopping; close it once the terminate receipt has settled.
             *     - `SESSION_CLOSING`: The session is closing; wait for the close receipt. A close that cannot finish returns the session to `active`.
             *     - `SESSION_CLOSED`: The session is closed and accepts no further commands.
             *     - `RECOVERY_REQUIRED`: The session needs a recovery decision first (`POST /v1/sessions/{id}/recovery-decisions`). The session is `recovery_required`, or `stopped` and cannot be resumed; end it with a recovery close instead.
             *     - `CHECKPOINT_UNAVAILABLE`: The session has no committed checkpoint that can serve this request. No live worker can drain and no trusted checkpoint covers the last turn that ran; terminate, then use a recovery close.
             */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "IDEMPOTENCY_CONFLICT" | "REVISION_CONFLICT" | "SESSION_PAUSED" | "SESSION_RESUMING" | "SESSION_STOPPED" | "SESSION_CLOSING" | "SESSION_CLOSED" | "RECOVERY_REQUIRED" | "CHECKPOINT_UNAVAILABLE";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            /** @description - `UNSUPPORTED_CAPABILITY`: This installation or the session's runtime cannot serve the request. The session runs on a legacy pod binding. */
            422: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNSUPPORTED_CAPABILITY";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    terminateSession: {
        parameters: {
            query?: never;
            header: {
                /** @description Required, 1–255 characters; a UUID per user intent works. A retry with the same key and the same body returns the original response and runs the command once; the same key with a different body answers `409 IDEMPOTENCY_CONFLICT`. A missing or invalid key answers `400 BAD_REQUEST`, after the body is read. */
                "Idempotency-Key": string;
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "expected_revision": 7,
                 *       "reason": "Runaway tool loop"
                 *     }
                 */
                "application/json": components["schemas"]["TerminateSessionRequest"];
            };
        };
        responses: {
            /** @description The terminate is stored (`accepted`), or there was nothing to kill and the session is `stopped` (`succeeded`). */
            202: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "receipt_id": "c4a1e9d2-7b3f-4e8a-a6c5-1d2e3f4a5b6c",
                     *       "receipt_status": "accepted",
                     *       "external_effects_reverted": false
                     *     }
                     */
                    "application/json": components["schemas"]["TerminateSessionResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema; the `Idempotency-Key` header is missing, empty or longer than 255 characters. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Scope: the credential does not hold `sessions:control`, checked before the body or the resource is read. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /**
             * @description - `IDEMPOTENCY_CONFLICT`: This `Idempotency-Key` was already used for this operation and resource with a different body. Use a new key for a new intent.
             *     - `REVISION_CONFLICT`: `expected_revision` is not the session's current `revision`. Reread the session, check the intent still holds, and retry with the new revision.
             *     - `SESSION_PAUSED`: The session is pausing or paused; resume it first. Reserved: this operation does not currently return it, because it accepts a session in that state.
             *     - `SESSION_RESUMING`: The session is resuming; wait for the resume receipt. Reserved: this operation does not currently return it, because it accepts a session in that state.
             *     - `SESSION_STOPPED`: The session is stopping or stopped; resume it first. Reserved: this operation does not currently return it, because it accepts a session in that state.
             *     - `RECOVERY_REQUIRED`: The session needs a recovery decision first (`POST /v1/sessions/{id}/recovery-decisions`). Reserved: this operation does not currently return it, because it accepts a session in that state.
             *     - `SESSION_CLOSED`: The session is closed and accepts no further commands.
             */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "IDEMPOTENCY_CONFLICT" | "REVISION_CONFLICT" | "SESSION_PAUSED" | "SESSION_RESUMING" | "SESSION_STOPPED" | "RECOVERY_REQUIRED" | "SESSION_CLOSED";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            /** @description - `UNSUPPORTED_CAPABILITY`: This installation or the session's runtime cannot serve the request. The session runs on a legacy pod binding with no kill path. */
            422: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNSUPPORTED_CAPABILITY";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    changeSessionProfile: {
        parameters: {
            query?: never;
            header: {
                /** @description Required, 1–255 characters; a UUID per user intent works. A retry with the same key and the same body returns the original response and runs the command once; the same key with a different body answers `409 IDEMPOTENCY_CONFLICT`. A missing or invalid key answers `400 BAD_REQUEST`, after the body is read. */
                "Idempotency-Key": string;
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "expected_revision": 8,
                 *       "profile_id": "claude-coding-fast"
                 *     }
                 */
                "application/json": components["schemas"]["ChangeSessionProfileRequest"];
            };
        };
        responses: {
            /** @description The session runs `profile_id` from its next turn on. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "receipt_id": "c4a1e9d2-7b3f-4e8a-a6c5-1d2e3f4a5b6c",
                     *       "receipt_status": "succeeded"
                     *     }
                     */
                    "application/json": components["schemas"]["ReceiptAcceptedResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema; the `Idempotency-Key` header is missing, empty or longer than 255 characters. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Scope: the credential does not hold `sessions:control`, checked before the body or the resource is read. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /**
             * @description - `IDEMPOTENCY_CONFLICT`: This `Idempotency-Key` was already used for this operation and resource with a different body. Use a new key for a new intent.
             *     - `REVISION_CONFLICT`: `expected_revision` is not the session's current `revision`. Reread the session, check the intent still holds, and retry with the new revision. Also when the session's profile changed between the read and the change.
             *     - `SESSION_PAUSED`: The session is pausing or paused; resume it first. The session is pausing.
             *     - `SESSION_RESUMING`: The session is resuming; wait for the resume receipt.
             *     - `SESSION_STOPPED`: The session is stopping or stopped; resume it first. The session is stopping.
             *     - `SESSION_CLOSING`: The session is closing; wait for the close receipt. A close that cannot finish returns the session to `active`.
             *     - `SESSION_CLOSED`: The session is closed and accepts no further commands.
             *     - `RECOVERY_REQUIRED`: The session needs a recovery decision first (`POST /v1/sessions/{id}/recovery-decisions`).
             *     - `RELEASE_PROFILE_MISMATCH`: The release was made for another runtime profile than the one named. The session belongs to an agent release, which sets its profile.
             */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "IDEMPOTENCY_CONFLICT" | "REVISION_CONFLICT" | "SESSION_PAUSED" | "SESSION_RESUMING" | "SESSION_STOPPED" | "SESSION_CLOSING" | "SESSION_CLOSED" | "RECOVERY_REQUIRED" | "RELEASE_PROFILE_MISMATCH";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            /** @description - `UNSUPPORTED_CAPABILITY`: This installation or the session's runtime cannot serve the request. The profile is not in the catalog, not allowed with the session's repository, runs another runtime, or is billed differently. */
            422: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNSUPPORTED_CAPABILITY";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    resumeSession: {
        parameters: {
            query?: never;
            header: {
                /** @description Required, 1–255 characters; a UUID per user intent works. A retry with the same key and the same body returns the original response and runs the command once; the same key with a different body answers `409 IDEMPOTENCY_CONFLICT`. A missing or invalid key answers `400 BAD_REQUEST`, after the body is read. */
                "Idempotency-Key": string;
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "expected_revision": 8
                 *     }
                 */
                "application/json": components["schemas"]["ResumeSessionRequest"];
            };
        };
        responses: {
            /** @description The resume is stored: `accepted` while a worker restores a paused session, `succeeded` when it took effect in the request. */
            202: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "receipt_id": "c4a1e9d2-7b3f-4e8a-a6c5-1d2e3f4a5b6c",
                     *       "receipt_status": "accepted"
                     *     }
                     */
                    "application/json": components["schemas"]["ReceiptAcceptedResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema; the `Idempotency-Key` header is missing, empty or longer than 255 characters. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Scope: the credential does not hold `sessions:control`, checked before the body or the resource is read. Also when an operator revoked the session's execution authority. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /**
             * @description - `IDEMPOTENCY_CONFLICT`: This `Idempotency-Key` was already used for this operation and resource with a different body. Use a new key for a new intent.
             *     - `REVISION_CONFLICT`: `expected_revision` is not the session's current `revision`. Reread the session, check the intent still holds, and retry with the new revision.
             *     - `REQUEST_STALE`: The request was made against state that has since moved on. The session is already active.
             *     - `SESSION_RESUMING`: The session is resuming; wait for the resume receipt.
             *     - `SESSION_CLOSING`: The session is closing; wait for the close receipt. A close that cannot finish returns the session to `active`.
             *     - `SESSION_CLOSED`: The session is closed and accepts no further commands.
             *     - `RECOVERY_REQUIRED`: The session needs a recovery decision first (`POST /v1/sessions/{id}/recovery-decisions`). The session is stopping or needs recovery, or a turn's outcome is unknown.
             *     - `CHECKPOINT_UNAVAILABLE`: The session has no committed checkpoint that can serve this request. The stopped or paused session has no restore point it can resume from.
             *     - `PAUSE_COMMITTING`: The pause has already committed its stop and can no longer be cancelled; wait for it, then resume.
             */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "IDEMPOTENCY_CONFLICT" | "REVISION_CONFLICT" | "REQUEST_STALE" | "SESSION_RESUMING" | "SESSION_CLOSING" | "SESSION_CLOSED" | "RECOVERY_REQUIRED" | "CHECKPOINT_UNAVAILABLE" | "PAUSE_COMMITTING";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            /** @description - `UNSUPPORTED_CAPABILITY`: This installation or the session's runtime cannot serve the request. The session runs on a legacy pod binding. */
            422: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNSUPPORTED_CAPABILITY";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. Also while the stopped session's workspace is being reclaimed; `Retry-After` is 10. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    decideSessionRecovery: {
        parameters: {
            query?: never;
            header: {
                /** @description Required, 1–255 characters; a UUID per user intent works. A retry with the same key and the same body returns the original response and runs the command once; the same key with a different body answers `409 IDEMPOTENCY_CONFLICT`. A missing or invalid key answers `400 BAD_REQUEST`, after the body is read. */
                "Idempotency-Key": string;
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "decision": "abandon",
                 *       "expected_revision": 9,
                 *       "target_turn_id": "3",
                 *       "reason": "The call had no external effect."
                 *     }
                 */
                "application/json": components["schemas"]["RecoveryDecisionRequest"];
            };
        };
        responses: {
            /** @description The decision is applied; the receipt is `succeeded`. */
            202: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "receipt_id": "c4a1e9d2-7b3f-4e8a-a6c5-1d2e3f4a5b6c",
                     *       "receipt_status": "succeeded"
                     *     }
                     */
                    "application/json": components["schemas"]["ReceiptAcceptedResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema; the `Idempotency-Key` header is missing, empty or longer than 255 characters. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Scope: the credential does not hold `sessions:recover`, checked before the body or the resource is read. Also when an operator revoked the session's execution authority. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. Also when `target_turn_id` names no turn of the session. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /**
             * @description - `IDEMPOTENCY_CONFLICT`: This `Idempotency-Key` was already used for this operation and resource with a different body. Use a new key for a new intent.
             *     - `REVISION_CONFLICT`: `expected_revision` is not the session's current `revision`. Reread the session, check the intent still holds, and retry with the new revision.
             *     - `REQUEST_STALE`: The request was made against state that has since moved on. The decision does not apply to the session now: `close` or `start_fresh` on a session not awaiting recovery, `confirm_completed` or `abandon` on a turn whose outcome is not unknown, or `retry_restore` on a session a failed restore did not stop.
             *     - `SESSION_PAUSED`: The session is pausing or paused; resume it first. Reserved: this operation does not currently return it, because it accepts a session in that state. A decision that does not apply to the session answers `REQUEST_STALE`.
             *     - `SESSION_RESUMING`: The session is resuming; wait for the resume receipt. Reserved: this operation does not currently return it, because it accepts a session in that state. A decision that does not apply to the session answers `REQUEST_STALE`.
             *     - `SESSION_STOPPED`: The session is stopping or stopped; resume it first. Reserved: this operation does not currently return it, because it accepts a session in that state. A decision that does not apply to the session answers `REQUEST_STALE`.
             *     - `RECOVERY_REQUIRED`: The session needs a recovery decision first (`POST /v1/sessions/{id}/recovery-decisions`). The execution is not yet confirmed gone, or `start_fresh` while a turn's outcome is still unknown.
             *     - `SESSION_CLOSED`: The session is closed and accepts no further commands.
             *     - `CHECKPOINT_UNAVAILABLE`: The session has no committed checkpoint that can serve this request. `confirm_completed` with no committed checkpoint that reaches the target turn.
             */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "IDEMPOTENCY_CONFLICT" | "REVISION_CONFLICT" | "REQUEST_STALE" | "SESSION_PAUSED" | "SESSION_RESUMING" | "SESSION_STOPPED" | "RECOVERY_REQUIRED" | "SESSION_CLOSED" | "CHECKPOINT_UNAVAILABLE";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            /** @description - `UNSUPPORTED_CAPABILITY`: This installation or the session's runtime cannot serve the request. The session runs on a legacy pod binding. */
            422: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNSUPPORTED_CAPABILITY";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. Also while the stopped session's workspace is being reclaimed; `Retry-After` is 10. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    listInvites: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ListInvitesResponse"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    createInvite: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateInviteRequest"];
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreateInviteResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /**
             * @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them.
             *     - `OWNER_PROTECTED`: Only an owner may grant the owner role or change an owner's role or access (disable, suspend, enable).
             */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN" | "OWNER_PROTECTED";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    revokeInvite: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description No content */
            204: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /** @description - `INVITE_USED`: The invite was already accepted and cannot be used again. */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "INVITE_USED";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    acceptInvite: {
        parameters: {
            query?: never;
            header: {
                /** @description Always required: the literal `agent-platform-web`. */
                "X-Requested-With": "agent-platform-web";
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AcceptInviteRequest"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AcceptInviteResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: The submitted credentials were rejected. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: The request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); every caller must send the header. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /** @description - `INVITE_USED`: The invite was already accepted and cannot be used again. */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "INVITE_USED";
                        };
                    };
                };
            };
            /** @description - `INVITE_EXPIRED`: The invite was revoked, replaced by a newer one, or has expired. Ask for a new invite. */
            410: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "INVITE_EXPIRED";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            /** @description - `RATE_LIMITED`: Too many requests; wait for `Retry-After` and retry. */
            429: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "RATE_LIMITED";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    listMembers: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
                q?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ListMembersResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: a query parameter or the page cursor is invalid. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    updateMember: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                user_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateMemberRequest"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemberView"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /**
             * @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them.
             *     - `SELF_PROTECTED`: A manager cannot change their own role or disable or enable themselves; another manager does it.
             *     - `OWNER_PROTECTED`: Only an owner may grant the owner role or change an owner's role or access (disable, suspend, enable).
             */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN" | "SELF_PROTECTED" | "OWNER_PROTECTED";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /**
             * @description - `ACCOUNT_DISABLED`: The account is suspended. Lift the suspension before changing the role or enabling the membership.
             *     - `MEMBER_DISABLED`: The membership is disabled. Enable it before changing the role.
             *     - `LAST_OWNER`: The change would leave the workspace with no live owner.
             */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "ACCOUNT_DISABLED" | "MEMBER_DISABLED" | "LAST_OWNER";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    disableMember: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                user_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SetAccessRequest"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SetAccessResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /**
             * @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them.
             *     - `SELF_PROTECTED`: A manager cannot change their own role or disable or enable themselves; another manager does it.
             *     - `OWNER_PROTECTED`: Only an owner may grant the owner role or change an owner's role or access (disable, suspend, enable).
             */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN" | "SELF_PROTECTED" | "OWNER_PROTECTED";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /** @description - `LAST_OWNER`: The change would leave the workspace with no live owner. */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "LAST_OWNER";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    enableMember: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                user_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SetAccessRequest"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SetAccessResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /**
             * @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them.
             *     - `SELF_PROTECTED`: A manager cannot change their own role or disable or enable themselves; another manager does it.
             *     - `OWNER_PROTECTED`: Only an owner may grant the owner role or change an owner's role or access (disable, suspend, enable).
             */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN" | "SELF_PROTECTED" | "OWNER_PROTECTED";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /** @description - `ACCOUNT_DISABLED`: The account is suspended. Lift the suspension before changing the role or enabling the membership. */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "ACCOUNT_DISABLED";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    disableUser: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                user_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SetAccessRequest"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SetAccessResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /**
             * @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them.
             *     - `SELF_PROTECTED`: A manager cannot change their own role or disable or enable themselves; another manager does it.
             *     - `OWNER_PROTECTED`: Only an owner may grant the owner role or change an owner's role or access (disable, suspend, enable).
             */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN" | "SELF_PROTECTED" | "OWNER_PROTECTED";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    enableUser: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                user_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SetAccessRequest"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SetAccessResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /**
             * @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them.
             *     - `OWNER_PROTECTED`: Only an owner may grant the owner role or change an owner's role or access (disable, suspend, enable).
             */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN" | "OWNER_PROTECTED";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    listTakeovers: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ListTakeoversResponse"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    takeOverSession: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TakeOverSessionRequest"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReceiptAcceptedResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /** @description - `REQUEST_STALE`: The request was made against state that has since moved on. */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_STALE";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    startSlackLink: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StartSlackLinkResponse"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /**
             * @description - `SLACK_NOT_INSTALLED`: The workspace has no verified Slack install for this team.
             *     - `SLACK_LINK_NOT_CONFIGURED`: Slack account linking cannot start: the workspace has no link app, nothing to make one with (no usable App Configuration Token, or the API runs without its master key) and no fallback OIDC app. `error.details.reason_code` is `config_token`, `store_off` or `no_console`. Ask an owner or admin to set up the Slack connection.
             *     - `SLACK_APP_CREATING`: The Slack app (the agent's, or the workspace's link app) is still being created. `error.details.uncertain: true` means Slack's answer was lost: check api.slack.com/apps for an app made at that time, delete it, then retry with `replace_uncertain: true`.
             *     - `REVISION_CONFLICT`: `expected_revision` is not the session's current `revision`. Reread the session, check the intent still holds, and retry with the new revision.
             */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "SLACK_NOT_INSTALLED" | "SLACK_LINK_NOT_CONFIGURED" | "SLACK_APP_CREATING" | "REVISION_CONFLICT";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    slackLinkCallback: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SlackLinkCallbackRequest"];
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SlackLinkCallbackResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /**
             * @description - `SLACK_NOT_INSTALLED`: The workspace has no verified Slack install for this team.
             *     - `LINK_TEAM_MISMATCH`: The Slack account belongs to another Slack team than the workspace's install.
             *     - `LINK_TAKEN`: The Slack account is already linked to another person.
             *     - `LINK_EXISTS`: The caller already linked a different Slack account in this team; unlink it first.
             */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "SLACK_NOT_INSTALLED" | "LINK_TEAM_MISMATCH" | "LINK_TAKEN" | "LINK_EXISTS";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    listLinkedAccounts: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ListLinkedAccountsResponse"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    unlinkAccount: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReceiptAcceptedResponse"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    listAgents: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
                include?: "summary";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of agents. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "items": [
                     *         {
                     *           "id": "8d2c4f1a-6b3e-4a9d-b7c5-2e1f0a9b8c7d",
                     *           "workspace_id": "9d2c4e61-8a3b-4f70-b1e5-6c0a7d3f2b98",
                     *           "slug": "finance",
                     *           "name": "Finance analyst",
                     *           "status": "active",
                     *           "active_release_id": null,
                     *           "activation_revision": -1,
                     *           "created_by": "3e7f1a90-5c2d-4b8e-8f61-2a9d0c4b7e35",
                     *           "created_at": "2026-10-11T08:00:00Z",
                     *           "updated_at": "2026-10-11T08:00:00Z"
                     *         }
                     *       ],
                     *       "next_cursor": "eyJjcmVhdGVkX2F0IjoiMjAyNi0xMC0xMSAwODowMDowMCswMCIsImlkIjoiOGQyYzRmMWEtNmIzZS00YTlkLWI3YzUtMmUxZjBhOWI4YzdkIn0"
                     *     }
                     */
                    "application/json": components["schemas"]["ListAgentsResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: a query parameter or the page cursor is invalid. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    createAgent: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateAgentRequest"];
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentDetail"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /** @description - `ALREADY_EXISTS`: A resource with the same identity already exists; the operation names which field must be unique. */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "ALREADY_EXISTS";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    countAgents: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The two counts. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "counts": {
                     *         "all": 128,
                     *         "administered": 3
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["CountAgentsResponse"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    getAgent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentDetail"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    updateAgent: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateAgentRequest"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentDetail"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    createAgentRelease: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateAgentReleaseRequest"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreateAgentReleaseResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            /** @description - `UNSUPPORTED_CAPABILITY`: This installation or the session's runtime cannot serve the request. */
            422: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNSUPPORTED_CAPABILITY";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    activateAgent: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ActivateAgentRequest"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ActivateAgentResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /**
             * @description - `REVISION_CONFLICT`: `expected_revision` is not the session's current `revision`. Reread the session, check the intent still holds, and retry with the new revision.
             *     - `PROFILE_DIGEST_MISMATCH`: The runtime profile's settings changed since the release was made; release the agent again.
             *     - `CREDENTIAL_UNBOUND`: The release names a credential its agent has no live binding for; an agent admin must bind it first.
             */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REVISION_CONFLICT" | "PROFILE_DIGEST_MISMATCH" | "CREDENTIAL_UNBOUND";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    listCredentialBindings: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ListCredentialBindingsResponse"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    createCredentialBinding: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateCredentialBindingRequest"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreateCredentialBindingResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /** @description - `CREDENTIAL_REF_IN_USE`: The credential name is already held by an agent identity, or bound to an agent an identity would take it from. */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "CREDENTIAL_REF_IN_USE";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    revokeCredentialBinding: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
                binding_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RevokeCredentialBindingResponse"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    listAgentIdentities: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ListAgentIdentitiesResponse"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    linkAgentIdentity: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LinkAgentIdentityRequest"];
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LinkAgentIdentityResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /**
             * @description - `SLACK_NOT_INSTALLED`: The workspace has no verified Slack install for this team.
             *     - `AGENT_IDENTITY_TAKEN`: The Slack app and team are already pinned to another agent; revoke that identity first.
             *     - `ALREADY_EXISTS`: A resource with the same identity already exists; the operation names which field must be unique.
             *     - `CREDENTIAL_REF_IN_USE`: The credential name is already held by an agent identity, or bound to an agent an identity would take it from.
             */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "SLACK_NOT_INSTALLED" | "AGENT_IDENTITY_TAKEN" | "ALREADY_EXISTS" | "CREDENTIAL_REF_IN_USE";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    revokeAgentIdentity: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
                identity_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RevokeAgentIdentityResponse"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    listSlackBindings: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ListSlackBindingsResponse"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    putSlackBinding: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PutSlackBindingRequest"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PutSlackBindingResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /**
             * @description - `SLACK_NOT_INSTALLED`: The workspace has no verified Slack install for this team.
             *     - `REVISION_CONFLICT`: `expected_revision` is not the session's current `revision`. Reread the session, check the intent still holds, and retry with the new revision.
             */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "SLACK_NOT_INSTALLED" | "REVISION_CONFLICT";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    lookupSlackChannels: {
        parameters: {
            query: {
                ids: string;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Names for the requested IDs. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "items": [
                     *         {
                     *           "id": "C0DEPLOY1",
                     *           "name": "deploy",
                     *           "state": "known"
                     *         }
                     *       ]
                     *     }
                     */
                    "application/json": components["schemas"]["LookupSlackChannelsResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: a query parameter or the page cursor is invalid. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `SLACK_NOT_INSTALLED`: The workspace has no verified Slack install for this team. */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "SLACK_NOT_INSTALLED";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    searchSlackChannels: {
        parameters: {
            query?: {
                q?: string;
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of matching channels. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "items": [
                     *         {
                     *           "id": "C0DEPLOY1",
                     *           "name": "deploy",
                     *           "is_private": false,
                     *           "is_member": true
                     *         },
                     *         {
                     *           "id": "G0DESIGN1",
                     *           "name": "design",
                     *           "is_private": true,
                     *           "is_member": true
                     *         }
                     *       ],
                     *       "next_cursor": "eyJzIjoiYWJjIiwibyI6MiwicSI6ImRlIn0",
                     *       "truncated": false,
                     *       "stale": false
                     *     }
                     */
                    "application/json": components["schemas"]["SearchSlackChannelsResponse"];
                };
            };
            /**
             * @description - `BAD_REQUEST`: The request is malformed: a query parameter or the page cursor is invalid. Fix the request before retrying.
             *     - `CURSOR_EXPIRED`: The cursor fell outside retained history; reread the resource state and start a new stream. Reserved: alpha does not trim events.
             */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST" | "CURSOR_EXPIRED";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `SLACK_NOT_INSTALLED`: The workspace has no verified Slack install for this team. */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "SLACK_NOT_INSTALLED";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. Also when Slack is rate limiting with no list read yet (`Retry-After` is Slack's), when Slack does not answer, or when the API runs without a master key (PLATFORM_SECRET_KEY). */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    getSlackAppManifest: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The generated manifest without secret values. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "manifest_yaml": "display_information:\n  name: Agent\n"
                     *     }
                     */
                    "application/json": components["schemas"]["GetSlackAppManifestResponse"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    getSlackAppSettings: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The saved default mode. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "default_mode": "off"
                     *     }
                     */
                    "application/json": components["schemas"]["SlackAppSettings"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    putSlackAppSettings: {
        parameters: {
            query?: never;
            header: {
                /** @description Required, 1–255 characters; a UUID per user intent works. A retry with the same key and the same body returns the original response and runs the command once; the same key with a different body answers `409 IDEMPOTENCY_CONFLICT`. A missing or invalid key answers `400 BAD_REQUEST`, after the body is read. */
                "Idempotency-Key": string;
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "default_mode": "mention"
                 *     }
                 */
                "application/json": components["schemas"]["SlackAppSettings"];
            };
        };
        responses: {
            /** @description The saved default mode. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "default_mode": "mention"
                     *     }
                     */
                    "application/json": components["schemas"]["SlackAppSettings"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema; the `Idempotency-Key` header is missing, empty or longer than 255 characters. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    getSlackApp: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The agent's app, or null. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "slack_app": {
                     *         "id": "6a1d3e5f-2b4c-4d8e-9f0a-1b2c3d4e5f60",
                     *         "kind": "agent",
                     *         "agent_id": "8d2c4f1a-6b3e-4a9d-b7c5-2e1f0a9b8c7d",
                     *         "state": "created",
                     *         "app_id": "A0B1C2D3E4F",
                     *         "client_id": "1234567890.9876543210",
                     *         "redirect_url": "https://console.example.ts.net/agents/8d2c4f1a-6b3e-4a9d-b7c5-2e1f0a9b8c7d/slack/callback",
                     *         "created_by_token_user": "U0ISSUER",
                     *         "created_at": "2026-10-23T09:00:00Z",
                     *         "updated_at": "2026-10-23T09:00:00Z",
                     *         "secrets": {
                     *           "slack_signing_secret": {
                     *             "configured": true,
                     *             "last4": "c3d4",
                     *             "updated_at": "2026-10-23T09:00:00Z",
                     *             "updated_by": null
                     *           },
                     *           "slack_client_secret": {
                     *             "configured": true,
                     *             "last4": "e5f6",
                     *             "updated_at": "2026-10-23T09:00:00Z",
                     *             "updated_by": null
                     *           },
                     *           "slack_bot_token": {
                     *             "configured": false,
                     *             "last4": null,
                     *             "updated_at": null,
                     *             "updated_by": null
                     *           }
                     *         }
                     *       },
                     *       "event_url": "https://agents.example.test/v1/slack/events/019a0000-0000-7000-8000-0000000000c1",
                     *       "events": {
                     *         "state": "pending",
                     *         "checked_at": null
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["GetSlackAppResponse"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. Also when the API runs without a master key (PLATFORM_SECRET_KEY). */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    createSlackApp: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "replace_uncertain": false
                 *     }
                 */
                "application/json": components["schemas"]["CreateSlackAppRequest"];
            };
        };
        responses: {
            /** @description The agent's app, whether this request created it, and any warnings. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "slack_app": {
                     *         "id": "6a1d3e5f-2b4c-4d8e-9f0a-1b2c3d4e5f60",
                     *         "kind": "agent",
                     *         "agent_id": "8d2c4f1a-6b3e-4a9d-b7c5-2e1f0a9b8c7d",
                     *         "state": "created",
                     *         "app_id": "A0B1C2D3E4F",
                     *         "client_id": "1234567890.9876543210",
                     *         "redirect_url": "https://console.example.ts.net/agents/8d2c4f1a-6b3e-4a9d-b7c5-2e1f0a9b8c7d/slack/callback",
                     *         "created_by_token_user": "U0ISSUER",
                     *         "created_at": "2026-10-23T09:00:00Z",
                     *         "updated_at": "2026-10-23T09:00:00Z",
                     *         "secrets": {
                     *           "slack_signing_secret": {
                     *             "configured": true,
                     *             "last4": "c3d4",
                     *             "updated_at": "2026-10-23T09:00:00Z",
                     *             "updated_by": null
                     *           },
                     *           "slack_client_secret": {
                     *             "configured": true,
                     *             "last4": "e5f6",
                     *             "updated_at": "2026-10-23T09:00:00Z",
                     *             "updated_by": null
                     *           },
                     *           "slack_bot_token": {
                     *             "configured": false,
                     *             "last4": null,
                     *             "updated_at": null,
                     *             "updated_by": null
                     *           }
                     *         }
                     *       },
                     *       "created": true,
                     *       "warnings": []
                     *     }
                     */
                    "application/json": components["schemas"]["CreateSlackAppResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /**
             * @description - `AGENT_NOT_ACTIVE`: The agent has no active release; activate one first.
             *     - `CONFIG_TOKEN_INVALID`: The workspace's Slack App Configuration Token cannot be used. `error.details.reason_code` is `not_set` (none stored), `rejected` (Slack refused it; paste another) or `needs_reentry` (Slack no longer takes the stored token, or a rotation's answer was lost; an owner or admin pastes a new one).
             *     - `SLACK_APP_CREATING`: The Slack app (the agent's, or the workspace's link app) is still being created. `error.details.uncertain: true` means Slack's answer was lost: check api.slack.com/apps for an app made at that time, delete it, then retry with `replace_uncertain: true`.
             *     - `REVISION_CONFLICT`: `expected_revision` is not the session's current `revision`. Reread the session, check the intent still holds, and retry with the new revision. Here: the agent's app is being deleted.
             */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "AGENT_NOT_ACTIVE" | "CONFIG_TOKEN_INVALID" | "SLACK_APP_CREATING" | "REVISION_CONFLICT";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. Also when the API runs without a master key (PLATFORM_SECRET_KEY) or SLACK_OIDC_REDIRECT_URI, when Slack refused the manifest (`error.details.slack_error`; nothing was created) or could not be reached. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    startSlackInstall: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Where the browser goes next, and when the link expires. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "authorize_url": "https://slack.com/oauth/v2/authorize?client_id=1234567890.9876543210&scope=assistant%3Awrite%2Capp_mentions%3Aread%2Cchat%3Awrite%2Cim%3Ahistory%2Cchannels%3Ahistory%2Cgroups%3Ahistory%2Cchannels%3Aread%2Cgroups%3Aread%2Cusers%3Aread%2Cchannels%3Ajoin%2Cgroups%3Awrite&redirect_uri=https%3A%2F%2Fconsole.example.ts.net%2Fagents%2F8d2c4f1a-6b3e-4a9d-b7c5-2e1f0a9b8c7d%2Fslack%2Fcallback&state=<single-use>",
                     *       "expires_at": "2026-10-24T09:10:00Z"
                     *     }
                     */
                    "application/json": components["schemas"]["StartSlackInstallResponse"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /**
             * @description - `SLACK_APP_CREATING`: The Slack app (the agent's, or the workspace's link app) is still being created. `error.details.uncertain: true` means Slack's answer was lost: check api.slack.com/apps for an app made at that time, delete it, then retry with `replace_uncertain: true`.
             *     - `REVISION_CONFLICT`: `expected_revision` is not the session's current `revision`. Reread the session, check the intent still holds, and retry with the new revision. Here: the agent's app is being deleted.
             *     - `CONFIG_TOKEN_INVALID`: The workspace's Slack App Configuration Token cannot be used. `error.details.reason_code` is `not_set` (none stored), `rejected` (Slack refused it; paste another) or `needs_reentry` (Slack no longer takes the stored token, or a rotation's answer was lost; an owner or admin pastes a new one).
             */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "SLACK_APP_CREATING" | "REVISION_CONFLICT" | "CONFIG_TOKEN_INVALID";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. Also when the API runs without a master key (PLATFORM_SECRET_KEY). */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    completeSlackInstall: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "agent_id": "8d2c4f1a-6b3e-4a9d-b7c5-2e1f0a9b8c7d",
                 *       "state": "state-from-the-redirect",
                 *       "code": "code-from-the-redirect"
                 *     }
                 */
                "application/json": components["schemas"]["CompleteSlackInstallRequest"];
            };
        };
        responses: {
            /** @description The app, its verified install, the agent's identity and whether the steps after the install ran. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "slack_app": {
                     *         "id": "6a1d3e5f-2b4c-4d8e-9f0a-1b2c3d4e5f60",
                     *         "kind": "agent",
                     *         "agent_id": "8d2c4f1a-6b3e-4a9d-b7c5-2e1f0a9b8c7d",
                     *         "state": "created",
                     *         "app_id": "A0B1C2D3E4F",
                     *         "client_id": "1234567890.9876543210",
                     *         "redirect_url": "https://console.example.ts.net/agents/8d2c4f1a-6b3e-4a9d-b7c5-2e1f0a9b8c7d/slack/callback",
                     *         "created_by_token_user": "U0ISSUER",
                     *         "created_at": "2026-10-23T09:00:00Z",
                     *         "updated_at": "2026-10-23T09:00:00Z",
                     *         "secrets": {
                     *           "slack_signing_secret": {
                     *             "configured": true,
                     *             "last4": "c3d4",
                     *             "updated_at": "2026-10-23T09:00:00Z",
                     *             "updated_by": null
                     *           },
                     *           "slack_client_secret": {
                     *             "configured": true,
                     *             "last4": "e5f6",
                     *             "updated_at": "2026-10-23T09:00:00Z",
                     *             "updated_by": null
                     *           },
                     *           "slack_bot_token": {
                     *             "configured": true,
                     *             "last4": "a1b2",
                     *             "updated_at": "2026-10-24T09:05:00Z",
                     *             "updated_by": null
                     *           }
                     *         }
                     *       },
                     *       "installation": {
                     *         "id": "3c5e7a9b-1d2f-4a6b-8c0d-2e4f6a8b0c1d",
                     *         "app_id": "A0B1C2D3E4F",
                     *         "team_id": "T0A1B2C3D",
                     *         "bot_user_id": "U0B1C2D3E",
                     *         "status": "verified"
                     *       },
                     *       "agent_identity": {
                     *         "id": "5e7a9c1b-3d4f-4b6c-8d0e-4f6a8b0c2d3e",
                     *         "agent_id": "8d2c4f1a-6b3e-4a9d-b7c5-2e1f0a9b8c7d",
                     *         "provider": "slack_bot",
                     *         "app_id": "A0B1C2D3E4F",
                     *         "team_id": "T0A1B2C3D",
                     *         "bot_user_id": "U0B1C2D3E",
                     *         "credential_ref": "slack_app:6a1d3e5f-2b4c-4d8e-9f0a-1b2c3d4e5f60/slack_bot_token",
                     *         "status": "active",
                     *         "revision": 1,
                     *         "created_by": "7a9c1e3b-5d6f-4c8d-9e0f-6a8b0c2d4e5f",
                     *         "created_at": "2026-10-24T09:05:00Z",
                     *         "revoked_at": null
                     *       },
                     *       "receipt_id": "9c1e3a5b-7d8f-4e0a-8b1c-8b0c2d4e6f7a",
                     *       "finalized": true,
                     *       "warnings": []
                     *     }
                     */
                    "application/json": components["schemas"]["CompleteSlackInstallResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /**
             * @description - `SLACK_INSTALL_STATE_INVALID`: The install link's state cannot be used: `error.details.reason_code` is `not_found` (unknown or already spent), `expired`, or `workspace`, `actor`, `agent` or `app` (issued to another workspace, person or agent, or for an app the agent no longer has). Start the install again.
             *     - `SLACK_INSTALL_DENIED`: Slack sent the admin back without approving (`error.details.slack_error`, e.g. `access_denied`). Start the install again to retry.
             *     - `SLACK_INSTALL_REJECTED`: Slack's answer was not stored: `error.details.reason_code` is `app` or `team` (another app or Slack team than expected), `enterprise` (an org-wide install), `scope` (`error.details.missing_scopes` lists the bot scopes not granted) or `slack_error` (Slack refused; `error.details.slack_error`).
             *     - `SLACK_INSTALL_CONFLICT`: This Slack app is already installed in that Slack team for another workspace.
             *     - `AGENT_IDENTITY_TAKEN`: The Slack app and team are already pinned to another agent; revoke that identity first.
             *     - `CREDENTIAL_REF_IN_USE`: The credential name is already held by an agent identity, or bound to an agent an identity would take it from.
             *     - `REVISION_CONFLICT`: `expected_revision` is not the session's current `revision`. Reread the session, check the intent still holds, and retry with the new revision. Here: the agent's app changed, or the install was revoked, while it was being installed; start again.
             */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "SLACK_INSTALL_STATE_INVALID" | "SLACK_INSTALL_DENIED" | "SLACK_INSTALL_REJECTED" | "SLACK_INSTALL_CONFLICT" | "AGENT_IDENTITY_TAKEN" | "CREDENTIAL_REF_IN_USE" | "REVISION_CONFLICT";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. Also when the API runs without a master key (PLATFORM_SECRET_KEY), or Slack could not be reached; start again. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    receiveSlackEvent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                agent_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "token": "legacy-verification-token",
                 *       "team_id": "T0A1B2C3D",
                 *       "api_app_id": "A0B1C2D3E4F",
                 *       "event": {
                 *         "type": "app_mention",
                 *         "user": "U0PERSON1",
                 *         "text": "<@U0B1C2D3E> summarize this thread",
                 *         "channel": "C0CHANNEL1",
                 *         "ts": "1761300000.000100"
                 *       },
                 *       "type": "event_callback",
                 *       "event_id": "Ev0A1B2C3D4E",
                 *       "event_time": 1761300000
                 *     }
                 */
                "application/json": components["schemas"]["SlackEventEnvelope"];
            };
        };
        responses: {
            /** @description `{"challenge": ...}` for a url_verification, `{"ok": true}` for everything else that was signed. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "ok": true
                     *     }
                     */
                    "application/json": components["schemas"]["SlackEventsResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: The submitted credentials were rejected. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            /** @description - `RATE_LIMITED`: Too many requests; wait for `Retry-After` and retry. */
            429: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "RATE_LIMITED";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    listApiKeys: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ListApiKeysResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: a query parameter or the page cursor is invalid. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    createApiKey: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateApiKeyRequest"];
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreateApiKeyResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /**
             * @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them.
             *     - `SCOPE_NOT_GRANTABLE`: The key asks for a scope its issuer does not hold now, or an agent's key asks for `sessions:approve`.
             */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN" | "SCOPE_NOT_GRANTABLE";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    revokeApiKey: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RevokeApiKeyResponse"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    listTeams: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ListTeamsResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: a query parameter or the page cursor is invalid. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    createTeam: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateTeamRequest"];
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TeamChangeResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /** @description - `ALREADY_EXISTS`: A resource with the same identity already exists; the operation names which field must be unique. */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "ALREADY_EXISTS";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    listMyTeams: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The caller's live teams, by name. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "items": [
                     *         {
                     *           "id": "019a0000-0000-7000-8000-00000000b0a1",
                     *           "name": "research admins"
                     *         }
                     *       ],
                     *       "next_cursor": null
                     *     }
                     */
                    "application/json": components["schemas"]["ListMyTeamsResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: a query parameter or the page cursor is invalid. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    getTeam: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                team_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TeamDetail"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    deleteTeam: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                team_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeleteTeamResponse"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    updateTeam: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                team_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateTeamRequest"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TeamChangeResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /** @description - `ALREADY_EXISTS`: A resource with the same identity already exists; the operation names which field must be unique. */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "ALREADY_EXISTS";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    addTeamMember: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                team_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AddTeamMemberRequest"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TeamChangeResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    removeTeamMember: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                team_id: string;
                user_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TeamChangeResponse"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    listAgentAdmins: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentAdmins"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    addAgentAdmin: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AddAgentAdminRequest"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentAdminChangeResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: the body is not JSON or does not match the request schema. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            /** @description - `PAYLOAD_TOO_LARGE`: The body is larger than 64 KiB. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "PAYLOAD_TOO_LARGE";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    removeAgentAdmin: {
        parameters: {
            query?: never;
            header?: {
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path: {
                id: string;
                kind: "users" | "teams";
                subject_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentAdminChangeResponse"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: CSRF: a cookie-authenticated request lacks `X-Requested-With: agent-platform-web` or is cross-site (`Sec-Fetch-Site`, `Origin`); API-key requests never need the header. Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            /** @description - `REQUEST_TIMEOUT`: The request body did not arrive in full within 15 seconds. The connection is closed; resend the request (with the same `Idempotency-Key`). */
            408: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REQUEST_TIMEOUT";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    listAdministeredAgents: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ListAdministeredAgentsResponse"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Credential: an API key was sent; this operation takes a cookie session only. Permission: where the description names who may call it, the signed-in member is not one of them. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    listProfiles: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Every profile in the catalog, ordered by `id`. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "items": [
                     *         {
                     *           "id": "claude-coding-real",
                     *           "model": "claude-sonnet-5",
                     *           "tools": [
                     *             "Read",
                     *             "Edit",
                     *             "Write",
                     *             "Glob",
                     *             "Grep",
                     *             "Bash"
                     *           ],
                     *           "runtime_kind": "claude_agent_sdk",
                     *           "runtime_version": "0.3.270",
                     *           "billing": "metered",
                     *           "repository_mode": "required"
                     *         }
                     *       ]
                     *     }
                     */
                    "application/json": components["schemas"]["ListProfilesResponse"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Scope: the credential does not hold `sessions:read`, checked before the body or the resource is read. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    getInstallationLimits: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The limits and usage as of `refreshed_at`. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "scope": "installation",
                     *       "refreshed_at": "2026-10-11T08:15:43Z",
                     *       "limits": {
                     *         "execution_slot_limit": 4,
                     *         "queued_input_limit_per_session": 20,
                     *         "storage_limit_bytes": 1073741824,
                     *         "max_turn_seconds": 3600,
                     *         "session_cost_limit_usd": "20",
                     *         "session_token_limit": null,
                     *         "provider_max_retries": 2
                     *       },
                     *       "usage": {
                     *         "execution_slots_used": 1,
                     *         "queued_input_count": 3,
                     *         "storage": {
                     *           "used_bytes": 524288,
                     *           "accounted_content": [
                     *             "input_messages"
                     *           ],
                     *           "updated_at": "2026-10-11T08:14:00Z"
                     *         }
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["InstallationLimitsResponse"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Scope: the credential does not hold `sessions:read`, checked before the body or the resource is read. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    getUsageSummary: {
        parameters: {
            query: {
                scope: "installation" | "me";
                since: string;
                until?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The figures as of `refreshed_at`. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "scope": "me",
                     *       "period": {
                     *         "since": "2026-10-01T00:00:00.000Z",
                     *         "until": "2026-10-11T08:15:43.000Z"
                     *       },
                     *       "refreshed_at": "2026-10-11T08:15:43.000Z",
                     *       "session_count": 12,
                     *       "cost_usd": "3.218400",
                     *       "cost_complete": false,
                     *       "token_count": 1824500,
                     *       "run_seconds": 5410,
                     *       "basis": {
                     *         "sessions": "created_in_period",
                     *         "cost": "provider_usage_estimate",
                     *         "run_time": "turn_wall_clock"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["UsageSummaryResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: a query parameter or the page cursor is invalid. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Scope: the credential does not hold `sessions:read`, checked before the body or the resource is read. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    getUsageSeries: {
        parameters: {
            query: {
                scope: "installation" | "me";
                since: string;
                until?: string;
                bucket?: "day";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The buckets as of `refreshed_at`. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "period": {
                     *         "since": "2026-10-09T00:00:00.000Z",
                     *         "until": "2026-10-11T08:15:43.000Z"
                     *       },
                     *       "refreshed_at": "2026-10-11T08:15:43.000Z",
                     *       "buckets": [
                     *         {
                     *           "date": "2026-10-09",
                     *           "session_count": 5,
                     *           "cost_usd": "1.204100",
                     *           "cost_complete": true,
                     *           "token_count": 702300,
                     *           "run_seconds": 2210
                     *         },
                     *         {
                     *           "date": "2026-10-10",
                     *           "session_count": 0,
                     *           "cost_usd": "0",
                     *           "cost_complete": true,
                     *           "token_count": 0,
                     *           "run_seconds": 0
                     *         },
                     *         {
                     *           "date": "2026-10-11",
                     *           "session_count": 2,
                     *           "cost_usd": "0.381000",
                     *           "cost_complete": false,
                     *           "token_count": 154200,
                     *           "run_seconds": 640
                     *         }
                     *       ]
                     *     }
                     */
                    "application/json": components["schemas"]["UsageSeriesResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: a query parameter or the page cursor is invalid. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Scope: the credential does not hold `sessions:read`, checked before the body or the resource is read. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    getUsageBreakdown: {
        parameters: {
            query: {
                scope: "installation" | "me";
                since: string;
                until?: string;
                by: "model" | "agent";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The groups and their totals; this example is `by=model`. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "rows": [
                     *         {
                     *           "key": "claude-opus-5-5",
                     *           "label": "claude-opus-5-5",
                     *           "session_count": 9,
                     *           "input_tokens": 182000,
                     *           "output_tokens": 64000,
                     *           "cache_read_input_tokens": 1210000,
                     *           "cache_creation_input_tokens": 96000,
                     *           "token_count": 1552000,
                     *           "cost_usd": "2.811000"
                     *         },
                     *         {
                     *           "key": null,
                     *           "label": null,
                     *           "session_count": 1,
                     *           "input_tokens": 0,
                     *           "output_tokens": 0,
                     *           "cache_read_input_tokens": 0,
                     *           "cache_creation_input_tokens": 0,
                     *           "token_count": 0,
                     *           "cost_usd": "0.407400"
                     *         }
                     *       ],
                     *       "totals": {
                     *         "session_count": 10,
                     *         "input_tokens": 182000,
                     *         "output_tokens": 64000,
                     *         "cache_read_input_tokens": 1210000,
                     *         "cache_creation_input_tokens": 96000,
                     *         "token_count": 1552000,
                     *         "cost_usd": "3.218400"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["UsageBreakdownResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: a query parameter or the page cursor is invalid. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Scope: the credential does not hold `sessions:read`, checked before the body or the resource is read. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    getUsageTools: {
        parameters: {
            query: {
                scope: "installation" | "me";
                since: string;
                until?: string;
                agent_id?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The tools called in the period. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "tools": [
                     *         {
                     *           "name": "Bash",
                     *           "calls": 1840,
                     *           "failed": 21,
                     *           "total_ms": 13320000,
                     *           "median_ms": 3100,
                     *           "max_ms": 298000
                     *         },
                     *         {
                     *           "name": "Edit",
                     *           "calls": 702,
                     *           "failed": 12,
                     *           "total_ms": 1620000,
                     *           "median_ms": 900,
                     *           "max_ms": 14200
                     *         }
                     *       ],
                     *       "findings": [
                     *         {
                     *           "kind": "most_time",
                     *           "name": "Bash"
                     *         },
                     *         {
                     *           "kind": "fails_often",
                     *           "name": "Edit"
                     *         },
                     *         {
                     *           "kind": "slowest",
                     *           "name": "Bash"
                     *         }
                     *       ]
                     *     }
                     */
                    "application/json": components["schemas"]["UsageToolsResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: a query parameter or the page cursor is invalid. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Scope: the credential does not hold `sessions:read`, checked before the body or the resource is read. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    getUsageToolCalls: {
        parameters: {
            query: {
                scope: "installation" | "me";
                since: string;
                until?: string;
                agent_id?: string;
                sort?: "recent" | "slowest";
                limit?: number;
                cursor?: string;
            };
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of the tool's calls. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "calls": [
                     *         {
                     *           "session_id": "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01",
                     *           "title": "Fix the flaky login test",
                     *           "agent": "Reviewer",
                     *           "occurred_at": "2026-10-24T09:14:03.120Z",
                     *           "duration_ms": 3120,
                     *           "outcome": "ok"
                     *         },
                     *         {
                     *           "session_id": null,
                     *           "title": null,
                     *           "agent": null,
                     *           "occurred_at": "2026-10-24T09:12:41.004Z",
                     *           "duration_ms": null,
                     *           "outcome": "unknown"
                     *         }
                     *       ],
                     *       "next_cursor": "eyJzb3J0IjoicmVjZW50IiwiYXQiOiIyMDI2LTEwLTI0IDA5OjEyOjQxLjAwNCswMCIsImlkIjo0MjEsIm9yZCI6MX0",
                     *       "per_day": [
                     *         {
                     *           "date": "2026-10-23",
                     *           "calls": 0
                     *         },
                     *         {
                     *           "date": "2026-10-24",
                     *           "calls": 2
                     *         }
                     *       ]
                     *     }
                     */
                    "application/json": components["schemas"]["UsageToolCallsResponse"];
                };
            };
            /** @description - `BAD_REQUEST`: The request is malformed: a query parameter or the page cursor is invalid. Fix the request before retrying. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BAD_REQUEST";
                        };
                    };
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Scope: the credential does not hold `sessions:read`, checked before the body or the resource is read. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
    getReceipt: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The receipt as it stands now. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "id": "c4a1e9d2-7b3f-4e8a-a6c5-1d2e3f4a5b6c",
                     *       "operation": "pause",
                     *       "target_ref": {
                     *         "session_id": "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01",
                     *         "turn_id": null,
                     *         "request_id": null
                     *       },
                     *       "status": "succeeded",
                     *       "result": {
                     *         "resulting_admission_state": "paused",
                     *         "checkpoint_revision": 3,
                     *         "queued_turn_count": 1
                     *       },
                     *       "error": null,
                     *       "created_at": "2026-10-11T08:20:00Z",
                     *       "updated_at": "2026-10-11T08:20:09Z"
                     *     }
                     */
                    "application/json": components["schemas"]["Receipt"];
                };
            };
            /** @description - `UNAUTHORIZED`: No credential, a malformed bearer token, an unknown or revoked API key, or a missing or expired session cookie. */
            401: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "UNAUTHORIZED";
                        };
                    };
                };
            };
            /** @description - `FORBIDDEN`: Scope: the credential does not hold `sessions:read`, checked before the body or the resource is read. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "FORBIDDEN";
                        };
                    };
                };
            };
            /** @description - `NOT_FOUND`: The resource does not exist, its id is malformed, or it belongs to another owner. All three answer the same, so a response never reveals whether someone else's resource exists. */
            404: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "NOT_FOUND";
                        };
                    };
                };
            };
            500: components["responses"]["InternalError"];
            /** @description - `BACKEND_UNAVAILABLE`: Storage is unavailable or the request exceeded its 30-second deadline. Retry the same request, with the same `Idempotency-Key`, after `Retry-After`. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["RequestId"];
                    "Retry-After": components["headers"]["RetryAfter"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "BACKEND_UNAVAILABLE";
                        };
                    };
                };
            };
        };
    };
}
