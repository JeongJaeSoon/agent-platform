// Generated from docs/openapi.json by `bun run --cwd apps/web api:generate`.
// Do not edit by hand.

export interface paths {
    "/healthz": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Process liveness */
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
        /** DB, schema and config readiness */
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
        /** Generated OpenAPI document */
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
        /** Authenticated principal */
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
         */
        post: operations["bootstrap"];
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
        /** Email/password login; sets the session cookie */
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
         */
        post: operations["setAuditRetention"];
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
        /** Revoke the session cookie */
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
        /** The authenticated principal, user and workspace */
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
        /** List sessions visible to the principal */
        get: operations["listSessions"];
        put?: never;
        /** Durably accept a session and its first input */
        post: operations["createSession"];
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
        /** Session detail with projection, execution and durability */
        get: operations["getSession"];
        put?: never;
        post?: never;
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
        /** Estimated cost of a session and whether every turn reported it */
        get: operations["getSessionUsage"];
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
        /** Enqueue the next input after the current turn */
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
        /** Queued and finished turns */
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
        /** Committed result of one turn */
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
         * @description Reconnect after backoff with the last complete event id in `Last-Event-ID`; replay resumes strictly after that event. The stream sends a comment keepalive every 15 seconds and normally remains open. `410 CURSOR_EXPIRED` means the cursor fell outside retained history and the client must resynchronize from resource state; alpha does not trim events, so this response is reserved. A `result` event is engine output, not durable completion: confirm the turn with `GET /v1/sessions/{id}/turns/{turn_id}` and treat only `completed`, `failed`, `interrupted`, `cancelled`, or `outcome_unknown` as terminal.
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
        /** Open permission and question requests */
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
        /** Answer a pending permission or question request */
        post: operations["answerPendingRequest"];
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
         * @description Accepted while the turn runs: the receipt settles when the turn ends, with a result of `{turn_id, terminal, no_op}`. A new request for a turn that has already ended answers `receipt_status: succeeded` at once, and its receipt says `no_op: true` with the terminal the turn reached on its own: the interrupt did nothing. An interrupt accepted while the turn ran is `no_op: true` too when the turn got to another terminal first; when the turn's outcome is unknown, so is the receipt (`status: unknown`, `no_op: false`). A replayed Idempotency-Key answers the receipt's current status instead.
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
        /** Drain the current turn, checkpoint, stop the execution */
        post: operations["pauseSession"];
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
        /** Block dispatch and force the execution down */
        post: operations["terminateSession"];
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
        /** Restore from the last committed checkpoint or cancel a pause */
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
        /** Operator decision for an unknown outcome or a context no checkpoint covers */
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
         */
        get: operations["listInvites"];
        put?: never;
        /**
         * Invite a person to the workspace
         * @description The token is returned once and expires in seven days; only its sha256 is stored. Inviting an address that already has a live invite revokes that invite. An address that is already a live member answers 400. Every invite writes an `invite_member` receipt.
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
        /** Members of the workspace, oldest first */
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
         * @description Demoting the workspace's last live owner answers 409 LAST_OWNER. Writes a `change_member_role` receipt when the role changes.
         */
        patch: operations["updateMember"];
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
         * @description The caller becomes the session's requester and its queued input runs again. API keys are refused.
         */
        post: operations["takeOverSession"];
        delete?: never;
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
         * @description Up to 500, oldest first. API keys are refused.
         */
        get: operations["listAgents"];
        put?: never;
        /**
         * Create an agent and its first card version
         * @description Nothing is released or activated. A slug already used in the workspace answers 409 ALREADY_EXISTS. API keys are refused.
         */
        post: operations["createAgent"];
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
        /** An agent with its versions, releases and active release */
        get: operations["getAgent"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Rename an agent or add a card version
         * @description A `card` becomes a new version; existing versions never change. A card equal to one the agent already has adds nothing.
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
         * @description `expected_revision` is the agent's current `activation_revision` (-1 before the first activation); a stale one answers 409 REVISION_CONFLICT. Sending the same activation again is a no-op with a null `receipt_id`. A release whose runtime profile changed since answers 409 PROFILE_DIGEST_MISMATCH and has to be released again. Sessions already pinned keep their release.
         */
        post: operations["activateAgent"];
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
        /** Installation limits and installation-wide usage */
        get: operations["getInstallationLimits"];
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
        /** Current outcome of an accepted command */
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
            repository_id: string;
            /** @description At most 32768 bytes of UTF-8 */
            message: string;
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
        ResumeSessionRequest: {
            expected_revision: number;
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
        CreateInviteRequest: {
            /** Format: email */
            email: string;
            /** @enum {string} */
            role: "owner" | "member";
        };
        AcceptInviteRequest: {
            token: string;
            password: string;
            display_name?: string;
        };
        UpdateMemberRequest: {
            /** @enum {string} */
            role: "owner" | "member";
        };
        GoogleLoginCallbackRequest: {
            code: string;
            state: string;
        };
        AuditRetentionRequest: {
            audit_retention_days: number;
        };
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
                    mcp: null;
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
                    mcp: null;
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
        ApiErrorResponse: {
            error: {
                /** @enum {string} */
                code: "BAD_REQUEST" | "UNAUTHORIZED" | "FORBIDDEN" | "BOOTSTRAP_DONE" | "NOT_FOUND" | "PAYLOAD_TOO_LARGE" | "REQUEST_TIMEOUT" | "UNSUPPORTED_CAPABILITY" | "RATE_LIMITED" | "STORAGE_LIMIT_EXCEEDED" | "BUDGET_EXCEEDED" | "INTERNAL_ERROR" | "REVISION_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "REQUEST_EXPIRED" | "REQUEST_STALE" | "SESSION_PAUSED" | "SESSION_RESUMING" | "SESSION_CLOSED" | "SESSION_STOPPED" | "RECOVERY_REQUIRED" | "CHECKPOINT_UNAVAILABLE" | "PAUSE_COMMITTING" | "PAUSE_CANCELLED" | "CONTROL_SUPERSEDED" | "TURN_NOT_STARTED" | "BACKEND_UNAVAILABLE" | "LAUNCH_FAILED" | "CATALOG_MISMATCH" | "TAKEOVER_REQUIRED" | "INVITE_EXPIRED" | "INVITE_USED" | "LAST_OWNER" | "LOGIN_LINK_REQUIRED" | "PROFILE_DIGEST_MISMATCH" | "ALREADY_EXISTS" | "NOT_READY" | "CURSOR_EXPIRED" | "LEASE_EXPIRED" | "STALE_EPOCH";
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
        SessionSummary: {
            /** Format: uuid */
            id: string;
            revision: number;
            /** @enum {string} */
            admission_state: "active" | "pausing" | "paused" | "resuming" | "stopping" | "stopped" | "recovery_required" | "closed";
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
            } | null;
            repository_id: string | null;
            current_turn_id: string | null;
            queued_turn_count: number;
            last_event_at: string | null;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            updated_at: string;
        };
        SessionDetail: {
            /** Format: uuid */
            id: string;
            revision: number;
            /** @enum {string} */
            admission_state: "active" | "pausing" | "paused" | "resuming" | "stopping" | "stopped" | "recovery_required" | "closed";
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
            } | null;
            repository_id: string | null;
            current_turn_id: string | null;
            queued_turn_count: number;
            last_event_at: string | null;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            updated_at: string;
            execution: {
                /** @enum {string} */
                backend: "local_docker" | "eks_job" | "lambda_microvm";
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
                    admission_state?: "active" | "pausing" | "paused" | "resuming" | "stopping" | "stopped" | "recovery_required" | "closed";
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
                role: "owner" | "member";
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
                };
                /** Format: date-time */
                created_at: string;
            };
            /** @enum {string} */
            role: "owner" | "member";
        };
        ListMembersResponse: {
            items: components["schemas"]["MemberView"][];
        };
        MemberView: {
            /** Format: uuid */
            user_id: string;
            /** Format: email */
            email: string;
            display_name: string;
            /** @enum {string} */
            role: "owner" | "member";
            disabled_at: string | null;
            /** Format: date-time */
            created_at: string;
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
            operation: "create_session" | "append_message" | "answer" | "interrupt" | "pause" | "terminate" | "resume" | "recovery_decision" | "revoke_execution" | "issue_password_reset" | "reset_password" | "recover_owner" | "takeover" | "invite_member" | "accept_invite" | "revoke_invite" | "change_member_role" | "create_agent" | "update_agent" | "create_agent_release" | "activate_agent";
            target_ref: {
                /** Format: uuid */
                session_id: string;
                turn_id: string | null;
                request_id: string | null;
            } | {
                resource: {
                    /** @enum {string} */
                    kind: "workspace" | "session" | "invite" | "agent" | "agent_release" | "surface_binding" | "session_link" | "dispatch" | "memory" | "routine" | "artifact";
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
                code: "BAD_REQUEST" | "UNAUTHORIZED" | "FORBIDDEN" | "BOOTSTRAP_DONE" | "NOT_FOUND" | "PAYLOAD_TOO_LARGE" | "REQUEST_TIMEOUT" | "UNSUPPORTED_CAPABILITY" | "RATE_LIMITED" | "STORAGE_LIMIT_EXCEEDED" | "BUDGET_EXCEEDED" | "INTERNAL_ERROR" | "REVISION_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "REQUEST_EXPIRED" | "REQUEST_STALE" | "SESSION_PAUSED" | "SESSION_RESUMING" | "SESSION_CLOSED" | "SESSION_STOPPED" | "RECOVERY_REQUIRED" | "CHECKPOINT_UNAVAILABLE" | "PAUSE_COMMITTING" | "PAUSE_CANCELLED" | "CONTROL_SUPERSEDED" | "TURN_NOT_STARTED" | "BACKEND_UNAVAILABLE" | "LAUNCH_FAILED" | "CATALOG_MISMATCH" | "TAKEOVER_REQUIRED" | "INVITE_EXPIRED" | "INVITE_USED" | "LAST_OWNER" | "LOGIN_LINK_REQUIRED" | "PROFILE_DIGEST_MISMATCH" | "ALREADY_EXISTS" | "NOT_READY" | "CURSOR_EXPIRED" | "LEASE_EXPIRED" | "STALE_EPOCH";
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
            role: "owner" | "member";
            scopes: ("sessions:read" | "sessions:write" | "sessions:approve" | "sessions:control" | "sessions:recover")[];
            /** Format: date-time */
            expires_at: string;
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
                role: "owner" | "member";
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
                };
                /** Format: date-time */
                created_at: string;
            } | null;
            scopes: ("sessions:read" | "sessions:write" | "sessions:approve" | "sessions:control" | "sessions:recover")[];
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
                        mcp: null;
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
                    tools: {
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
                    tools: {
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
                    tools: {
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
        OpenApiDocument: {
            /** @constant */
            openapi: "3.1.0";
        } & {
            [key: string]: unknown;
        };
    };
    responses: {
        /** @description Unexpected server error (INTERNAL_ERROR) */
        InternalError: {
            headers: {
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
    headers: never;
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
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
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
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReadyResponse"];
                };
            };
            500: components["responses"]["InternalError"];
            /** @description Error: NOT_READY */
            503: {
                headers: {
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
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
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
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiRootResponse"];
                };
            };
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
                "application/json": components["schemas"]["BootstrapRequest"];
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BootstrapResponse"];
                };
            };
            /** @description Error: BAD_REQUEST */
            400: {
                headers: {
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
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: REQUEST_TIMEOUT */
            408: {
                headers: {
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
            /** @description Error: BOOTSTRAP_DONE */
            409: {
                headers: {
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
            /** @description Error: PAYLOAD_TOO_LARGE */
            413: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
                "application/json": components["schemas"]["LoginRequest"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LoginResponse"];
                };
            };
            /** @description Error: BAD_REQUEST */
            400: {
                headers: {
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
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: REQUEST_TIMEOUT */
            408: {
                headers: {
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
            /** @description Error: PAYLOAD_TOO_LARGE */
            413: {
                headers: {
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
            /** @description Error: RATE_LIMITED */
            429: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StartGoogleLoginResponse"];
                };
            };
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: NOT_FOUND */
            404: {
                headers: {
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
            /** @description Error: REQUEST_TIMEOUT */
            408: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LoginResponse"];
                };
            };
            /** @description Error: BAD_REQUEST */
            400: {
                headers: {
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
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: NOT_FOUND */
            404: {
                headers: {
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
            /** @description Error: REQUEST_TIMEOUT */
            408: {
                headers: {
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
            /** @description Error: LOGIN_LINK_REQUIRED */
            409: {
                headers: {
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
            /** @description Error: PAYLOAD_TOO_LARGE */
            413: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PasswordResetResponse"];
                };
            };
            /** @description Error: BAD_REQUEST */
            400: {
                headers: {
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
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: REQUEST_TIMEOUT */
            408: {
                headers: {
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
            /** @description Error: PAYLOAD_TOO_LARGE */
            413: {
                headers: {
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
            /** @description Error: RATE_LIMITED */
            429: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IssuePasswordResetResponse"];
                };
            };
            /** @description Error: BAD_REQUEST */
            400: {
                headers: {
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
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: NOT_FOUND */
            404: {
                headers: {
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
            /** @description Error: REQUEST_TIMEOUT */
            408: {
                headers: {
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
            /** @description Error: PAYLOAD_TOO_LARGE */
            413: {
                headers: {
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
            /** @description Error: RATE_LIMITED */
            429: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuditRetentionResponse"];
                };
            };
            /** @description Error: BAD_REQUEST */
            400: {
                headers: {
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
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: NOT_FOUND */
            404: {
                headers: {
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
            /** @description Error: REQUEST_TIMEOUT */
            408: {
                headers: {
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
            /** @description Error: PAYLOAD_TOO_LARGE */
            413: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
            /** @description No content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: REQUEST_TIMEOUT */
            408: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuthMeResponse"];
                };
            };
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ListSessionsResponse"];
                };
            };
            /** @description Error: BAD_REQUEST */
            400: {
                headers: {
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
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
                "Idempotency-Key": string;
                /** @description Required with a cookie session: the literal `agent-platform-web`. */
                "X-Requested-With"?: "agent-platform-web";
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateSessionRequest"];
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreateSessionResponse"];
                };
            };
            /** @description Error: BAD_REQUEST */
            400: {
                headers: {
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
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: REQUEST_TIMEOUT */
            408: {
                headers: {
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
            /** @description Error: IDEMPOTENCY_CONFLICT */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "IDEMPOTENCY_CONFLICT";
                        };
                    };
                };
            };
            /** @description Error: PAYLOAD_TOO_LARGE, STORAGE_LIMIT_EXCEEDED */
            413: {
                headers: {
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
            /** @description Error: UNSUPPORTED_CAPABILITY */
            422: {
                headers: {
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
            /** @description Error: RATE_LIMITED */
            429: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionDetail"];
                };
            };
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: NOT_FOUND */
            404: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionUsageResponse"];
                };
            };
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: NOT_FOUND */
            404: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
                "application/json": components["schemas"]["PostSessionMessageRequest"];
            };
        };
        responses: {
            /** @description Success */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostSessionMessageResponse"];
                };
            };
            /** @description Error: BAD_REQUEST */
            400: {
                headers: {
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
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: NOT_FOUND */
            404: {
                headers: {
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
            /** @description Error: REQUEST_TIMEOUT */
            408: {
                headers: {
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
            /** @description Error: IDEMPOTENCY_CONFLICT, SESSION_PAUSED, SESSION_RESUMING, SESSION_STOPPED, RECOVERY_REQUIRED, SESSION_CLOSED, CHECKPOINT_UNAVAILABLE, TAKEOVER_REQUIRED */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "IDEMPOTENCY_CONFLICT" | "SESSION_PAUSED" | "SESSION_RESUMING" | "SESSION_STOPPED" | "RECOVERY_REQUIRED" | "SESSION_CLOSED" | "CHECKPOINT_UNAVAILABLE" | "TAKEOVER_REQUIRED";
                        };
                    };
                };
            };
            /** @description Error: PAYLOAD_TOO_LARGE, STORAGE_LIMIT_EXCEEDED */
            413: {
                headers: {
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
            /** @description Error: RATE_LIMITED */
            429: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ListTurnsResponse"];
                };
            };
            /** @description Error: BAD_REQUEST */
            400: {
                headers: {
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
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: NOT_FOUND */
            404: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TurnDetail"];
                };
            };
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: NOT_FOUND */
            404: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
                "Last-Event-ID"?: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Event stream */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/event-stream": components["schemas"]["SseEvent"];
                };
            };
            /** @description Error: BAD_REQUEST */
            400: {
                headers: {
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
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: NOT_FOUND */
            404: {
                headers: {
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
            /** @description Error: CURSOR_EXPIRED */
            410: {
                headers: {
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
            /** @description Error: RATE_LIMITED */
            429: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ListPendingRequestsResponse"];
                };
            };
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: NOT_FOUND */
            404: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
                "application/json": components["schemas"]["PostSessionAnswerRequest"];
            };
        };
        responses: {
            /** @description Success */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostSessionAnswerResponse"];
                };
            };
            /** @description Error: BAD_REQUEST */
            400: {
                headers: {
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
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: NOT_FOUND */
            404: {
                headers: {
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
            /** @description Error: REQUEST_TIMEOUT */
            408: {
                headers: {
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
            /** @description Error: IDEMPOTENCY_CONFLICT, REQUEST_EXPIRED, REQUEST_STALE */
            409: {
                headers: {
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
            /** @description Error: PAYLOAD_TOO_LARGE */
            413: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
                "application/json": components["schemas"]["InterruptSessionRequest"];
            };
        };
        responses: {
            /** @description Success */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReceiptAcceptedResponse"];
                };
            };
            /** @description Error: BAD_REQUEST */
            400: {
                headers: {
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
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: NOT_FOUND */
            404: {
                headers: {
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
            /** @description Error: REQUEST_TIMEOUT */
            408: {
                headers: {
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
            /** @description Error: IDEMPOTENCY_CONFLICT, TURN_NOT_STARTED */
            409: {
                headers: {
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
            /** @description Error: PAYLOAD_TOO_LARGE */
            413: {
                headers: {
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
            /** @description Error: UNSUPPORTED_CAPABILITY */
            422: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
                "application/json": components["schemas"]["PauseSessionRequest"];
            };
        };
        responses: {
            /** @description Success */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReceiptAcceptedResponse"];
                };
            };
            /** @description Error: BAD_REQUEST */
            400: {
                headers: {
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
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: NOT_FOUND */
            404: {
                headers: {
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
            /** @description Error: REQUEST_TIMEOUT */
            408: {
                headers: {
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
            /** @description Error: IDEMPOTENCY_CONFLICT, REVISION_CONFLICT, SESSION_PAUSED, SESSION_RESUMING, SESSION_STOPPED, RECOVERY_REQUIRED, SESSION_CLOSED, CHECKPOINT_UNAVAILABLE */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "IDEMPOTENCY_CONFLICT" | "REVISION_CONFLICT" | "SESSION_PAUSED" | "SESSION_RESUMING" | "SESSION_STOPPED" | "RECOVERY_REQUIRED" | "SESSION_CLOSED" | "CHECKPOINT_UNAVAILABLE";
                        };
                    };
                };
            };
            /** @description Error: PAYLOAD_TOO_LARGE */
            413: {
                headers: {
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
            /** @description Error: UNSUPPORTED_CAPABILITY */
            422: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
                "application/json": components["schemas"]["TerminateSessionRequest"];
            };
        };
        responses: {
            /** @description Success */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TerminateSessionResponse"];
                };
            };
            /** @description Error: BAD_REQUEST */
            400: {
                headers: {
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
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: NOT_FOUND */
            404: {
                headers: {
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
            /** @description Error: REQUEST_TIMEOUT */
            408: {
                headers: {
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
            /** @description Error: IDEMPOTENCY_CONFLICT, REVISION_CONFLICT, SESSION_PAUSED, SESSION_RESUMING, SESSION_STOPPED, RECOVERY_REQUIRED, SESSION_CLOSED */
            409: {
                headers: {
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
            /** @description Error: PAYLOAD_TOO_LARGE */
            413: {
                headers: {
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
            /** @description Error: UNSUPPORTED_CAPABILITY */
            422: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
                "application/json": components["schemas"]["ResumeSessionRequest"];
            };
        };
        responses: {
            /** @description Success */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReceiptAcceptedResponse"];
                };
            };
            /** @description Error: BAD_REQUEST */
            400: {
                headers: {
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
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: NOT_FOUND */
            404: {
                headers: {
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
            /** @description Error: REQUEST_TIMEOUT */
            408: {
                headers: {
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
            /** @description Error: IDEMPOTENCY_CONFLICT, REVISION_CONFLICT, REQUEST_STALE, SESSION_RESUMING, SESSION_CLOSED, RECOVERY_REQUIRED, CHECKPOINT_UNAVAILABLE, PAUSE_COMMITTING */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "IDEMPOTENCY_CONFLICT" | "REVISION_CONFLICT" | "REQUEST_STALE" | "SESSION_RESUMING" | "SESSION_CLOSED" | "RECOVERY_REQUIRED" | "CHECKPOINT_UNAVAILABLE" | "PAUSE_COMMITTING";
                        };
                    };
                };
            };
            /** @description Error: PAYLOAD_TOO_LARGE */
            413: {
                headers: {
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
            /** @description Error: UNSUPPORTED_CAPABILITY */
            422: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReceiptAcceptedResponse"];
                };
            };
            /** @description Error: BAD_REQUEST */
            400: {
                headers: {
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
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: NOT_FOUND */
            404: {
                headers: {
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
            /** @description Error: REQUEST_TIMEOUT */
            408: {
                headers: {
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
            /** @description Error: IDEMPOTENCY_CONFLICT, REVISION_CONFLICT, REQUEST_STALE, SESSION_PAUSED, SESSION_RESUMING, SESSION_STOPPED, RECOVERY_REQUIRED, SESSION_CLOSED, CHECKPOINT_UNAVAILABLE */
            409: {
                headers: {
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
            /** @description Error: PAYLOAD_TOO_LARGE */
            413: {
                headers: {
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
            /** @description Error: UNSUPPORTED_CAPABILITY */
            422: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ListInvitesResponse"];
                };
            };
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreateInviteResponse"];
                };
            };
            /** @description Error: BAD_REQUEST */
            400: {
                headers: {
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
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: REQUEST_TIMEOUT */
            408: {
                headers: {
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
            /** @description Error: PAYLOAD_TOO_LARGE */
            413: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: NOT_FOUND */
            404: {
                headers: {
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
            /** @description Error: REQUEST_TIMEOUT */
            408: {
                headers: {
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
            /** @description Error: INVITE_USED */
            409: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AcceptInviteResponse"];
                };
            };
            /** @description Error: BAD_REQUEST */
            400: {
                headers: {
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
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: REQUEST_TIMEOUT */
            408: {
                headers: {
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
            /** @description Error: INVITE_USED */
            409: {
                headers: {
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
            /** @description Error: INVITE_EXPIRED */
            410: {
                headers: {
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
            /** @description Error: PAYLOAD_TOO_LARGE */
            413: {
                headers: {
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
            /** @description Error: RATE_LIMITED */
            429: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ListMembersResponse"];
                };
            };
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemberView"];
                };
            };
            /** @description Error: BAD_REQUEST */
            400: {
                headers: {
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
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: NOT_FOUND */
            404: {
                headers: {
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
            /** @description Error: REQUEST_TIMEOUT */
            408: {
                headers: {
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
            /** @description Error: LAST_OWNER */
            409: {
                headers: {
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
            /** @description Error: PAYLOAD_TOO_LARGE */
            413: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ListTakeoversResponse"];
                };
            };
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReceiptAcceptedResponse"];
                };
            };
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: NOT_FOUND */
            404: {
                headers: {
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
            /** @description Error: REQUEST_TIMEOUT */
            408: {
                headers: {
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
            /** @description Error: REQUEST_STALE */
            409: {
                headers: {
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
            500: components["responses"]["InternalError"];
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ListAgentsResponse"];
                };
            };
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentDetail"];
                };
            };
            /** @description Error: BAD_REQUEST */
            400: {
                headers: {
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
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: REQUEST_TIMEOUT */
            408: {
                headers: {
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
            /** @description Error: ALREADY_EXISTS */
            409: {
                headers: {
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
            /** @description Error: PAYLOAD_TOO_LARGE */
            413: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentDetail"];
                };
            };
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: NOT_FOUND */
            404: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
            header: {
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
                "application/json": components["schemas"]["UpdateAgentRequest"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentDetail"];
                };
            };
            /** @description Error: BAD_REQUEST */
            400: {
                headers: {
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
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: NOT_FOUND */
            404: {
                headers: {
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
            /** @description Error: REQUEST_TIMEOUT */
            408: {
                headers: {
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
            /** @description Error: PAYLOAD_TOO_LARGE */
            413: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreateAgentReleaseResponse"];
                };
            };
            /** @description Error: BAD_REQUEST */
            400: {
                headers: {
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
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: NOT_FOUND */
            404: {
                headers: {
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
            /** @description Error: REQUEST_TIMEOUT */
            408: {
                headers: {
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
            /** @description Error: PAYLOAD_TOO_LARGE */
            413: {
                headers: {
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
            /** @description Error: UNSUPPORTED_CAPABILITY */
            422: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ActivateAgentResponse"];
                };
            };
            /** @description Error: BAD_REQUEST */
            400: {
                headers: {
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
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: NOT_FOUND */
            404: {
                headers: {
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
            /** @description Error: REQUEST_TIMEOUT */
            408: {
                headers: {
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
            /** @description Error: REVISION_CONFLICT, PROFILE_DIGEST_MISMATCH */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiErrorResponse"] & {
                        error?: {
                            /** @enum {string} */
                            code?: "REVISION_CONFLICT" | "PROFILE_DIGEST_MISMATCH";
                        };
                    };
                };
            };
            /** @description Error: PAYLOAD_TOO_LARGE */
            413: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InstallationLimitsResponse"];
                };
            };
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Receipt"];
                };
            };
            /** @description Error: UNAUTHORIZED */
            401: {
                headers: {
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
            /** @description Error: FORBIDDEN */
            403: {
                headers: {
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
            /** @description Error: NOT_FOUND */
            404: {
                headers: {
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
            /** @description Error: BACKEND_UNAVAILABLE */
            503: {
                headers: {
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
