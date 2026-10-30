import { createRoute, OpenAPIHono, type RouteConfig } from "@hono/zod-openapi";
import {
  type ApiErrorCode,
  acceptInviteRequestSchema,
  acceptInviteResponseSchema,
  activateAgentRequestSchema,
  activateAgentResponseSchema,
  activationCredentialUnboundDetailsSchema,
  addAgentAdminRequestSchema,
  addTeamMemberRequestSchema,
  adminTerminateSessionRequestSchema,
  agentAdminChangeResponseSchema,
  agentAdminParamsSchema,
  agentAdminsViewSchema,
  agentDetailSchema,
  agentGitHubActivityResponseSchema,
  agentGitHubResponseSchema,
  agentIdentityParamsSchema,
  agentIdParamsSchema,
  apiErrorResponseSchema,
  apiKeyIdParamsSchema,
  apiRootResponseSchema,
  auditReadRequestSchema,
  auditReadResponseSchema,
  auditRetentionRequestSchema,
  auditRetentionResponseSchema,
  authMeResponseSchema,
  BOT_SCOPES,
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  changeSessionProfileRequestSchema,
  closeSessionRequestSchema,
  commentPullRequestRequestSchema,
  commentPullRequestResponseSchema,
  completeSlackInstallRequestSchema,
  completeSlackInstallResponseSchema,
  countAgentsResponseSchema,
  countSessionsQuerySchema,
  countSessionsResponseSchema,
  createAgentReleaseRequestSchema,
  createAgentReleaseResponseSchema,
  createAgentRequestSchema,
  createApiKeyRequestSchema,
  createApiKeyResponseSchema,
  createCredentialBindingRequestSchema,
  createCredentialBindingResponseSchema,
  createInstallationProfileRequestSchema,
  createInviteRequestSchema,
  createInviteResponseSchema,
  createPushRequestRequestSchema,
  createSessionRequestSchema,
  createSessionResponseSchema,
  createSlackAppRequestSchema,
  createSlackAppResponseSchema,
  createTeamRequestSchema,
  createWorkspaceProfileRequestSchema,
  credentialBindingParamsSchema,
  decidePushRequestRequestSchema,
  deleteGitHubAppResponseSchema,
  deleteSlackAppResponseSchema,
  deleteSlackSecretResponseSchema,
  deleteTeamResponseSchema,
  dispatchWorkflowRequestSchema,
  dispatchWorkflowResponseSchema,
  getGitHubAppResponseSchema,
  getReceiptResponseSchema,
  getSessionResponseSchema,
  getSlackAppManifestResponseSchema,
  getSlackAppResponseSchema,
  getTurnResponseSchema,
  githubSettingsResponseSchema,
  githubWorkflowRunSchema,
  googleLoginCallbackRequestSchema,
  healthResponseSchema,
  installationLimitsResponseSchema,
  installationProfileIdParamsSchema,
  installationProfileOptionsResponseSchema,
  interruptSessionRequestSchema,
  inviteIdParamsSchema,
  issuePasswordResetRequestSchema,
  issuePasswordResetResponseSchema,
  limitsQuerySchema,
  limitsResponseSchema,
  linkAgentIdentityRequestSchema,
  linkAgentIdentityResponseSchema,
  linkedAccountParamsSchema,
  listAdministeredAgentsResponseSchema,
  listAdminSessionsResponseSchema,
  listAgentIdentitiesResponseSchema,
  listAgentsQuerySchema,
  listAgentsResponseSchema,
  listApiKeysQuerySchema,
  listApiKeysResponseSchema,
  listCredentialBindingsResponseSchema,
  listInvitesResponseSchema,
  listLinkedAccountsResponseSchema,
  listMembersQuerySchema,
  listMembersResponseSchema,
  listMyTeamsQuerySchema,
  listMyTeamsResponseSchema,
  listPendingRequestsResponseSchema,
  listProfilesResponseSchema,
  listPushRequestsResponseSchema,
  listSessionOutputsResponseSchema,
  listSessionsQuerySchema,
  listSessionsResponseSchema,
  listSlackBindingsResponseSchema,
  listTakeoversResponseSchema,
  listTeamsQuerySchema,
  listTeamsResponseSchema,
  listTurnsQuerySchema,
  listTurnsResponseSchema,
  loginMethodsResponseSchema,
  loginRequestSchema,
  loginResponseSchema,
  lookupSlackChannelsQuerySchema,
  lookupSlackChannelsResponseSchema,
  memberLimitsResponseSchema,
  memberParamsSchema,
  memberUserParamsSchema,
  memberViewSchema,
  openPullRequestRequestSchema,
  openPullRequestResponseSchema,
  passwordResetRequestSchema,
  passwordResetResponseSchema,
  pauseSessionRequestSchema,
  postSessionAnswerRequestSchema,
  postSessionAnswerResponseSchema,
  postSessionMessageRequestSchema,
  postSessionMessageResponseSchema,
  pushRequestParamsSchema,
  pushRequestSchema,
  putAgentGitHubEnabledRequestSchema,
  putAgentGitHubEnabledResponseSchema,
  putGitHubAppRequestSchema,
  putGitHubAppResponseSchema,
  putGitHubSettingsRequestSchema,
  putSlackBindingRequestSchema,
  putSlackBindingResponseSchema,
  putSlackConfigTokenResponseSchema,
  putSlackSecretRequestSchema,
  putSlackSecretResponseSchema,
  readyResponseSchema,
  receiptAcceptedResponseSchema,
  receiptIdParamsSchema,
  recoveryDecisionRequestSchema,
  requestBodyInvalidDetailsSchema,
  rerunWorkflowRequestSchema,
  rerunWorkflowResponseSchema,
  resumeSessionRequestSchema,
  revokeAgentIdentityResponseSchema,
  revokeApiKeyResponseSchema,
  revokeCredentialBindingResponseSchema,
  type SessionScope,
  SLACK_INSTALL_STATE_TTL_SECONDS,
  searchSlackChannelsQuerySchema,
  searchSlackChannelsResponseSchema,
  sessionCredentialUnboundDetailsSchema,
  sessionDurabilitySchema,
  sessionIdParamsSchema,
  sessionOutputParamsSchema,
  sessionRepositorySchema,
  sessionShareSchema,
  sessionSummarySchema,
  sessionUsageResponseSchema,
  setAccessRequestSchema,
  setAccessResponseSchema,
  setSessionShareRequestSchema,
  setSessionShareResponseSchema,
  slackAppParamsSchema,
  slackAppSecretParamsSchema,
  slackAppSettingsSchema,
  slackConfigTokenSummarySchema,
  slackEventEnvelopeSchema,
  slackEventsParamsSchema,
  slackEventsResponseSchema,
  slackGuestRequestSchema,
  slackGuestResponseSchema,
  slackLinkCallbackRequestSchema,
  slackLinkCallbackResponseSchema,
  slackSecretSummarySchema,
  sseEventSchema,
  startGoogleLoginResponseSchema,
  startSlackInstallResponseSchema,
  startSlackLinkResponseSchema,
  takeOverSessionRequestSchema,
  teamChangeResponseSchema,
  teamDetailSchema,
  teamIdParamsSchema,
  teamMemberParamsSchema,
  terminateSessionRequestSchema,
  terminateSessionResponseSchema,
  turnIdParamsSchema,
  turnSummarySchema,
  updateAgentRequestSchema,
  updateAuthMeRequestSchema,
  updateMemberRequestSchema,
  updateSessionRequestSchema,
  updateTeamRequestSchema,
  usageBreakdownQuerySchema,
  usageBreakdownResponseSchema,
  usageSeriesQuerySchema,
  usageSeriesResponseSchema,
  usageSummaryQuerySchema,
  usageSummaryResponseSchema,
  usageToolCallsParamsSchema,
  usageToolCallsQuerySchema,
  usageToolCallsResponseSchema,
  usageToolsQuerySchema,
  usageToolsResponseSchema,
  WEB_SESSION_COOKIE_NAME,
  workflowRunParamsSchema,
  workspaceParamsSchema,
  workspaceProfileChangeResponseSchema,
  workspaceProfileIdParamsSchema,
} from "@werft-ai/contracts";
import { z } from "zod";
import {
  API_INFO_DESCRIPTION,
  accessNote,
  type ErrorContext,
  errorResponseDescription,
  IDEMPOTENCY_KEY_DESCRIPTION,
  LAST_EVENT_ID_DESCRIPTION,
  RESPONSE_HEADERS,
  SECURITY_SCHEME_DESCRIPTIONS,
} from "./openapi-docs.ts";

const OPENAPI_VERSION = "0.1.0-alpha";

const openApiDocumentResponseSchema = z.looseObject({
  openapi: z.literal("3.1.0"),
});

// Request schemas are rendered as input (defaults optional); responses as output.
const requestComponents = {
  CreateSessionRequest: createSessionRequestSchema,
  ListSessionsQuery: listSessionsQuerySchema,
  ListAgentsQuery: listAgentsQuerySchema,
  ListApiKeysQuery: listApiKeysQuerySchema,
  ListTeamsQuery: listTeamsQuerySchema,
  ListMyTeamsQuery: listMyTeamsQuerySchema,
  ListMembersQuery: listMembersQuerySchema,
  CountSessionsQuery: countSessionsQuerySchema,
  LimitsQuery: limitsQuerySchema,
  UsageSummaryQuery: usageSummaryQuerySchema,
  UsageSeriesQuery: usageSeriesQuerySchema,
  UsageBreakdownQuery: usageBreakdownQuerySchema,
  UsageToolsQuery: usageToolsQuerySchema,
  UsageToolCallsQuery: usageToolCallsQuerySchema,
  PostSessionMessageRequest: postSessionMessageRequestSchema,
  ListTurnsQuery: listTurnsQuerySchema,
  SearchSlackChannelsQuery: searchSlackChannelsQuerySchema,
  LookupSlackChannelsQuery: lookupSlackChannelsQuerySchema,
  PostSessionAnswerRequest: postSessionAnswerRequestSchema,
  PostSessionAnswerResponse: postSessionAnswerResponseSchema,
  InterruptSessionRequest: interruptSessionRequestSchema,
  PauseSessionRequest: pauseSessionRequestSchema,
  TerminateSessionRequest: terminateSessionRequestSchema,
  CloseSessionRequest: closeSessionRequestSchema,
  ResumeSessionRequest: resumeSessionRequestSchema,
  ChangeSessionProfileRequest: changeSessionProfileRequestSchema,
  RecoveryDecisionRequest: recoveryDecisionRequestSchema,
  CreatePushRequestRequest: createPushRequestRequestSchema,
  DecidePushRequestRequest: decidePushRequestRequestSchema,
  OpenPullRequestRequest: openPullRequestRequestSchema,
  CommentPullRequestRequest: commentPullRequestRequestSchema,
  DispatchWorkflowRequest: dispatchWorkflowRequestSchema,
  RerunWorkflowRequest: rerunWorkflowRequestSchema,
  PutGitHubSettingsRequest: putGitHubSettingsRequestSchema,
  PutAgentGitHubEnabledRequest: putAgentGitHubEnabledRequestSchema,
  BootstrapRequest: bootstrapRequestSchema,
  LoginRequest: loginRequestSchema,
  PasswordResetRequest: passwordResetRequestSchema,
  SlackLinkCallbackRequest: slackLinkCallbackRequestSchema,
  CreateInviteRequest: createInviteRequestSchema,
  AcceptInviteRequest: acceptInviteRequestSchema,
  UpdateMemberRequest: updateMemberRequestSchema,
  UpdateSessionRequest: updateSessionRequestSchema,
  SetAccessRequest: setAccessRequestSchema,
  GoogleLoginCallbackRequest: googleLoginCallbackRequestSchema,
  AuditRetentionRequest: auditRetentionRequestSchema,
  SlackGuestRequest: slackGuestRequestSchema,
  PutSlackSecretRequest: putSlackSecretRequestSchema,
  PutGitHubAppRequest: putGitHubAppRequestSchema,
  CreateSlackAppRequest: createSlackAppRequestSchema,
  CompleteSlackInstallRequest: completeSlackInstallRequestSchema,
  SlackEventEnvelope: slackEventEnvelopeSchema,
  CreateAgentRequest: createAgentRequestSchema,
  UpdateAgentRequest: updateAgentRequestSchema,
  CreateAgentReleaseRequest: createAgentReleaseRequestSchema,
  ActivateAgentRequest: activateAgentRequestSchema,
  CreateApiKeyRequest: createApiKeyRequestSchema,
  CreateTeamRequest: createTeamRequestSchema,
  CreateWorkspaceProfileRequest: createWorkspaceProfileRequestSchema,
  CreateInstallationProfileRequest: createInstallationProfileRequestSchema,
  SetSessionShareRequest: setSessionShareRequestSchema,
  AuditReadRequest: auditReadRequestSchema,
  AdminTerminateSessionRequest: adminTerminateSessionRequestSchema,
  TakeOverSessionRequest: takeOverSessionRequestSchema,
  UpdateTeamRequest: updateTeamRequestSchema,
  AddTeamMemberRequest: addTeamMemberRequestSchema,
  AddAgentAdminRequest: addAgentAdminRequestSchema,
  LinkAgentIdentityRequest: linkAgentIdentityRequestSchema,
  PutSlackBindingRequest: putSlackBindingRequestSchema,
} satisfies Record<string, z.ZodType>;
const responseComponents = {
  ApiErrorResponse: apiErrorResponseSchema,
  ApiRootResponse: apiRootResponseSchema,
  HealthResponse: healthResponseSchema,
  ReadyResponse: readyResponseSchema,
  CreateSessionResponse: createSessionResponseSchema,
  ListSessionsResponse: listSessionsResponseSchema,
  CountSessionsResponse: countSessionsResponseSchema,
  SessionSummary: sessionSummarySchema,
  SessionRepository: sessionRepositorySchema,
  SessionDetail: getSessionResponseSchema,
  SessionDurability: sessionDurabilitySchema,
  PostSessionMessageResponse: postSessionMessageResponseSchema,
  ListTurnsResponse: listTurnsResponseSchema,
  TurnSummary: turnSummarySchema,
  TurnDetail: getTurnResponseSchema,
  SseEvent: sseEventSchema,
  ListPendingRequestsResponse: listPendingRequestsResponseSchema,
  ListTakeoversResponse: listTakeoversResponseSchema,
  SessionShare: sessionShareSchema,
  SetSessionShareResponse: setSessionShareResponseSchema,
  AuditReadResponse: auditReadResponseSchema,
  ListAdminSessionsResponse: listAdminSessionsResponseSchema,
  StartSlackLinkResponse: startSlackLinkResponseSchema,
  SlackLinkCallbackResponse: slackLinkCallbackResponseSchema,
  ListLinkedAccountsResponse: listLinkedAccountsResponseSchema,
  CreateInviteResponse: createInviteResponseSchema,
  ListInvitesResponse: listInvitesResponseSchema,
  AcceptInviteResponse: acceptInviteResponseSchema,
  ListMembersResponse: listMembersResponseSchema,
  MemberView: memberViewSchema,
  SetAccessResponse: setAccessResponseSchema,
  PushRequest: pushRequestSchema,
  ListPushRequestsResponse: listPushRequestsResponseSchema,
  OpenPullRequestResponse: openPullRequestResponseSchema,
  CommentPullRequestResponse: commentPullRequestResponseSchema,
  DispatchWorkflowResponse: dispatchWorkflowResponseSchema,
  GitHubWorkflowRun: githubWorkflowRunSchema,
  RerunWorkflowResponse: rerunWorkflowResponseSchema,
  GitHubSettingsResponse: githubSettingsResponseSchema,
  AgentGitHubResponse: agentGitHubResponseSchema,
  PutAgentGitHubEnabledResponse: putAgentGitHubEnabledResponseSchema,
  AgentGitHubActivityResponse: agentGitHubActivityResponseSchema,
  ReceiptAcceptedResponse: receiptAcceptedResponseSchema,
  TerminateSessionResponse: terminateSessionResponseSchema,
  Receipt: getReceiptResponseSchema,
  BootstrapResponse: bootstrapResponseSchema,
  LoginResponse: loginResponseSchema,
  LoginMethodsResponse: loginMethodsResponseSchema,
  StartGoogleLoginResponse: startGoogleLoginResponseSchema,
  IssuePasswordResetRequest: issuePasswordResetRequestSchema,
  IssuePasswordResetResponse: issuePasswordResetResponseSchema,
  AuditRetentionResponse: auditRetentionResponseSchema,
  SlackGuestResponse: slackGuestResponseSchema,
  SlackSecretSummary: slackSecretSummarySchema,
  PutSlackSecretResponse: putSlackSecretResponseSchema,
  DeleteSlackSecretResponse: deleteSlackSecretResponseSchema,
  SlackConfigTokenSummary: slackConfigTokenSummarySchema,
  PutSlackConfigTokenResponse: putSlackConfigTokenResponseSchema,
  GetGitHubAppResponse: getGitHubAppResponseSchema,
  PutGitHubAppResponse: putGitHubAppResponseSchema,
  DeleteGitHubAppResponse: deleteGitHubAppResponseSchema,
  GetSlackAppResponse: getSlackAppResponseSchema,
  GetSlackAppManifestResponse: getSlackAppManifestResponseSchema,
  SlackAppSettings: slackAppSettingsSchema,
  CreateSlackAppResponse: createSlackAppResponseSchema,
  DeleteSlackAppResponse: deleteSlackAppResponseSchema,
  StartSlackInstallResponse: startSlackInstallResponseSchema,
  CompleteSlackInstallResponse: completeSlackInstallResponseSchema,
  SlackEventsResponse: slackEventsResponseSchema,
  PasswordResetResponse: passwordResetResponseSchema,
  AuthMeResponse: authMeResponseSchema,
  UpdateAuthMeRequest: updateAuthMeRequestSchema,
  InstallationLimitsResponse: installationLimitsResponseSchema,
  MemberLimitsResponse: memberLimitsResponseSchema,
  LimitsResponse: limitsResponseSchema,
  UsageSummaryResponse: usageSummaryResponseSchema,
  UsageSeriesResponse: usageSeriesResponseSchema,
  UsageBreakdownResponse: usageBreakdownResponseSchema,
  UsageToolsResponse: usageToolsResponseSchema,
  UsageToolCallsResponse: usageToolCallsResponseSchema,
  SessionUsageResponse: sessionUsageResponseSchema,
  ListSessionOutputsResponse: listSessionOutputsResponseSchema,
  ListAgentsResponse: listAgentsResponseSchema,
  CountAgentsResponse: countAgentsResponseSchema,
  ListProfilesResponse: listProfilesResponseSchema,
  WorkspaceProfileChangeResponse: workspaceProfileChangeResponseSchema,
  InstallationProfileOptionsResponse: installationProfileOptionsResponseSchema,
  AgentDetail: agentDetailSchema,
  CreateAgentReleaseResponse: createAgentReleaseResponseSchema,
  ActivateAgentResponse: activateAgentResponseSchema,
  SessionCredentialUnboundDetails: sessionCredentialUnboundDetailsSchema,
  RequestBodyInvalidDetails: requestBodyInvalidDetailsSchema,
  ActivationCredentialUnboundDetails: activationCredentialUnboundDetailsSchema,
  CreateApiKeyResponse: createApiKeyResponseSchema,
  ListApiKeysResponse: listApiKeysResponseSchema,
  RevokeApiKeyResponse: revokeApiKeyResponseSchema,
  ListTeamsResponse: listTeamsResponseSchema,
  TeamDetail: teamDetailSchema,
  TeamChangeResponse: teamChangeResponseSchema,
  DeleteTeamResponse: deleteTeamResponseSchema,
  AgentAdmins: agentAdminsViewSchema,
  AgentAdminChangeResponse: agentAdminChangeResponseSchema,
  ListAdministeredAgentsResponse: listAdministeredAgentsResponseSchema,
  ListMyTeamsResponse: listMyTeamsResponseSchema,
  CreateCredentialBindingRequest: createCredentialBindingRequestSchema,
  CreateCredentialBindingResponse: createCredentialBindingResponseSchema,
  ListCredentialBindingsResponse: listCredentialBindingsResponseSchema,
  RevokeCredentialBindingResponse: revokeCredentialBindingResponseSchema,
  LinkAgentIdentityResponse: linkAgentIdentityResponseSchema,
  ListAgentIdentitiesResponse: listAgentIdentitiesResponseSchema,
  RevokeAgentIdentityResponse: revokeAgentIdentityResponseSchema,
  ListSlackBindingsResponse: listSlackBindingsResponseSchema,
  PutSlackBindingResponse: putSlackBindingResponseSchema,
  SearchSlackChannelsResponse: searchSlackChannelsResponseSchema,
  LookupSlackChannelsResponse: lookupSlackChannelsResponseSchema,
  OpenApiDocument: openApiDocumentResponseSchema,
} satisfies Record<string, z.ZodType>;

export const OPENAPI_TAGS = [
  {
    name: "Health",
    description: "Check process health, readiness and API metadata.",
  },
  {
    name: "Auth",
    description:
      "Discover the API, sign in (including by redeeming an invite) and manage authenticated browser sessions.",
  },
  {
    name: "Sessions",
    description: "Create sessions and inspect their state and usage.",
  },
  {
    name: "Messages & turns",
    description: "Send session input and inspect turn history and results.",
  },
  {
    name: "Events",
    description: "Stream durable session events.",
  },
  {
    name: "Pending requests",
    description: "List and answer pending permission and question requests.",
  },
  {
    name: "Push requests",
    description:
      "Ask for a session's result to be pushed to its `agent/<session-id>` branch, and approve or reject that push.",
  },
  {
    name: "GitHub work",
    description:
      "Start, read and rerun GitHub Actions runs in a session's repository, as the agent's release and the workspace ceiling allow.",
  },
  {
    name: "Session control",
    description:
      "Stop, pause, resume, close or interrupt a session's execution.",
  },
  {
    name: "Recovery",
    description:
      "Resolve sessions that require an operator recovery decision. The requester's own decision also takes an API key with `sessions:recover`.",
  },
  {
    name: "Admin",
    description:
      "See and stop every session of the workspace, read a session outside its share with an audited reason, decide recovery for any session, and take over the sessions of members who were offboarded. Owners and admins, signed in; only an owner decides recovery. Every operation here refuses an API key except the recovery decision, which also takes a key holding `sessions:recover`, but only for sessions the key can already see.",
  },
  {
    name: "Members",
    description:
      "Invite people, change member roles and issue password reset links. Owners and admins, from a browser session; only an owner grants or changes the owner role or issues a password reset link.",
  },
  {
    name: "Teams",
    description:
      "Group people into teams; a team named an agent's admin makes every member of it one. Owners and admins change teams, from a browser session. A person added joins at once, without accepting.",
  },
  {
    name: "Workspace settings",
    description: "Change workspace-wide settings. Owners only.",
  },
  {
    name: "Agents",
    description:
      "Write agent cards, release a version against a runtime profile, activate a release and bind the credential names it runs with. Owners, admins, and each agent's own admins.",
  },
  {
    name: "Linked accounts",
    description:
      "Link and unlink the caller's own Slack account through Sign in with Slack.",
  },
  {
    name: "API keys",
    description:
      "Issue and revoke keys, never above what the issuer holds. Signed-in people only.",
  },
  {
    name: "Limits & receipts",
    description:
      "Inspect installation limits and asynchronous command receipts.",
  },
] as const;

type ComponentName =
  | keyof typeof requestComponents
  | keyof typeof responseComponents;

type ApiTagName = (typeof OPENAPI_TAGS)[number]["name"];

// Scalar renders these as the sections of the reference sidebar.
export const OPENAPI_TAG_GROUPS = [
  { name: "Getting started", tags: ["Auth", "API keys"] },
  { name: "Agents", tags: ["Agents"] },
  {
    name: "Sessions",
    tags: [
      "Sessions",
      "Messages & turns",
      "Events",
      "Pending requests",
      "Session control",
      "Push requests",
      "GitHub work",
    ],
  },
  {
    name: "Workspace management",
    tags: ["Members", "Teams", "Linked accounts", "Workspace settings"],
  },
  { name: "Administration", tags: ["Admin", "Recovery"] },
  { name: "Operations", tags: ["Health", "Limits & receipts"] },
] as const satisfies readonly { name: string; tags: readonly ApiTagName[] }[];

export type RouteDeclaration = {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  operationId: string;
  tag: ApiTagName;
  summary: string;
  description?: string;
  scope?: "read" | "write" | "approve" | "control" | "recover";
  // Who may call: `scope` routes take an API key or a cookie session,
  // `auth: "session"` routes only a cookie session, `auth: "public"` routes
  // sit outside the auth middleware (03 §3.2 allowlist). Default: scope
  // present → both credentials; absent → public probe.
  auth?: "public" | "session";
  // A public route that sets the session cookie needs the CSRF header from
  // every caller (login CSRF), not only from cookie principals.
  csrf?: "always";
  query?: ComponentName;
  body?: ComponentName;
  // Parsed with the body schema by openapi.test.ts.
  requestExample?: unknown;
  success:
    | {
        status: 200 | 201 | 202;
        schema: ComponentName;
        sse?: boolean;
        description?: string;
        // Parsed with `schema` by openapi.test.ts.
        example?: unknown;
      }
    // A file download: the body is the file's bytes, not JSON.
    | { status: 200; download: true; description: string }
    | { status: 204; description?: string };
  errors: number[];
  errorCodes?: Partial<Record<number, readonly ApiErrorCode[]>>;
  // Appended to ERROR_CODE_WHEN's sentence where a code is narrower here.
  errorNotes?: Partial<Record<ApiErrorCode, string>>;
  lastEventId?: boolean;
  // The service checks `scope` itself, so it can record the refusal; the
  // /v1 scope table leaves the route alone. The document still shows it.
  scopeCheckedBy?: "service";
  // Most POSTs are commands and take Idempotency-Key; auth endpoints do not.
  idempotent?: false;
};

const CONFLICTS = [400, 401, 404, 409];

const COMMON_ERROR_CODES: Partial<Record<number, readonly ApiErrorCode[]>> = {
  400: ["BAD_REQUEST"],
  401: ["UNAUTHORIZED"],
  403: ["FORBIDDEN"],
  404: ["NOT_FOUND"],
  408: ["REQUEST_TIMEOUT"],
  410: ["CURSOR_EXPIRED"],
  413: ["PAYLOAD_TOO_LARGE"],
  422: ["UNSUPPORTED_CAPABILITY"],
  429: ["RATE_LIMITED"],
  500: ["INTERNAL_ERROR"],
  503: ["BACKEND_UNAVAILABLE"],
};

// Example values shared across declarations, so the examples read as one
// session's story.
const EXAMPLE_SESSION_ID = "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01";
const EXAMPLE_RECEIPT_ID = "c4a1e9d2-7b3f-4e8a-a6c5-1d2e3f4a5b6c";
const EXAMPLE_USER_ID = "3e7f1a90-5c2d-4b8e-8f61-2a9d0c4b7e35";
const EXAMPLE_AGENT_ID = "8d2c4f1a-6b3e-4a9d-b7c5-2e1f0a9b8c7d";
const EXAMPLE_SLACK_APP_REDIRECT = `https://console.example.ts.net/agents/${EXAMPLE_AGENT_ID}/slack/callback`;
const EXAMPLE_SLACK_APP = {
  id: "6a1d3e5f-2b4c-4d8e-9f0a-1b2c3d4e5f60",
  kind: "agent",
  agent_id: EXAMPLE_AGENT_ID,
  state: "created",
  app_id: "A0B1C2D3E4F",
  client_id: "1234567890.9876543210",
  redirect_url: EXAMPLE_SLACK_APP_REDIRECT,
  created_by_token_user: "U0ISSUER",
  created_at: "2026-10-23T09:00:00Z",
  updated_at: "2026-10-23T09:00:00Z",
  secrets: {
    slack_signing_secret: {
      configured: true,
      last4: "c3d4",
      updated_at: "2026-10-23T09:00:00Z",
      updated_by: null,
    },
    slack_client_secret: {
      configured: true,
      last4: "e5f6",
      updated_at: "2026-10-23T09:00:00Z",
      updated_by: null,
    },
    slack_bot_token: {
      configured: false,
      last4: null,
      updated_at: null,
      updated_by: null,
    },
  },
};
const EXAMPLE_SLACK_AUTHORIZE_URL = `https://slack.com/oauth/v2/authorize?${new URLSearchParams(
  {
    client_id: EXAMPLE_SLACK_APP.client_id,
    scope: BOT_SCOPES.join(","),
    redirect_uri: EXAMPLE_SLACK_APP_REDIRECT,
  },
)}`;
const EXAMPLE_WORKSPACE = {
  id: "9d2c4e61-8a3b-4f70-b1e5-6c0a7d3f2b98",
  slug: "acme",
  name: "Acme",
  settings: {
    dispatch_model: null,
    kill_switch: false,
    daily_cost_limit_usd: null,
    idle_pause_minutes: 30,
    audit_retention_days: 90,
    slack_guest_enabled: false,
  },
  created_at: "2026-10-01T09:00:00Z",
};
const ALL_SCOPES = [
  "sessions:read",
  "sessions:write",
  "sessions:approve",
  "sessions:control",
  "sessions:recover",
];
const TEAM_PAGES =
  "By `name`, then `id`, `limit` per page (default 50, at most 100). Pass `next_cursor` back as `cursor` for the next page; it is null on the last one. A cursor that does not decode to a position in that order answers 400; a cursor only positions the read, so one from another workspace shows nothing of it. A team renamed while the pages are read can show twice or not at all; every other team shows once.";

const WORKSPACE_PROFILE_EXAMPLE = {
  id: "ws_acme_strict-review_v2",
  source: "workspace",
  model: "claude-sonnet-5",
  models: ["claude-sonnet-5"],
  tools: ["Read", "Glob", "Grep"],
  permission_mode: "default",
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  billing: "metered",
  repository_mode: "required",
  workspace: {
    name: "strict-review",
    version: 2,
    base_profile_id: "claude-coding-real",
    state: "usable",
    created_by: "019a0000-0000-7000-8000-0000000000b1",
    created_at: "2026-10-27T01:00:00.000Z",
    retired_by: null,
    retired_at: null,
  },
} as const;

const INSTALLATION_PROFILE_EXAMPLE = {
  id: "op_coding_v2",
  source: "operator",
  model: "claude-sonnet-5",
  models: ["claude-sonnet-5", "claude-haiku-5"],
  tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
  permission_mode: "acceptEdits",
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  billing: "metered",
  repository_mode: "required",
  repository_ids: ["sample-app"],
  installation: {
    name: "coding",
    version: 2,
    origin: "console",
    state: "usable",
    connection_id: "anthropic-main",
    title_model: "claude-haiku-5",
    project_settings: { claude_md: true },
    previous_id: "op_coding_v1",
    created_by: "019a0000-0000-7000-8000-0000000000b1",
    created_at: "2026-10-28T01:00:00.000Z",
    retired_by: null,
    retired_at: null,
    blocked_by: null,
    blocked_at: null,
  },
} as const;

const EXAMPLE_AGENT = {
  id: EXAMPLE_AGENT_ID,
  workspace_id: EXAMPLE_WORKSPACE.id,
  slug: "finance",
  name: "Finance analyst",
  status: "active",
  active_release_id: null,
  activation_revision: -1,
  created_by: EXAMPLE_USER_ID,
  created_at: "2026-10-11T08:00:00Z",
  updated_at: "2026-10-11T08:00:00Z",
};
const EXAMPLE_SESSION_SUMMARY = {
  id: EXAMPLE_SESSION_ID,
  title: "Fix the flaky checkout test",
  agent: {
    id: "8f6c1d2e-4b3a-4c5d-9e8f-7a6b5c4d3e2f",
    name: "Checkout fixer",
    release_version_no: 3,
    release_label: "2026-10-11_17:00:00",
  },
  created_by: {
    user_id: "1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b",
    display_name: "Mina Park",
  },
  channel: "web",
  slack_permalink: null,
  revision: 7,
  admission_state: "active",
  status: "running",
  runtime: {
    kind: "claude_agent_sdk",
    version: "0.2.1",
    profile_id: "claude-coding-real",
    model: "claude-sonnet-5",
    permission_mode: "default",
  },
  model: "claude-sonnet-5",
  repository_id: "sample-app",
  repository: {
    id: "sample-app",
    full_name: "acme/sample-app",
    branch: "main",
  },
  current_turn_id: "3",
  queued_turn_count: 1,
  last_event_at: "2026-10-11T08:15:42Z",
  created_at: "2026-10-11T08:00:00Z",
  updated_at: "2026-10-11T08:15:40Z",
};
const EXAMPLE_SESSION_DETAIL = {
  ...EXAMPLE_SESSION_SUMMARY,
  execution: {
    backend: "local_docker",
    state: "running",
    observed_at: "2026-10-11T08:15:38Z",
  },
  checkpoint_revision: 2,
  pending_request_count: 0,
  attention: null,
  durability: {
    last_transcript_persisted_at: "2026-10-11T08:15:41Z",
    checkpoint_committed_at: "2026-10-11T08:10:02Z",
    checkpoint_revision: 2,
    last_completed_turn_id: "2",
    last_checkpointed_turn_id: "2",
    checkpoint_pending_reason: null,
    checkpoint_fallback_revision: null,
    context_reset_turn_id: null,
  },
};
const EXAMPLE_TURN_SUMMARY = {
  turn_id: "1",
  session_id: EXAMPLE_SESSION_ID,
  status: "completed",
  message: "Add a health check endpoint and a test for it.",
  channel: "web",
  created_by: { user_id: EXAMPLE_USER_ID, display_name: "Mina Park" },
  slack_permalink: null,
  terminal_reason: null,
  checkpoint_revision: 2,
  created_at: "2026-10-11T08:00:00Z",
  started_at: "2026-10-11T08:00:05Z",
  ended_at: "2026-10-11T08:03:12Z",
};
const EXAMPLE_PUSH_REQUEST_ID = "5b9e2c17-4f3a-4d6e-8a1b-7c0d9e2f3a41";
const EXAMPLE_GIT_COMMIT = "4f2a9c1e7b3d5a8f0c6e2b9d1a4f7c3e5b8d0a2c";
const EXAMPLE_ACTOR = {
  principal: { kind: "user", id: EXAMPLE_USER_ID },
  actor_user_id: EXAMPLE_USER_ID,
  agent_id: null,
};
const EXAMPLE_PUSH_REQUEST = {
  id: EXAMPLE_PUSH_REQUEST_ID,
  session_id: EXAMPLE_SESSION_ID,
  repository_id: "sample-app",
  checkpoint_revision: 3,
  git_commit: EXAMPLE_GIT_COMMIT,
  target_branch: `agent/${EXAMPLE_SESSION_ID}`,
  state: "requested",
  requested_by: EXAMPLE_ACTOR,
  requested_at: "2026-10-11T08:30:00Z",
  decided_by: null,
  decided_at: null,
  decision_reason: null,
  request_receipt_id: EXAMPLE_RECEIPT_ID,
  decision_receipt_id: null,
  finished_at: null,
  push_receipt_id: null,
};
const EXAMPLE_PULL_REQUEST = {
  push_request_id: EXAMPLE_PUSH_REQUEST_ID,
  session_id: EXAMPLE_SESSION_ID,
  repository_id: "sample-app",
  number: 42,
  url: "https://github.com/acme/sample-app/pull/42",
  head: `agent/${EXAMPLE_SESSION_ID}`,
  base: "main",
  created_at: "2026-10-11T08:40:00Z",
  receipt_id: "a7b8c9d0-e1f2-4a3b-8c4d-5e6f7a8b9c0d",
};
const ACCEPTED_RECEIPT = {
  receipt_id: EXAMPLE_RECEIPT_ID,
  receipt_status: "accepted",
};
const RESERVED_HERE =
  "Reserved: this operation does not currently return it, because it accepts a session in that state.";

export const API_ROUTE_DECLARATIONS = [
  {
    method: "get",
    path: "/healthz",
    operationId: "getHealth",
    tag: "Health",
    summary: "Process liveness",
    description:
      "Answers 200 while the process serves HTTP; it checks nothing else, not even the database. Use it as a liveness probe, and `/readyz` to decide whether to send traffic.",
    success: {
      status: 200,
      schema: "HealthResponse",
      description: "The process is up.",
      example: { status: "ok" },
    },
    errors: [],
  },
  {
    method: "get",
    path: "/readyz",
    operationId: "getReady",
    tag: "Health",
    summary: "DB, schema and config readiness",
    description:
      "Runs the readiness checks in order and stops at the first failure: `database` (the database answers), `schema` (the applied migrations include every migration of this build) and `config` (required settings and limits are valid). Use it as a readiness probe: a 503 means do not route traffic here. The execution backend is not checked. From the moment the process starts shutting down it answers 503 too.",
    success: {
      status: 200,
      schema: "ReadyResponse",
      description: "Every check passed.",
      example: {
        status: "ready",
        checks: { database: "ok", schema: "ok", config: "ok" },
      },
    },
    errors: [503],
    errorCodes: { 503: ["NOT_READY"] },
  },
  {
    method: "get",
    path: "/v1/openapi.json",
    operationId: "getOpenApiDocument",
    tag: "Health",
    summary: "Generated OpenAPI document",
    description:
      "This document as JSON, the same content as `docs/openapi.json` in the repository.",
    auth: "public",
    success: {
      status: 200,
      schema: "OpenApiDocument",
      description: "The OpenAPI 3.1 document.",
      example: {
        openapi: "3.1.0",
        info: { title: "Werft API", version: OPENAPI_VERSION },
      },
    },
    errors: [],
  },
  {
    method: "get",
    path: "/v1",
    operationId: "getApiRoot",
    tag: "Auth",
    summary: "Check a credential and return its owner",
    description:
      "Checks a credential: answers 200 with the owner it authenticates as, or 401. It changes nothing; use it to test an API key before other calls.",
    scope: "read",
    success: {
      status: 200,
      schema: "ApiRootResponse",
      description: "The credential is valid.",
      example: {
        status: "ok",
        owner_id: "7b0e5c1e-2f4a-4d7e-9a51-3c6f0b8d2e14",
      },
    },
    errors: [401, 503],
  },
  {
    method: "post",
    path: "/v1/auth/bootstrap",
    operationId: "bootstrap",
    tag: "Auth",
    summary:
      "Create the first owner and default workspace, or recover an owner",
    description:
      "Allowed only while no live owner exists (an owner whose account or membership is disabled is not live). On an installation that already has users it adds or restores the owner in the existing workspace, ignores workspace_name and workspace_slug, revokes every web session in the workspace and writes a `recover_owner` receipt. Each BOOTSTRAP_TOKEN works once per installation; a token presented while a live owner exists is spent. A wrong or spent token answers 401 before the owner state is looked at.",
    auth: "public",
    body: "BootstrapRequest",
    requestExample: {
      bootstrap_token: "<the BOOTSTRAP_TOKEN printed at install>",
      email: "owner@example.com",
      password: "correct horse battery staple",
      display_name: "Ada Owner",
      workspace_name: "Acme",
      workspace_slug: "acme",
    },
    success: {
      status: 201,
      schema: "BootstrapResponse",
      description:
        "The owner, the workspace and the membership are created, or the owner is restored in the existing workspace.",
      example: {
        user_id: EXAMPLE_USER_ID,
        workspace: EXAMPLE_WORKSPACE,
        role: "owner",
      },
    },
    errors: [400, 401, 409, 413, 503],
    errorCodes: { 409: ["BOOTSTRAP_DONE"] },
    errorNotes: {
      UNAUTHORIZED:
        "`bootstrap_token` is missing, does not match the installation's token, or was already used; checked first, before the owner state and the rest of the body.",
      BOOTSTRAP_DONE:
        "A live owner exists, checked only after the token matched (the token is then spent); also the answer to the loser of two concurrent bootstraps.",
    },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/auth/login-methods",
    operationId: "listLoginMethods",
    tag: "Auth",
    summary: "How a person can sign in on this installation",
    description:
      "`password` always; `google` when Google sign-in is configured. The login page offers these.",
    auth: "public",
    success: { status: 200, schema: "LoginMethodsResponse" },
    errors: [],
  },
  {
    method: "post",
    path: "/v1/auth/login",
    operationId: "login",
    tag: "Auth",
    summary: "Email/password login; sets the session cookie",
    description:
      "Checks an email and password and starts a browser session: the response sets the `__Host-ap_session` cookie (HttpOnly, Secure, SameSite=Lax) for 14 days, and the expiry slides forward while the session is used. A user keeps at most 10 live sessions; a new login drops the oldest. This is for the web app; scripts and servers use an API key.",
    auth: "public",
    csrf: "always",
    body: "LoginRequest",
    requestExample: {
      email: "owner@example.com",
      password: "correct horse battery staple",
    },
    success: {
      status: 200,
      schema: "LoginResponse",
      description:
        "Signed in; the response sets the session cookie. `scopes` are the ones the workspace role holds.",
      example: {
        user_id: EXAMPLE_USER_ID,
        workspace_id: EXAMPLE_WORKSPACE.id,
        role: "owner",
        scopes: ALL_SCOPES,
        expires_at: "2026-10-25T09:00:00Z",
      },
    },
    errors: [400, 401, 403, 413, 429, 503],
    errorNotes: {
      UNAUTHORIZED:
        "Unknown email, wrong password, or a user with no live workspace membership.",
      RATE_LIMITED:
        "Five failed logins for this email within 15 minutes lock it until the window ends (`Retry-After` is the time left), or too many logins are being checked at once (`Retry-After: 1`).",
    },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/auth/google/start",
    operationId: "startGoogleLogin",
    tag: "Auth",
    summary: "Begin Google sign-in; answers the Google URL to open",
    description:
      "Sets a short-lived cookie that binds the flow (state, nonce, PKCE verifier) to this browser. 404 when Google sign-in is not configured.",
    auth: "public",
    csrf: "always",
    success: { status: 200, schema: "StartGoogleLoginResponse" },
    errors: [403, 404, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/auth/google/callback",
    operationId: "googleLoginCallback",
    tag: "Auth",
    summary: "Finish Google sign-in; sets the session cookie",
    description:
      "Posts the `code` and `state` Google returned to the redirect URI. The first matching rule decides: an already linked Google account signs in as its user; an address that already has an account answers 409 LOGIN_LINK_REQUIRED and is never joined by email; otherwise a live invite for the address, or JIT for an allowed domain, creates the account. Anything else answers 401 without saying whether an account exists. A Google account outside the allowed domains answers 403.",
    auth: "public",
    csrf: "always",
    body: "GoogleLoginCallbackRequest",
    success: { status: 200, schema: "LoginResponse" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["LOGIN_LINK_REQUIRED"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/auth/password-reset",
    operationId: "resetPassword",
    tag: "Auth",
    summary: "Set a new password with a one-time reset link",
    description:
      "Spends the token, sets the password, revokes every live web session of the user and writes a `reset_password` receipt. There is no failure window: the token cannot be guessed, and a shared one would let anyone lock recovery out. Password hashing shares login's concurrency limit, past which it answers 429.",
    auth: "public",
    body: "PasswordResetRequest",
    success: { status: 200, schema: "PasswordResetResponse" },
    errors: [400, 401, 413, 429, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/workspaces/{id}/members/{userId}/password-reset",
    operationId: "issuePasswordReset",
    tag: "Members",
    summary: "Issue a one-time password reset link for a member (owner only)",
    description:
      "Requires the issuer's current password, counted against the issuer's login failure window. An owner cannot issue a link for themselves, nor for a member who owns another workspace. The token is returned once and expires in one hour; issuing another revokes the member's open link. Writes an `issue_password_reset` receipt whose result names the target's role.",
    auth: "session",
    body: "IssuePasswordResetRequest",
    success: { status: 201, schema: "IssuePasswordResetResponse" },
    errors: [400, 401, 403, 404, 413, 429, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/workspaces/{id}/audit-retention",
    operationId: "setAuditRetention",
    tag: "Workspace settings",
    summary: "Set how many days authorization decisions are kept (owner only)",
    description:
      "At least 30 days; the default is 90. Rows older than this are deleted by the reconciler. The current value is `workspace.settings.audit_retention_days` in GET /v1/auth/me.",
    auth: "session",
    body: "AuditRetentionRequest",
    success: { status: 200, schema: "AuditRetentionResponse" },
    errors: [400, 401, 403, 404, 413, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/workspaces/{id}/slack-guest",
    operationId: "setSlackGuest",
    tag: "Workspace settings",
    summary: "Let Slack guests call agents, or stop them (owner or admin)",
    description:
      "Off by default. While off, a Slack guest (`is_restricted`) who calls an agent is refused with `guest_disabled`; while on, a guest still has to link their Slack account. Slack Connect users from other organizations are refused either way. An app with Slack's agent features on is closed to guests by Slack itself. The current value is `workspace.settings.slack_guest_enabled` in GET /v1/auth/me.",
    auth: "session",
    body: "SlackGuestRequest",
    success: { status: 200, schema: "SlackGuestResponse" },
    errors: [400, 401, 403, 404, 413, 503],
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/workspaces/{id}/slack/config-token",
    operationId: "getSlackConfigToken",
    tag: "Workspace settings",
    summary:
      "Whether the Slack App Configuration Token is set (owner or admin)",
    description:
      "Says whether a token is set, its last four characters, when it was last set and by whom, when the current access token expires and which Slack user issued it. `state` is `unset`, `active`, or `needs_reentry` when Slack no longer takes the stored token or a rotation's answer was lost: paste a new one. The token itself is never returned. API keys are refused.",
    auth: "session",
    success: {
      status: 200,
      schema: "SlackConfigTokenSummary",
      description: "The token's state; never its value.",
      example: {
        configured: true,
        last4: "a9f3",
        updated_at: "2026-10-23T09:00:00Z",
        updated_by: { user_id: EXAMPLE_USER_ID, display_name: "Jae" },
        state: "active",
        expires_at: "2026-10-23T21:00:00Z",
        issuer: { user_id: "U0ISSUER", team_id: "T0TEAM" },
      },
    },
    errors: [401, 403, 404, 503],
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY).",
    },
  },
  {
    method: "put",
    path: "/v1/workspaces/{id}/slack/config-token",
    operationId: "putSlackConfigToken",
    tag: "Workspace settings",
    summary:
      "Set or replace the Slack App Configuration Token (owner or admin)",
    description:
      "Paste the refresh token from api.slack.com/apps. It is rotated with Slack at once (`tooling.tokens.rotate`), which proves Slack takes it; the new access and refresh tokens are stored encrypted together and the pasted one is spent. A token Slack refuses changes nothing stored (409 CONFIG_TOKEN_INVALID, `rejected`). When the token belongs to another Slack user than before, `warnings` says so: that user becomes the collaborator of every app made from now on. The response and the `set_slack_secret` receipt carry the last four characters only, and the value is in no log or error. API keys are refused.",
    auth: "session",
    body: "PutSlackSecretRequest",
    requestExample: { value: "<refresh-token-from-api.slack.com>" },
    success: {
      status: 200,
      schema: "PutSlackConfigTokenResponse",
      description:
        "Stored; the summary as GET now answers it, the receipt and any warnings.",
      example: {
        configured: true,
        last4: "a9f3",
        updated_at: "2026-10-23T09:00:00Z",
        updated_by: { user_id: EXAMPLE_USER_ID, display_name: "Jae" },
        state: "active",
        expires_at: "2026-10-23T21:00:00Z",
        issuer: { user_id: "U0ISSUER", team_id: "T0TEAM" },
        receipt_id: EXAMPLE_RECEIPT_ID,
        warnings: [],
      },
    },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["CONFIG_TOKEN_INVALID"] },
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY), or Slack could not be reached; nothing stored changed.",
    },
    idempotent: false,
  },
  {
    method: "delete",
    path: "/v1/workspaces/{id}/slack/config-token",
    operationId: "deleteSlackConfigToken",
    tag: "Workspace settings",
    summary: "Delete the Slack App Configuration Token (owner or admin)",
    description:
      "Deletes the stored token and writes a `delete_slack_secret` receipt with its last four characters. 404 when none is set. API keys are refused.",
    auth: "session",
    success: {
      status: 200,
      schema: "DeleteSlackSecretResponse",
      description: "Deleted; the receipt.",
      example: { receipt_id: EXAMPLE_RECEIPT_ID },
    },
    errors: [401, 403, 404, 503],
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY).",
    },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/workspaces/{id}/github-app",
    operationId: "getGitHubApp",
    tag: "Workspace settings",
    summary:
      "The workspace's GitHub App and where it is installed (owner or admin)",
    description:
      "The App registered in the console (its id, name and page, and when and by whom the private key was last set; never the key), then GitHub's answer for it now, asked with the App's own JWT: its installations, and for each catalog repository written as `auth: { kind: github_app }` the installation that covers it (null when the App is not installed there). `check` is null with no App registered, and `failed` when GitHub did not answer (`github_unreachable`) or refused the App (`github_rejected`: a revoked key or a deleted App). API keys are refused.",
    auth: "session",
    success: {
      status: 200,
      schema: "GetGitHubAppResponse",
      description: "The App and its installations; never the private key.",
      example: {
        github_app: {
          app_id: 123456,
          slug: "acme-agents",
          name: "Acme agents",
          html_url: "https://github.com/apps/acme-agents",
          private_key: {
            updated_at: "2026-10-30T09:00:00Z",
            updated_by: { user_id: EXAMPLE_USER_ID, display_name: "Jae" },
          },
          created_at: "2026-10-30T09:00:00Z",
          updated_at: "2026-10-30T09:00:00Z",
        },
        check: { state: "ok" },
        installations: [
          {
            id: 7654321,
            account: "acme",
            repository_selection: "selected",
            html_url:
              "https://github.com/organizations/acme/settings/installations/7654321",
          },
        ],
        repositories: [
          {
            id: "app",
            url: "https://github.com/acme/app.git",
            installation_id: 7654321,
          },
        ],
      },
    },
    errors: [401, 403, 404, 503],
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY).",
    },
  },
  {
    method: "put",
    path: "/v1/workspaces/{id}/github-app",
    operationId: "putGitHubApp",
    tag: "Workspace settings",
    summary: "Register or replace the workspace's GitHub App (owner or admin)",
    description:
      "Takes the App's id and the private key GitHub issued for it (the PEM file's text). The key must be an RSA private key (400 `invalid_private_key`), and GitHub must accept a JWT signed with it for that id (400 `github_app_rejected`); only then is it stored, encrypted under the master key, with the App's name and page as GitHub reports them. A workspace has one App: this replaces the one before, and repositories written as `auth: { kind: github_app }` use the new one from their next token. Writes a `set_github_app` receipt naming the App id. The key is in no response, receipt, log or error. API keys are refused.",
    auth: "session",
    body: "PutGitHubAppRequest",
    requestExample: {
      app_id: 123456,
      private_key: "<the .pem file GitHub downloaded>",
    },
    success: {
      status: 200,
      schema: "PutGitHubAppResponse",
      description: "Stored; the App as GET now answers it, and the receipt.",
      example: {
        github_app: {
          app_id: 123456,
          slug: "acme-agents",
          name: "Acme agents",
          html_url: "https://github.com/apps/acme-agents",
          private_key: {
            updated_at: "2026-10-30T09:00:00Z",
            updated_by: { user_id: EXAMPLE_USER_ID, display_name: "Jae" },
          },
          created_at: "2026-10-30T09:00:00Z",
          updated_at: "2026-10-30T09:00:00Z",
        },
        receipt_id: EXAMPLE_RECEIPT_ID,
      },
    },
    errors: [400, 401, 403, 404, 413, 503],
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY), or GitHub could not be reached (`github_unreachable`); nothing stored changed.",
    },
    idempotent: false,
  },
  {
    method: "delete",
    path: "/v1/workspaces/{id}/github-app",
    operationId: "deleteGitHubApp",
    tag: "Workspace settings",
    summary: "Remove the workspace's GitHub App (owner or admin)",
    description:
      "Deletes the App and its private key and writes a `delete_github_app` receipt. Repositories written as `auth: { kind: github_app }` can no longer be cloned, pushed to or get pull requests until an App is registered again. The App stays on GitHub. 404 when none is registered. API keys are refused.",
    auth: "session",
    success: {
      status: 200,
      schema: "DeleteGitHubAppResponse",
      description: "Deleted; the receipt.",
      example: { receipt_id: EXAMPLE_RECEIPT_ID },
    },
    errors: [401, 403, 404, 503],
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY).",
    },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/workspaces/{id}/github-settings",
    operationId: "getGitHubSettings",
    tag: "Workspace settings",
    summary: "The workspace's GitHub ceiling (members)",
    description:
      "What the workspace lets its agents turn on beyond writing a pull request: `workflows`, `actions`, `checks`, `issues`, `review`, all false until an owner or admin saves the ceiling (`revision` 0 until then). An agent's release may turn a feature on only under the ceiling, and every GitHub token is cut to the ceiling again when it is issued. `agents_using` counts, per feature, agents with GitHub on whose active release turns it on; sessions still running an earlier release are not counted. `apps` has each registered App's permissions as last read from GitHub. Any member signed in to the console reads it; API keys are refused.",
    auth: "session",
    success: {
      status: 200,
      schema: "GitHubSettingsResponse",
      description: "The ceiling and who uses it.",
      example: {
        ceiling: {
          workflows: false,
          actions: true,
          checks: false,
          issues: false,
          review: false,
        },
        revision: 3,
        agents_using: {
          workflows: 0,
          actions: 2,
          checks: 0,
          issues: 0,
          review: 0,
        },
        apps: {
          author: {
            permissions: {
              contents: "write",
              pull_requests: "write",
              actions: "write",
              metadata: "read",
            },
          },
          reviewer: null,
        },
      },
    },
    errors: [401, 403, 404, 503],
  },
  {
    method: "put",
    path: "/v1/workspaces/{id}/github-settings",
    operationId: "putGitHubSettings",
    tag: "Workspace settings",
    summary: "Change the workspace's GitHub ceiling (owner or admin)",
    description:
      "Replaces the ceiling. `revision` is the one last read; a stale one is 409 `REVISION_CONFLICT` and nothing changes. Lowering a feature refuses it from the next GitHub token on (409 `GITHUB_REFUSED` `over_workspace_ceiling`), for sessions of every release that turns it on; raising it lets the same releases use it again. Writes a `set_github_ceiling` receipt with the ceiling before and after. API keys are refused.",
    auth: "session",
    body: "PutGitHubSettingsRequest",
    requestExample: {
      ceiling: {
        workflows: false,
        actions: true,
        checks: false,
        issues: false,
        review: false,
      },
      revision: 2,
    },
    success: {
      status: 200,
      schema: "GitHubSettingsResponse",
      description: "Stored; the settings as GET now answers them.",
      example: {
        ceiling: {
          workflows: false,
          actions: true,
          checks: false,
          issues: false,
          review: false,
        },
        revision: 3,
        agents_using: {
          workflows: 0,
          actions: 2,
          checks: 0,
          issues: 0,
          review: 0,
        },
        apps: { author: { permissions: null }, reviewer: null },
      },
    },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "delete",
    path: "/v1/workspaces/{id}/slack/apps/{app_id}",
    operationId: "deleteSlackApp",
    tag: "Workspace settings",
    summary: "Delete one of the workspace's Slack apps in Slack",
    description:
      "Deletes the app in Slack (`apps.manifest.delete` with the config token) and its stored secrets; the row stays as `deleted`. Only an app recorded in this workspace's Slack apps can be named. An agent's app takes an owner, an admin or that agent's admin; any other app an owner or admin. An app Slack no longer has counts as deleted. One still being created answers 409 SLACK_APP_CREATING. API keys are refused.",
    auth: "session",
    success: {
      status: 200,
      schema: "DeleteSlackAppResponse",
      description:
        "Deleted in Slack, or already gone there; the app as now stored, its secrets dropped.",
      example: {
        slack_app: {
          ...EXAMPLE_SLACK_APP,
          state: "deleted",
          secrets: {
            slack_signing_secret: {
              configured: false,
              last4: null,
              updated_at: null,
              updated_by: null,
            },
            slack_client_secret: {
              configured: false,
              last4: null,
              updated_at: null,
              updated_by: null,
            },
            slack_bot_token: {
              configured: false,
              last4: null,
              updated_at: null,
              updated_by: null,
            },
          },
        },
      },
    },
    errors: [401, 403, 404, 409, 503],
    errorCodes: { 409: ["CONFIG_TOKEN_INVALID", "SLACK_APP_CREATING"] },
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY), or Slack could not be reached or refused; the app stays `deleting` and the same request retries it.",
    },
    idempotent: false,
  },
  {
    method: "put",
    path: "/v1/workspaces/{id}/slack/apps/{app_id}/secrets/{purpose}",
    operationId: "putSlackAppSecret",
    tag: "Workspace settings",
    summary: "Set a secret of a Slack app made by hand (owner or admin)",
    description:
      "`purpose` is `slack_signing_secret`, `slack_client_secret` or `slack_bot_token`. Only an app of kind `manual` takes values from a person: the platform writes the secrets of the apps it created (403 `server_managed_secret`), since whoever knew an app's signing secret could sign events as Slack. The value is stored encrypted under the app; the response and the `set_slack_secret` receipt carry its last four characters only. API keys are refused.",
    auth: "session",
    body: "PutSlackSecretRequest",
    requestExample: { value: "<value-from-api.slack.com>" },
    success: {
      status: 200,
      schema: "PutSlackSecretResponse",
      description: "Stored; its summary and the receipt.",
      example: {
        configured: true,
        last4: "a9f3",
        updated_at: "2026-10-23T09:00:00Z",
        updated_by: { user_id: EXAMPLE_USER_ID, display_name: "Jae" },
        receipt_id: EXAMPLE_RECEIPT_ID,
      },
    },
    errors: [400, 401, 403, 404, 413, 503],
    errorNotes: {
      BAD_REQUEST:
        "Also when `app_id` is not a UUID or `purpose` is not one of the three, `slack_config_token` included.",
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY).",
    },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/auth/logout",
    operationId: "logout",
    tag: "Auth",
    summary: "Revoke the session cookie",
    description:
      "Revokes the cookie session that sent the request and clears the cookie. The user's other sessions stay signed in.",
    auth: "session",
    success: {
      status: 204,
      description: "The session is revoked and the cookie cleared.",
    },
    errors: [401, 403, 503],
    errorNotes: {
      FORBIDDEN: "Also when the caller is not a cookie session (an API key).",
    },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/auth/me",
    operationId: "getAuthMe",
    tag: "Auth",
    summary: "The authenticated principal, user and workspace",
    description:
      "Says who the credential authenticates as and what it may do: the principal with its scopes, the workspace, and for a cookie session the user and the management actions its role holds (`permissions`). An API key has no user, so `user` is null and `permissions` is empty; `workspace` is the key's workspace, or null for a legacy key that predates workspaces. The web app boots from this. It changes nothing.",
    scope: "read",
    success: {
      status: 200,
      schema: "AuthMeResponse",
      description: "The authenticated principal; `scopes` is what it may do.",
      example: {
        principal: {
          kind: "user",
          id: EXAMPLE_USER_ID,
          workspace_id: EXAMPLE_WORKSPACE.id,
          role: "owner",
          scopes: ALL_SCOPES,
        },
        user: {
          id: EXAMPLE_USER_ID,
          email: "owner@example.com",
          display_name: "Ada Owner",
          locale: "ko",
        },
        workspace: EXAMPLE_WORKSPACE,
        scopes: ALL_SCOPES,
        permissions: [
          "workspace.manage",
          "audit_retention.manage",
          "member.manage",
          "team.manage",
          "api_key.manage",
          "api_key.manage_own",
          "account.link",
          "agent.create",
          "agent.manage",
          "agent.restore",
          "agent.admin.manage",
          "credential.bind",
          "binding.manage",
          "session.audit_read",
          "session.admin_list",
          "usage.installation_read",
          "usage.agent_read",
          "profile.installation.manage",
        ],
      },
    },
    errors: [401, 503],
    errorNotes: {
      UNAUTHORIZED: "Also when the session's workspace no longer exists.",
    },
  },
  {
    method: "patch",
    path: "/v1/auth/me",
    operationId: "updateAuthMe",
    tag: "Auth",
    summary: "Save the signed-in user's language",
    description:
      "Saves `locale` (`ko`, `ja` or `en`) on the signed-in user: what `user.locale` in GET /v1/auth/me returns and the language the user's Slack notices are written in. Slack's ephemeral notices follow the reader's language; a thread's replies and notices follow the language of whoever started the session. A user who never saved one reads Korean.",
    auth: "session",
    body: "UpdateAuthMeRequest",
    requestExample: { locale: "en" },
    success: { status: 204, description: "The language is saved." },
    errors: [400, 401, 403, 413, 503],
    errorNotes: {
      FORBIDDEN: "Also when the caller is not a cookie session (an API key).",
    },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/sessions",
    operationId: "createSession",
    tag: "Sessions",
    summary: "Durably accept a session and its first input",
    description:
      "Creates a session for a catalog profile and repository and queues `message` as turn `1`. Whether `repository_id` is sent follows the profile's `repository_mode` (`GET /v1/profiles`): `required` needs it, `none` refuses it, `optional` takes either; a session created without one starts in an empty workspace, has no repository to push to (`POST /v1/sessions/{id}/push-requests` answers 409 PUSH_SOURCE_MISSING) and its detail's `repository_id` is null. The 201 means the input is stored, not that it ran: follow the turn with `GET /v1/sessions/{id}/turns/{turn_id}` or the event stream. `model` picks one of the models the profile offers (its `model` or `models` in the catalog); omitted, the model of the release's card runs when `agent_release_id` is sent, else the profile's default. The session's detail reports it as `model`. The model stays until the session's profile is changed (`POST /v1/sessions/{id}/profile`), which runs the new profile's default. A session waits in `queued` while no execution slot is free; it is never refused for that. `agent_release_id` pins the session to that release of an agent, so a key bound to the agent may create it (it reads the agent's `active_release_id` from `GET /v1/agents`);`profile_id` may then be omitted for the release's runtime profile, and sent it must be that profile (409 RELEASE_PROFILE_MISMATCH). Omitted, `repository_id` is the release's `repository_id`. A release whose profile is no longer in the catalog, or changed since, answers 409 PROFILE_DIGEST_MISMATCH. A profile the operator blocked, or a workspace profile over a blocked one, answers 409 PROFILE_BLOCKED, with a release or without. Every credential the release names must still be bound to its agent; otherwise 409 CREDENTIAL_UNBOUND, whose `details` carry the guidance to show the requester and the agent's admins to ask (`SessionCredentialUnboundDetails`), never the missing names. The receipt settles with turn `1`: `succeeded` when it completes, `failed` when it fails or is interrupted or cancelled, `unknown` when its outcome is unknown.",
    scope: "write",
    body: "CreateSessionRequest",
    requestExample: {
      profile_id: "claude-coding-real",
      repository_id: "sample-app",
      message: "Add a health check endpoint and a test for it.",
    },
    success: {
      status: 201,
      schema: "CreateSessionResponse",
      description:
        "The session and its first turn are stored; `receipt_id` tracks the acceptance.",
      example: {
        session_id: EXAMPLE_SESSION_ID,
        turn_id: "1",
        receipt_id: EXAMPLE_RECEIPT_ID,
        receipt_status: "accepted",
        status: "queued",
      },
    },
    errors: [400, 401, 404, 409, 413, 422, 429, 503],
    errorCodes: {
      400: ["BAD_REQUEST", "PERMISSION_WAIT_ABOVE_PROFILE"],
      409: [
        "IDEMPOTENCY_CONFLICT",
        "RELEASE_PROFILE_MISMATCH",
        "PROFILE_DIGEST_MISMATCH",
        "PROFILE_BLOCKED",
        "CREDENTIAL_UNBOUND",
      ],
      413: ["PAYLOAD_TOO_LARGE", "STORAGE_LIMIT_EXCEEDED"],
    },
    errorNotes: {
      BAD_REQUEST:
        "A body its schema refuses, `profile_id` missing without `agent_release_id` included, names each field at fault in `details.issues` (`RequestBodyInvalidDetails`).",
      PERMISSION_WAIT_ABOVE_PROFILE:
        "A `permission_wait` value is longer than the profile's (`GET /v1/profiles`).",
      UNSUPPORTED_CAPABILITY:
        "`profile_id` or `repository_id` is not in the catalog, the catalog does not allow the pair, the profile does not offer `model`, `repository_id` is missing for a profile whose `repository_mode` is `required` (`Profile <id> needs a repository: send repository_id`), or sent for one whose `repository_mode` is `none` (`Profile <id> runs without a repository: omit repository_id`).",
      RATE_LIMITED:
        "Reserved here: the per-session input queue limit applies to later messages, not to the first, so this operation does not currently return it.",
    },
  },
  {
    method: "get",
    path: "/v1/sessions",
    operationId: "listSessions",
    tag: "Sessions",
    summary: "List the owner's sessions, newest first",
    description:
      "Lists the sessions of the credential's owner that the caller can read, newest `created_at` first, closed ones included, `limit` per page (default 50, at most 100). Pass `next_cursor` back as `cursor` for the next page; it is null on the last one. `status` keeps only sessions reporting that status, `needs_input` included; `relation` keeps the ones the caller started, was shared or administers the agent of; `q` searches titles and id prefixes; `agent_id` keeps the sessions of one agent, any of its releases. Every filter only narrows what the caller can read. It changes nothing.",
    scope: "read",
    query: "ListSessionsQuery",
    success: {
      status: 200,
      schema: "ListSessionsResponse",
      description: "One page of session summaries.",
      example: {
        items: [EXAMPLE_SESSION_SUMMARY],
        next_cursor: null,
      },
    },
    errors: [400, 401, 503],
  },
  {
    method: "get",
    path: "/v1/sessions/counts",
    operationId: "countSessions",
    tag: "Sessions",
    summary: "Count the sessions a list would return, per status",
    description:
      "Counts, for each status, the sessions `GET /v1/sessions` would list with that `status` and the same `relation` and `q` when read to its last page; `total` is their sum. A session the caller cannot read is never counted. It changes nothing.",
    scope: "read",
    query: "CountSessionsQuery",
    success: {
      status: 200,
      schema: "CountSessionsResponse",
      description: "The number of sessions per status.",
      example: {
        counts: {
          queued: 0,
          running: 2,
          needs_input: 1,
          idle: 5,
          failed: 1,
          stopped: 3,
        },
        total: 12,
      },
    },
    errors: [400, 401, 503],
  },
  {
    method: "get",
    path: "/v1/sessions/{id}",
    operationId: "getSession",
    tag: "Sessions",
    summary: "Session detail with projection, execution and durability",
    description:
      "Reads one session: its `admission_state` (whether it takes input and controls: `active`, `pausing`, `paused`, `resuming`, `stopping`, `stopped`, `recovery_required`, `closing`, `closed`), its `status`, the current `revision`, the execution as last observed, the number of pending requests, `attention` (why the session is held or slowed, if it is) and checkpoint `durability`. Read `revision` here and send it as `expected_revision` to pause, resume, close, terminate or decide recovery. `status: needs_input` and `attention` are computed on each read; reading changes nothing.",
    scope: "read",
    success: {
      status: 200,
      schema: "SessionDetail",
      description: "The session as it stands now.",
      example: EXAMPLE_SESSION_DETAIL,
    },
    errors: [401, 404, 503],
  },
  {
    method: "patch",
    path: "/v1/sessions/{id}",
    operationId: "updateSession",
    tag: "Sessions",
    summary: "Rename the session",
    description:
      "Sets `title`, in any admission state; the session's `revision` does not change and no receipt is written. Allowed to the session's creator (for a session an API key made, that key), the workspace's owners and admins, and the admins of its agent; since the answer is the session's detail, a key also needs `sessions:read`. Anyone else the session is visible to, through its share, gets 403; anyone it is not visible to, 404. A changed title is a `status` event on the stream carrying `title`; naming the title the session already has writes none. Answers with the session as `GET /v1/sessions/{id}` reads it.",
    scope: "write",
    body: "UpdateSessionRequest",
    requestExample: { title: "Fix the flaky checkout test" },
    success: {
      status: 200,
      schema: "SessionDetail",
      description: "The session with its new title.",
      example: EXAMPLE_SESSION_DETAIL,
    },
    errors: [400, 401, 403, 404, 413, 503],
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/share",
    operationId: "getSessionShare",
    tag: "Sessions",
    summary: "Who sees the session",
    description:
      "Readable by whoever sees the session. A session never re-shared reads `workspace` at revision 0.",
    scope: "read",
    success: { status: 200, schema: "SessionShare" },
    errors: [401, 404, 503],
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/share",
    operationId: "setSessionShare",
    tag: "Sessions",
    summary: "Change who sees the session",
    description:
      "`private` is the creator alone; `people` and `team` add the people or the current members of the teams named; `workspace` is every member. A person's session is changed only by its creator; a session an API key made, by owners, admins and the admins of its agent. Anyone else the session is visible to gets 403; anyone it is not visible to, 404. Open event streams that may no longer see the session end. Writes a `share_session` receipt unless the share was already as asked (`receipt_id` null).",
    auth: "session",
    body: "SetSessionShareRequest",
    success: { status: 200, schema: "SetSessionShareResponse" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/audit-read",
    operationId: "auditReadSession",
    tag: "Admin",
    summary: "Read a session outside its share, with a reason",
    description:
      "Owners and admins. The session detail and a page of its turns, whatever the share; nothing on the session changes and no other action is opened by it. Every read is recorded with its `justification`.",
    auth: "session",
    body: "AuditReadRequest",
    success: { status: 200, schema: "AuditReadResponse" },
    errors: [400, 401, 403, 404, 413, 503],
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/admin/sessions",
    operationId: "listAdminSessions",
    tag: "Admin",
    summary: "Every session of the workspace, metadata only",
    description:
      "Owners and admins. Who made each session, its agent release, state and share scope, newest first; no content, title or summary.",
    auth: "session",
    success: { status: 200, schema: "ListAdminSessionsResponse" },
    errors: [401, 403, 503],
  },
  {
    method: "post",
    path: "/v1/admin/sessions/{id}/terminate",
    operationId: "adminTerminateSession",
    tag: "Admin",
    summary: "Stop any session of the workspace, with a reason",
    description:
      "Owners and admins, whatever the session's share. The `justification` is recorded with the decision and becomes the stop reason. Otherwise as `POST /v1/sessions/{id}/terminate`.",
    auth: "session",
    body: "AdminTerminateSessionRequest",
    success: { status: 202, schema: "TerminateSessionResponse" },
    errors: [...CONFLICTS, 403, 413, 422, 503],
    errorCodes: {
      409: [
        "IDEMPOTENCY_CONFLICT",
        "REVISION_CONFLICT",
        "SESSION_PAUSED",
        "SESSION_RESUMING",
        "SESSION_STOPPED",
        "RECOVERY_REQUIRED",
        "SESSION_CLOSED",
      ],
    },
  },
  {
    method: "post",
    path: "/v1/admin/sessions/{id}/recovery-decisions",
    operationId: "adminDecideSessionRecovery",
    tag: "Admin",
    summary: "Decide recovery for any session of the workspace",
    description:
      "Owners only, whatever the session's share. The decision's `reason` is the justification, recorded with the decision. Otherwise as `POST /v1/sessions/{id}/recovery-decisions`.",
    auth: "session",
    body: "RecoveryDecisionRequest",
    success: { status: 202, schema: "ReceiptAcceptedResponse" },
    errors: [...CONFLICTS, 403, 413, 422, 503],
    errorCodes: {
      409: [
        "IDEMPOTENCY_CONFLICT",
        "REVISION_CONFLICT",
        "REQUEST_STALE",
        "SESSION_PAUSED",
        "SESSION_RESUMING",
        "SESSION_STOPPED",
        "RECOVERY_REQUIRED",
        "SESSION_CLOSED",
        "CHECKPOINT_UNAVAILABLE",
      ],
    },
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/usage",
    operationId: "getSessionUsage",
    tag: "Sessions",
    summary: "Estimated cost of a session and whether every turn reported it",
    description:
      "Reads the session's estimated provider cost and token count over its lifetime, its cost and token limits, and its queued input against the per-session limit. The cost is the platform's estimate from the model calls it saw, not a bill. `cost.complete: false` means a turn is still open or ended without reporting, so the true total is unknown; do not read it as zero. `budget_exceeded: true` means either limit is reached: no new turn is dispatched, but input is still accepted and queued. It changes nothing.",
    scope: "read",
    success: {
      status: 200,
      schema: "SessionUsageResponse",
      description: "The session's usage as of `refreshed_at`.",
      example: {
        session_id: EXAMPLE_SESSION_ID,
        period: "session_lifetime",
        refreshed_at: "2026-10-11T08:15:43Z",
        cost: {
          amount_usd: "0.4231",
          kind: "estimated",
          source: "provider_usage",
          completeness_scope: "turn_reports",
          complete: false,
          reported_turn_count: 2,
          unreported_turn_count: 0,
          open_turn_count: 1,
        },
        cost_limit_usd: "20",
        token_count: 182450,
        token_limit: null,
        budget_exceeded: false,
        queued_input_count: 1,
        queued_input_limit: 20,
      },
    },
    errors: [401, 404, 503],
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/outputs",
    operationId: "listSessionOutputs",
    tag: "Sessions",
    summary: "Files the session left under out/ at its latest checkpoint",
    description:
      "Lists the files under the workspace's `out/` directory as the session's latest committed checkpoint recorded them: `path` (relative to the workspace, starting with `out/`), `bytes` and `sha256`. A file over the output limits is listed with `omitted: too_large` and `sha256: null`; its bytes were not kept, so it cannot be downloaded. A file written after the latest checkpoint is not listed until the next one commits. A session with no committed checkpoint answers an empty list with `checkpoint_revision: null`. Download a listed file with `GET /v1/sessions/{id}/outputs/{path}`. Reading changes nothing.",
    scope: "read",
    success: {
      status: 200,
      schema: "ListSessionOutputsResponse",
      description: "The outputs of the session's latest committed checkpoint.",
      example: {
        session_id: EXAMPLE_SESSION_ID,
        checkpoint_revision: 2,
        items: [
          {
            path: "out/report.md",
            bytes: 2048,
            sha256:
              "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
            omitted: null,
          },
          {
            path: "out/recording.mp4",
            bytes: 734003200,
            sha256: null,
            omitted: "too_large",
          },
        ],
      },
    },
    errors: [401, 404, 409, 503],
    errorCodes: { 409: ["CHECKPOINT_UNAVAILABLE"] },
    errorNotes: {
      CHECKPOINT_UNAVAILABLE:
        "The latest checkpoint's manifest is missing, damaged or unreadable; `message` names it.",
    },
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/outputs/{path}",
    operationId: "downloadSessionOutput",
    tag: "Sessions",
    summary: "Download one file the session left under out/",
    description:
      "Streams one file that `GET /v1/sessions/{id}/outputs` lists, as `application/octet-stream` with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`. `{path}` is the listed `path` exactly, percent-encoded as one path segment (`out/report.md` is `out%2Freport.md`). The bytes are the ones the checkpoint verified; if the store no longer holds them the transfer ends early with an error rather than completing with other bytes, so check the length (or `sha256`) of what arrived. A path the list does not name, a file listed with `omitted`, or a session with no committed checkpoint answers 404.",
    scope: "read",
    success: {
      status: 200,
      download: true,
      description: "The file's bytes.",
    },
    errors: [401, 404, 409, 503],
    errorCodes: { 409: ["CHECKPOINT_UNAVAILABLE"] },
    errorNotes: {
      NOT_FOUND:
        "Also when the path is not listed, is listed as `omitted`, or the session has no committed checkpoint.",
      CHECKPOINT_UNAVAILABLE:
        "The latest checkpoint's manifest or this file's stored object is missing, damaged or unreadable; `message` names it.",
    },
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/messages",
    operationId: "appendSessionMessage",
    tag: "Messages & turns",
    summary: "Enqueue the next input after the current turn",
    description:
      "Queues `message` as the session's next turn in the same engine conversation, after every turn already queued. Only an `active` session takes input; the other admission states answer the 409 codes below. The 202 means the input is stored under a new sequential `turn_id`, not that it ran: follow the turn with `GET /v1/sessions/{id}/turns/{turn_id}` or on the event stream. A session over its budget still queues input but runs no new turn (`attention.code: BUDGET_EXCEEDED`). The receipt settles with the turn: `succeeded` when it completes, `failed` when it fails or is interrupted or cancelled, `unknown` when its outcome is unknown.",
    scope: "write",
    body: "PostSessionMessageRequest",
    requestExample: { message: "Now add the endpoint to the README." },
    success: {
      status: 202,
      schema: "PostSessionMessageResponse",
      description: "The input is stored as a queued turn.",
      example: {
        turn_id: "4",
        receipt_id: EXAMPLE_RECEIPT_ID,
        receipt_status: "accepted",
      },
    },
    errors: [400, 401, 404, 409, 413, 429, 503],
    errorCodes: {
      409: [
        "IDEMPOTENCY_CONFLICT",
        "SESSION_PAUSED",
        "SESSION_RESUMING",
        "SESSION_STOPPED",
        "RECOVERY_REQUIRED",
        "SESSION_CLOSING",
        "SESSION_CLOSED",
        "CHECKPOINT_UNAVAILABLE",
        "TAKEOVER_REQUIRED",
        "PROFILE_BLOCKED",
      ],
      413: ["PAYLOAD_TOO_LARGE", "STORAGE_LIMIT_EXCEEDED"],
    },
    errorNotes: {
      RATE_LIMITED:
        "The session already holds the installation's maximum of queued inputs; `Retry-After` is 5.",
      PROFILE_BLOCKED:
        "The operator blocked the session's profile, or the installation profile its workspace profile narrows; nothing is queued. The session's `attention` says the same, and it takes messages again once the operator unblocks it.",
      CHECKPOINT_UNAVAILABLE:
        "A pending checkpoint problem holds new work, so a new turn could not be checkpointed; `message` names it.",
    },
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/turns",
    operationId: "listSessionTurns",
    tag: "Messages & turns",
    summary: "Queued and finished turns",
    description:
      "Lists the session's turns oldest first, in `turn_id` order: queued, running and finished, `limit` per page (default 50, at most 100). Pass `next_cursor` back as `cursor` for the next page; it is null on the last one. Items are summaries; read one turn for its result, usage and attempts. It changes nothing.",
    scope: "read",
    query: "ListTurnsQuery",
    success: {
      status: 200,
      schema: "ListTurnsResponse",
      description: "One page of turn summaries.",
      example: {
        items: [
          EXAMPLE_TURN_SUMMARY,
          {
            ...EXAMPLE_TURN_SUMMARY,
            turn_id: "2",
            status: "running",
            message: "Now add the endpoint to the README.",
            checkpoint_revision: null,
            created_at: "2026-10-11T08:14:00Z",
            started_at: "2026-10-11T08:14:02Z",
            ended_at: null,
          },
        ],
        next_cursor: null,
      },
    },
    errors: [400, 401, 404, 503],
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/turns/{turn_id}",
    operationId: "getSessionTurn",
    tag: "Messages & turns",
    summary: "Committed result of one turn",
    description:
      "Reads one turn: its status, terminal reason, the engine's committed `result` and `usage`, and the worker attempts that ran it. This is the durable answer to whether a turn finished: `completed`, `failed`, `interrupted`, `cancelled` and `outcome_unknown` are terminal. `completed` means the engine ended the turn normally, not that the requested work is done. `result` and `usage` are null until the turn ends, and their shape is the runtime's. It changes nothing.",
    scope: "read",
    success: {
      status: 200,
      schema: "TurnDetail",
      description: "The turn as it stands now.",
      example: {
        ...EXAMPLE_TURN_SUMMARY,
        result: {
          type: "result",
          subtype: "success",
          result: "Added GET /health and a test for it.",
        },
        usage: { input_tokens: 48210, output_tokens: 3120 },
        attempts: [
          {
            attempt_id: "att_01",
            state: "exited",
            lease_epoch: 1,
            execution_generation: 1,
            started_at: "2026-10-11T08:00:05Z",
            ended_at: "2026-10-11T08:03:12Z",
            profile_id: "claude-coding-real",
          },
        ],
      },
    },
    errors: [401, 404, 503],
    errorNotes: {
      NOT_FOUND: "Also when `turn_id` names no turn of the session.",
    },
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/events",
    operationId: "streamSessionEvents",
    tag: "Events",
    summary: "Durable event replay and live stream (SSE)",
    description:
      "Streams the session's events as Server-Sent Events: first the stored events after `Last-Event-ID` (all of them without it), then new ones as they are written. Each frame's `id` is its cursor, `event` its kind (`system`, `assistant`, `tool_use`, `tool_result`, `question`, `result`, `status`, `error`), and `data` a versioned envelope naming the session, turn and attempt. Frames arrive in `id` order, the order to rely on; a new event's `occurred_at` is no earlier than the one before it. An event the engine emits after its turn's terminal belongs to no turn (`turn_id` null). `question` events announce pending requests; `status` events report the session's status and, after a pause, resume, terminate or recovery decision, its `admission_state`. `system` events with a platform `subtype` are the control plane's own: `session_closed` when a close commits, and `input_wait` with `stage` (`parked` when a turn parks on its unanswered requests, `expired` when a parked turn's requests expire, `lost` when the worker holding them went away unanswered) and the `request_ids` it covers. The stream does not end with a turn or the session: it stays open until the client disconnects, the credential is revoked, or the session's share stops covering the caller (the reconnect then answers 404). Reading changes nothing.\n\nReconnect after backoff with the last complete event id in `Last-Event-ID`; replay resumes strictly after that event. The stream sends a comment keepalive every 15 seconds. `410 CURSOR_EXPIRED` means the cursor fell outside retained history and the client must resynchronize from resource state; alpha does not trim events, so this response is reserved. A `result` event is engine output, not durable completion: confirm the turn with `GET /v1/sessions/{id}/turns/{turn_id}` and treat only `completed`, `failed`, `interrupted`, `cancelled`, or `outcome_unknown` as terminal.",
    scope: "read",
    lastEventId: true,
    success: {
      status: 200,
      schema: "SseEvent",
      sse: true,
      description:
        "`text/event-stream`: one frame per event, each an `id:`, an `event:` and a `data:` line, with the envelope as JSON on the `data:` line.",
      example: {
        id: "ev_2s",
        event: "status",
        data: {
          schema_version: 1,
          session_id: EXAMPLE_SESSION_ID,
          turn_id: "2",
          attempt_id: "att_01",
          occurred_at: "2026-10-11T08:14:02Z",
          data: { phase: "running" },
        },
      },
    },
    // 410 CURSOR_EXPIRED is declared for clients but never produced in alpha:
    // events are not trimmed (api.md § 이벤트).
    errors: [400, 401, 404, 410, 429, 503],
    errorNotes: {
      RATE_LIMITED:
        "This owner already has 8 open streams, or the process 256; `Retry-After` is 15.",
    },
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/pending-requests",
    operationId: "listPendingRequests",
    tag: "Pending requests",
    summary: "Open permission and question requests",
    description:
      "Lists the permission and question requests the session waits on that a client can still answer, oldest first: open, unexpired, and either raised by the worker attempt that holds the running turn (`state: waiting`) or parked (`state: parked`). A request nobody answers by `park_at` has its turn parked: the platform stops the turn with its checkpoint and pauses the session, and the request stays answerable until `expires_at` whatever happened to the worker that asked. Requests of one `group` resume their turn together. A `permission` item names the `tool` and its `input`; a `question` item carries the questions and their option ids. Answer before `expires_at` with `POST /v1/sessions/{id}/answers`. New requests also arrive as `question` events on the event stream. It changes nothing.",
    scope: "read",
    success: {
      status: 200,
      schema: "ListPendingRequestsResponse",
      description: "Every request that can be answered now; empty when none.",
      example: {
        items: [
          {
            request_id: "req_7f3a",
            turn_id: "2",
            attempt_id: "att_01",
            created_at: "2026-10-11T08:14:30Z",
            expires_at: "2026-10-12T08:14:30Z",
            state: "waiting",
            park_at: "2026-10-11T08:44:30Z",
            group: "2",
            kind: "permission",
            tool: "Bash",
            input: { command: "npm test", description: "Run the tests" },
          },
        ],
        answerable: true,
      },
    },
    errors: [401, 404, 503],
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/answers",
    operationId: "answerPendingRequest",
    tag: "Pending requests",
    summary: "Answer a pending permission or question request",
    description:
      "Answers one pending request by `request_id`: a permission with `allow` or `deny` (a denial needs a `reason` the model can act on), a question with one answer per question, by option ids or free text where the question allows it. The answer is stored and the request closes at once: the pending list drops it and a `status` event ends the wait. The worker then hands the answer to the engine, and the receipt settles when it reports: `succeeded` once delivered, `failed` if the request expired (`REQUEST_EXPIRED`) or was cancelled (`REQUEST_STALE`, with why in its message: an interrupt, a park, a shutdown, the worker refusing the answer, or the engine having closed the request already) first, `unknown` if the execution ended before it reported or the engine no longer knew the request, so it may or may not have acted on the answer.\n\nA parked request (`state: parked`) is answered the same way, whichever worker asked. The answer is kept until every request of its `group` is answered or expired; the one that closes the group resumes the session (`resumed: true`), and the receipt settles once the turn that resumes it has the answer. `waiting_for` counts the group's requests still open. A session paused by a person rather than by its park keeps the answer and stays paused.\n\nSeeing a session is not answering for it: only its creator (for a session an API key made, that key), its agent's admins and the workspace's owners and admins answer. Anyone else the session is visible to gets 403 (`reason_code: role`) and the request stays open; anyone it is not visible to, 404.",
    scope: "approve",
    body: "PostSessionAnswerRequest",
    requestExample: {
      request_id: "req_7f3a",
      kind: "permission",
      decision: "allow",
    },
    success: {
      status: 202,
      schema: "PostSessionAnswerResponse",
      description:
        "The answer is stored; the receipt tracks its delivery, and `approval` records who answered and the decision that let them.",
      example: {
        ...ACCEPTED_RECEIPT,
        approval: {
          answered_by: {
            principal: { kind: "user", id: EXAMPLE_USER_ID },
            actor_user_id: EXAMPLE_USER_ID,
            agent_id: null,
          },
          surface: "web",
          decision_id: "5b9e2d7a-1c4f-4a83-b6e0-8d3f7a2c1e94",
        },
      },
    },
    errors: [...CONFLICTS, 413, 503],
    errorCodes: {
      409: [
        "IDEMPOTENCY_CONFLICT",
        "REQUEST_EXPIRED",
        "REQUEST_STALE",
        "RECOVERY_REQUIRED",
        "CHECKPOINT_UNAVAILABLE",
      ],
    },
    errorNotes: {
      RECOVERY_REQUIRED:
        "A parked request whose session has a turn with an unknown outcome: the answer is not kept, since the turn could not resume.",
      CHECKPOINT_UNAVAILABLE:
        "A parked request whose session has no checkpoint to resume from: the answer is not kept.",
      BAD_REQUEST:
        "Also when the answer does not fit the pending request (its kind, question or option ids); `message` says how.",
      NOT_FOUND: "Also when `request_id` names no request of the session.",
      REQUEST_STALE:
        "The attempt that asked is no longer the session's live attempt: it ended, lost its lease, or the turn moved on. A parked request can be answered whatever happened to the attempt that asked.",
    },
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/push-requests",
    operationId: "createPushRequest",
    tag: "Push requests",
    summary: "Ask for the session's latest checkpoint to be pushed",
    description:
      "Pins the session's latest committed checkpoint: its `checkpoint_revision`, the `git_commit` its verified manifest names, the session's `repository_id`, and the target branch `agent/<session-id>`. None of these can be chosen: the body is `{}`. The request starts `requested` and nothing is pushed until a holder of `sessions:approve` approves it (`POST .../push-requests/{push_request_id}/decision`); the push itself is the platform's, never the worker's.\n\nA session has at most one open request (`requested`, `approved` or `pushing`). Every attempt, refused ones included, leaves a `request_push` receipt; a refusal's `error.details.receipt_id` names it. A replayed Idempotency-Key answers the request it created.",
    scope: "write",
    body: "CreatePushRequestRequest",
    requestExample: {},
    success: {
      status: 201,
      schema: "PushRequest",
      description: "The request, pinned and waiting for a decision.",
      example: EXAMPLE_PUSH_REQUEST,
    },
    errors: [...CONFLICTS, 413, 503],
    errorCodes: {
      403: ["FORBIDDEN"],
      409: [
        "IDEMPOTENCY_CONFLICT",
        "PUSH_SOURCE_MISSING",
        "PUSH_REQUEST_OPEN",
        "CHECKPOINT_UNAVAILABLE",
        "CHECKPOINT_MOVED",
      ],
    },
    errorNotes: {
      FORBIDDEN:
        "Also when the deployment does not authenticate callers (`AUTH_MODE=none`): push requests need a verified credential.",
      CHECKPOINT_UNAVAILABLE:
        "Here: the latest checkpoint's manifest did not verify; a push never falls back to an older one.",
      CHECKPOINT_MOVED:
        "Here: the session checkpointed again while the request was being pinned; send it again.",
    },
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/push-requests",
    operationId: "listPushRequests",
    tag: "Push requests",
    summary: "List the session's push requests",
    description:
      "Every push request of the session, newest first, with its state and who requested and decided it.",
    scope: "read",
    success: {
      status: 200,
      schema: "ListPushRequestsResponse",
      description: "The session's push requests.",
      example: { items: [EXAMPLE_PUSH_REQUEST] },
    },
    errors: [401, 404, 503],
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/push-requests/{push_request_id}",
    operationId: "getPushRequest",
    tag: "Push requests",
    summary: "Read one push request",
    description:
      "One push request: what it pinned, its state (`requested`, `approved`, `rejected`, then `pushing`, `pushed` or `failed` once the platform pushes an approved one), and who decided it.\n\nThe API pushes an approved request within seconds: exactly the pinned commit, to `refs/heads/agent/<session-id>` on the repository the request pinned, never by force. It refuses, as `failed`, when the catalog entry for the repository changed after the request, the target is the repository's default branch, or the remote branch holds a commit the pinned one does not build on. `finished_at` and `push_receipt_id` are set once it ends; that `push` receipt (`GET /v1/receipts/{receipt_id}`) names the remote, the ref, the commit it replaced, the approver, and on failure the `refusal`.",
    scope: "read",
    success: {
      status: 200,
      schema: "PushRequest",
      description: "The push request as it stands now.",
      example: EXAMPLE_PUSH_REQUEST,
    },
    errors: [401, 404, 503],
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/push-requests/{push_request_id}/decision",
    operationId: "decidePushRequest",
    tag: "Push requests",
    summary: "Approve or reject a push request",
    description:
      "Decides a `requested` push request once: `approve` lets the platform push the pinned commit to the request's branch, `reject` closes it. `git_commit` must be the commit the decider reviewed; an approval naming any other is refused. An approval is also refused when the session has checkpointed since the request was made, so what is approved is what the session last committed; reject the request and ask again.\n\nOnly a verified credential that holds `sessions:approve` decides: an API key or a signed-in user. Worker credentials are not accepted on `/v1` at all (401). Every attempt, refused ones included, leaves a `decide_push` receipt carrying the actor, the verdict and the refusal reason; a refusal's `error.details.receipt_id` names it. A replayed Idempotency-Key answers the request this decision made, as it is now: once the platform has taken it to push, `state` reads `pushing`, `pushed` or `failed`, while `decided_by`, `decided_at` and `decision_receipt_id` still name this decision.",
    scope: "approve",
    scopeCheckedBy: "service",
    body: "DecidePushRequestRequest",
    requestExample: {
      decision: "approve",
      git_commit: EXAMPLE_GIT_COMMIT,
    },
    success: {
      status: 200,
      schema: "PushRequest",
      description: "The decided request.",
      example: {
        ...EXAMPLE_PUSH_REQUEST,
        state: "approved",
        decided_by: EXAMPLE_ACTOR,
        decided_at: "2026-10-11T08:35:00Z",
        decision_receipt_id: "e1d2c3b4-a5f6-4789-9abc-def012345678",
      },
    },
    errors: [...CONFLICTS, 413, 503],
    errorCodes: {
      403: ["FORBIDDEN"],
      409: ["IDEMPOTENCY_CONFLICT", "PUSH_REQUEST_DECIDED", "CHECKPOINT_MOVED"],
    },
    errorNotes: {
      FORBIDDEN:
        "Also when the principal is not one that may decide, or the deployment does not authenticate callers (`AUTH_MODE=none`).",
      CHECKPOINT_MOVED:
        "Here: an approval whose `git_commit` is not the pinned one, or a session that checkpointed after the request; the request stays `requested`.",
    },
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/push-requests/{push_request_id}/pull-request",
    operationId: "openPullRequest",
    tag: "Push requests",
    summary: "Open a pull request from a pushed request",
    description:
      "Opens a pull request on the repository's forge (GitHub or GHES) from the request's branch `agent/<session-id>` into the catalog entry's `branch`. Only a `pushed` request opens one, and only while the catalog entry is still the one the request pinned. The platform calls GitHub with its own credential: an installation token of the catalog's GitHub App, scoped to this repository with `contents: read` and `pull_requests: write`, or the entry's PAT.\n\n`title` (default `Agent session <session-id>`) and `body` are cleaned before GitHub sees them: `@` mentions, cross-repository references (`owner/repo#N`), closing keywords (`Closes #N` and the like) and HTML comments are broken with a zero-width space, a line that looks like a secret is replaced by `[REDACTED]`, and both are cut to GitHub's limits. The body ends with a line naming the session and the commit. The platform never approves, merges or asks for reviews.\n\nSafe to retry: a request opens at most one pull request. When one is already recorded, or GitHub already has an open one for the branch, it is answered with `created: false` (200). Every attempt, refused ones included, leaves an `open_pull_request` receipt; `receipt_id` names this one, and a refusal's `error.details.receipt_id` names it.\n\nA verified credential that holds `sessions:approve` opens one, as for a push decision. One that holds only `sessions:submit` (an agent's key) opens one too, since the request was already pushed. The token is issued through the agent's GitHub settings: with GitHub off for the agent, or the repository outside its release, the call is refused with `GITHUB_REFUSED`. Worker credentials are not accepted on `/v1` (401).",
    scope: "approve",
    scopeCheckedBy: "service",
    idempotent: false,
    body: "OpenPullRequestRequest",
    requestExample: { title: "Add retry to the sync job" },
    success: {
      status: 201,
      schema: "OpenPullRequestResponse",
      description:
        "The pull request: 201 when this call opened it, 200 with `created: false` when it was already open.",
      example: {
        pull_request: EXAMPLE_PULL_REQUEST,
        created: true,
        receipt_id: EXAMPLE_PULL_REQUEST.receipt_id,
      },
    },
    errors: [...CONFLICTS, 403, 413, 503],
    errorCodes: {
      403: ["FORBIDDEN", "GITHUB_REFUSED"],
      409: ["PUSH_NOT_PUSHED", "CATALOG_MISMATCH", "GITHUB_REFUSED"],
    },
    errorNotes: {
      FORBIDDEN:
        "Also when the principal holds neither `sessions:approve` nor `sessions:submit`, the deployment does not authenticate callers (`AUTH_MODE=none`), or the repository has no GitHub credential (an App or a github.com PAT).",
      CATALOG_MISMATCH:
        "Here: the catalog entry for the repository changed after the push request pinned it.",
      BACKEND_UNAVAILABLE:
        "Here: GitHub refused or failed the call, after waiting out any rate limit it named (at most two retries).",
    },
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/push-requests/{push_request_id}/pull-request/comments",
    operationId: "commentPullRequest",
    tag: "Push requests",
    summary: "Post or update a comment on the pull request",
    description:
      "Posts a comment on the pull request opened from this push request, or edits the one posted before with the same `marker` (default `status`), so a progress note is updated in place instead of piling up. The comment carries a hidden line `<!-- agent-platform:<session-id>:<marker> -->` that finds it again. `body` is cleaned the same way as a pull request body.\n\nEvery attempt, refused ones included, leaves a `comment_pull_request` receipt with the actor, the pull request, the comment id and `created`. The same credentials as opening the pull request are needed.",
    scope: "approve",
    scopeCheckedBy: "service",
    idempotent: false,
    body: "CommentPullRequestRequest",
    requestExample: {
      body: "Tests pass on the pushed commit.",
      marker: "status",
    },
    success: {
      status: 201,
      schema: "CommentPullRequestResponse",
      description:
        "The comment: 201 when this call posted it, 200 with `created: false` when it edited the marked one.",
      example: {
        pull_request: EXAMPLE_PULL_REQUEST,
        comment: {
          id: 2401,
          url: "https://github.com/acme/sample-app/pull/42#issuecomment-2401",
          marker: "status",
          created: true,
        },
        receipt_id: "b8c9d0e1-f2a3-4b4c-9d5e-6f7a8b9c0d1e",
      },
    },
    errors: [...CONFLICTS, 403, 413, 503],
    errorCodes: {
      403: ["FORBIDDEN", "GITHUB_REFUSED"],
      409: ["PULL_REQUEST_MISSING", "CATALOG_MISMATCH", "GITHUB_REFUSED"],
    },
    errorNotes: {
      FORBIDDEN:
        "Also when the principal holds neither `sessions:approve` nor `sessions:submit`, the deployment does not authenticate callers, or the repository has no GitHub credential.",
      CATALOG_MISMATCH:
        "Here: the catalog entry for the repository changed after the push request pinned it.",
      BACKEND_UNAVAILABLE:
        "Here: GitHub refused or failed the call, after waiting out any rate limit it named (at most two retries).",
    },
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/github/workflow-dispatches",
    operationId: "dispatchWorkflow",
    tag: "GitHub work",
    summary: "Start a workflow the agent's release allows",
    description:
      "Starts a GitHub Actions run of `workflow` (a file under `.github/workflows/`) on `ref` in the session's repository. The agent's release must turn on `actions` under the workspace ceiling and list the pair in its allowlist: `ref` matches an entry's `ref` glob (`*` does not cross `/`), or is the catalog entry's `branch` when the entry has no `ref`. A ref under `agent/` is refused (`agent_ref_refused`) whatever the allowlist says. A refused call never reaches GitHub and leaves a `dispatch_workflow` receipt with the `reason_code`.\n\n`inputs` go to GitHub as given and are never stored: the receipt keeps the workflow, the ref and the input names only. A run GitHub reports back is recorded with the session, so a later rerun can prove the platform started it; `run` is null when GitHub did not name it.",
    scope: "write",
    body: "DispatchWorkflowRequest",
    requestExample: {
      workflow: "deploy-preview.yml",
      ref: "main",
      inputs: { environment: "preview" },
    },
    success: {
      status: 201,
      schema: "DispatchWorkflowResponse",
      description: "Started; the receipt and the run GitHub named.",
      example: {
        receipt_id: EXAMPLE_RECEIPT_ID,
        run: {
          id: 9012345678,
          html_url:
            "https://github.com/acme/sample-app/actions/runs/9012345678",
        },
      },
    },
    errors: [...CONFLICTS, 403, 413, 422, 503],
    errorCodes: {
      403: ["FORBIDDEN", "GITHUB_REFUSED"],
      409: ["GITHUB_REFUSED"],
    },
    errorNotes: {
      UNSUPPORTED_CAPABILITY:
        "Here: the session's repository is not a GitHub repository.",
      BACKEND_UNAVAILABLE:
        "Here: GitHub refused or failed the dispatch; the message never repeats the inputs.",
    },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/github/workflow-runs/{run_id}",
    operationId: "getWorkflowRun",
    tag: "GitHub work",
    summary: "Read a workflow run in the session's repository",
    description:
      "Reads one Actions run: its status, conclusion, workflow file and branch. Needs `actions` on in the agent's release under the workspace ceiling; any run in the repository can be read, not only ones the platform started.",
    scope: "read",
    success: {
      status: 200,
      schema: "GitHubWorkflowRun",
      description: "The run.",
      example: {
        id: 9012345678,
        status: "completed",
        conclusion: "failure",
        path: ".github/workflows/deploy-preview.yml",
        head_branch: "main",
        html_url: "https://github.com/acme/sample-app/actions/runs/9012345678",
      },
    },
    errors: [401, 403, 404, 409, 422, 503],
    errorCodes: {
      403: ["FORBIDDEN", "GITHUB_REFUSED"],
      409: ["GITHUB_REFUSED"],
    },
    errorNotes: {
      NOT_FOUND: "Also when GitHub has no such run in the repository.",
    },
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/github/workflow-runs/{run_id}/rerun",
    operationId: "rerunWorkflow",
    tag: "GitHub work",
    summary: "Rerun a workflow run the platform started",
    description:
      "Reruns a run this platform dispatched, all jobs or only the failed ones (`failed_only`). A run the platform has no dispatch record of is refused (`run_ref_unprovable`), and so is one whose workflow and ref the release's current allowlist no longer names (`workflow_not_allowed`). Leaves a `rerun_workflow` receipt either way.",
    scope: "write",
    body: "RerunWorkflowRequest",
    requestExample: { failed_only: true },
    success: {
      status: 201,
      schema: "RerunWorkflowResponse",
      description: "Rerun requested; the receipt.",
      example: { receipt_id: EXAMPLE_RECEIPT_ID },
    },
    errors: [...CONFLICTS, 403, 413, 422, 503],
    errorCodes: {
      403: ["FORBIDDEN", "GITHUB_REFUSED"],
      409: ["GITHUB_REFUSED"],
    },
    errorNotes: {
      UNSUPPORTED_CAPABILITY:
        "Here: the session's repository is not a GitHub repository.",
    },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/interrupt",
    operationId: "interruptSession",
    tag: "Session control",
    summary: "Interrupt the targeted turn only",
    description:
      "Asks the worker to stop turn `target_turn_id` while it runs; the session's admission state and its other turns are left alone. The event stream shows a `status` event with phase `interrupting` when the worker takes the request and `engine_stopped` when the engine has stopped the turn; the turn reads `interrupted` once its checkpoint commits. If the turn has not ended 60 seconds after acceptance, its execution is killed.\n\nAccepted while the turn runs: the receipt settles when the turn ends, with a result of `{turn_id, terminal, no_op}`. A new request for a turn that has already ended answers `receipt_status: succeeded` at once, and its receipt says `no_op: true` with the terminal the turn reached on its own: the interrupt did nothing. An interrupt accepted while the turn ran is `no_op: true` too when the turn got to another terminal first; when the turn's outcome is unknown, so is the receipt (`status: unknown`, `no_op: false`). A replayed Idempotency-Key answers the receipt's current status instead.",
    scope: "control",
    body: "InterruptSessionRequest",
    requestExample: { target_turn_id: "2" },
    success: {
      status: 202,
      schema: "ReceiptAcceptedResponse",
      description:
        "The interrupt is stored (`accepted`), or the turn had already ended (`succeeded`, `no_op: true` on the receipt).",
      example: ACCEPTED_RECEIPT,
    },
    // 422: a turn running on the legacy pod binding, which no worker polls
    // control for.
    errors: [...CONFLICTS, 413, 422, 503],
    errorCodes: {
      409: ["IDEMPOTENCY_CONFLICT", "TURN_NOT_STARTED"],
    },
    errorNotes: {
      NOT_FOUND: "Also when `target_turn_id` names no turn of the session.",
      UNSUPPORTED_CAPABILITY:
        "The turn runs on a legacy pod binding, which no worker polls for control.",
    },
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/pause",
    operationId: "pauseSession",
    tag: "Session control",
    summary: "Drain the current turn, checkpoint, stop the execution",
    description:
      "Pauses an `active` session so it holds no worker: the running turn, if any, is drained, its checkpoint commits and the execution stops. Queued input is kept and runs after a resume. The session goes `pausing` and the receipt stays `accepted` until the execution is observed gone; then the session is `paused` and the receipt `succeeded` with result `{resulting_admission_state, checkpoint_revision, queued_turn_count}`. A session with no execution goes `paused` at once. A drain that takes over 60 seconds shows `attention.code: PAUSE_BLOCKED` with the reason; nothing is killed for it, and terminating is the caller's choice. The receipt fails if the pause cannot commit, a resume cancels it, or a terminate overtakes it. Each step is a `status` event with `admission_state` on the stream.",
    scope: "control",
    body: "PauseSessionRequest",
    requestExample: { expected_revision: 7, reason: "Done for the day" },
    success: {
      status: 202,
      schema: "ReceiptAcceptedResponse",
      description:
        "The pause is stored (`accepted`), or the session had no execution and is `paused` already (`succeeded`).",
      example: ACCEPTED_RECEIPT,
    },
    // 422: a legacy pod binding, as for terminate.
    errors: [...CONFLICTS, 413, 422, 503],
    errorCodes: {
      409: [
        "IDEMPOTENCY_CONFLICT",
        "REVISION_CONFLICT",
        "SESSION_PAUSED",
        "SESSION_RESUMING",
        "SESSION_STOPPED",
        "RECOVERY_REQUIRED",
        "SESSION_CLOSING",
        "SESSION_CLOSED",
        "CHECKPOINT_UNAVAILABLE",
      ],
    },
    errorNotes: {
      REVISION_CONFLICT:
        "Checked before the admission state, so a stale revision answers this even on a session that is already paused.",
      UNSUPPORTED_CAPABILITY: "The session runs on a legacy pod binding.",
      CHECKPOINT_UNAVAILABLE:
        "No live worker can drain the turn and no committed checkpoint covers the last turn; terminate instead.",
    },
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/close",
    operationId: "closeSession",
    tag: "Session control",
    summary: "Finish the session: drain, checkpoint, close for good",
    description:
      "Ends a session whose work is done. Unlike terminate, nothing is killed: the running turn finishes, its checkpoint commits, and the session ends `closed`, which nothing reopens. Unlike a recovery close (`POST /v1/sessions/{id}/recovery-decisions`, `decision: close`), it is the owner's call on a healthy session, needs `sessions:control` rather than `sessions:recover`, and its receipt operation is `close` rather than `recovery_decision`. `docs/api-guide.md` compares the three.\n\n- **`active` with a live worker:** the worker drains as for a pause and the session goes `closing`. The receipt stays `accepted` until the execution is observed gone with a checkpoint covering every turn that ran; then the session is `closed` and the receipt `succeeded`. A drain over 60 seconds shows `attention.code: CLOSE_BLOCKED` with the reason; nothing is killed for it. An open question or approval holds the close until it is answered or the turn interrupted. If the drain cannot commit, the receipt fails and the session goes back to `active` (or `recovery_required` for a turn whose outcome is unknown), with its queued input intact; a terminate overtakes it (`CONTROL_SUPERSEDED`).\n- **`active` with no live worker, `paused`, or a `stopped` session that can be resumed:** closed in this request. With an execution still bound the receipt is `accepted` until it is observed gone; otherwise `succeeded` in the response.\n\nQueued input is cancelled in the transaction that closes the session (each input's receipt fails with `SESSION_CLOSED`). Push requests are left alone; request a push of the result after the close has succeeded, since a push requested inside the last turn is refused `CHECKPOINT_MOVED` once the close commits that turn's checkpoint. The receipt result is `{resulting_admission_state, checkpoint_revision, cancelled_turn_count}`. The stream carries a `status` event for `closing` and for `closed`, and a `system` event `{subtype: session_closed, closed_by: close, close_receipt_id, checkpoint_revision, cancelled_turn_count}`. A caller closing its own session from inside a turn must not wait on the receipt: the drain waits for that turn to end. After the close, messages and controls answer `409 SESSION_CLOSED`.",
    scope: "control",
    body: "CloseSessionRequest",
    requestExample: { expected_revision: 7, reason: "Work is done" },
    success: {
      status: 202,
      schema: "ReceiptAcceptedResponse",
      description:
        "The close is stored (`accepted`), or the session had nothing to wait on and is `closed` already (`succeeded`).",
      example: ACCEPTED_RECEIPT,
    },
    // 422: a legacy pod binding, as for terminate.
    errors: [...CONFLICTS, 413, 422, 503],
    errorCodes: {
      409: [
        "IDEMPOTENCY_CONFLICT",
        "REVISION_CONFLICT",
        "SESSION_PAUSED",
        "SESSION_RESUMING",
        "SESSION_STOPPED",
        "SESSION_CLOSING",
        "SESSION_CLOSED",
        "RECOVERY_REQUIRED",
        "CHECKPOINT_UNAVAILABLE",
      ],
    },
    errorNotes: {
      REVISION_CONFLICT:
        "Checked before the admission state, but after `closed`: a closed session answers `SESSION_CLOSED` whatever the revision.",
      SESSION_PAUSED: "The session is pausing; close it once it is paused.",
      SESSION_STOPPED:
        "The session is stopping; close it once the terminate receipt has settled.",
      RECOVERY_REQUIRED:
        "The session is `recovery_required`, or `stopped` and cannot be resumed; end it with a recovery close instead.",
      CHECKPOINT_UNAVAILABLE:
        "No live worker can drain and no trusted checkpoint covers the last turn that ran; terminate, then use a recovery close.",
      UNSUPPORTED_CAPABILITY: "The session runs on a legacy pod binding.",
    },
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/terminate",
    operationId: "terminateSession",
    tag: "Session control",
    summary: "Block dispatch and force the execution down",
    description:
      "Stops the session by force, in any admission state but `closed`: dispatch is blocked, queued input is cancelled (each input's receipt fails with `SESSION_STOPPED`), open requests close and the execution is killed. The session goes `stopping` until the kill is observed, then `stopped`; with nothing to kill it is `stopped` at once and the receipt is `succeeded` in the response. A `recovery_required` session keeps that state. A turn the kill cut short may end `outcome_unknown`, which holds the session in `recovery_required` until `POST /v1/sessions/{id}/recovery-decisions`. The kill reverts nothing the execution already did outside (commits, pushes, API calls): the response and the receipt say `external_effects_reverted: false`. The receipt result is `{execution_gone, checkpoint_revision, unconfirmed_turn_id, external_effects_reverted}`. Resume a `stopped` session from its last checkpoint with `POST /v1/sessions/{id}/resume`. A pause or close still draining is overtaken: its receipt fails with `CONTROL_SUPERSEDED`. To end a session whose work is done, close it instead (`POST /v1/sessions/{id}/close`).",
    scope: "control",
    body: "TerminateSessionRequest",
    requestExample: { expected_revision: 7, reason: "Runaway tool loop" },
    success: {
      status: 202,
      schema: "TerminateSessionResponse",
      description:
        "The terminate is stored (`accepted`), or there was nothing to kill and the session is `stopped` (`succeeded`).",
      example: { ...ACCEPTED_RECEIPT, external_effects_reverted: false },
    },
    // Served: an oversized body, a legacy binding with no kill path, and a
    // database outage are real answers.
    errors: [...CONFLICTS, 413, 422, 503],
    errorCodes: {
      409: [
        "IDEMPOTENCY_CONFLICT",
        "REVISION_CONFLICT",
        "SESSION_PAUSED",
        "SESSION_RESUMING",
        "SESSION_STOPPED",
        "RECOVERY_REQUIRED",
        "SESSION_CLOSED",
      ],
    },
    errorNotes: {
      SESSION_PAUSED: RESERVED_HERE,
      SESSION_RESUMING: RESERVED_HERE,
      SESSION_STOPPED: RESERVED_HERE,
      RECOVERY_REQUIRED: RESERVED_HERE,
      UNSUPPORTED_CAPABILITY:
        "The session runs on a legacy pod binding with no kill path.",
    },
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/profile",
    operationId: "changeSessionProfile",
    tag: "Session control",
    summary: "Run the session's next turns on another profile",
    description:
      "Moves an `active`, `paused` or `stopped` session onto `profile_id`, a profile this host's catalog allows with the session's repository, or, for a session created without one, a profile whose `repository_mode` is `optional` or `none`. It takes effect at the next turn that starts: a turn running now finishes on the profile it started with, and its worker then leaves so the next one claims the new profile and restores the session's checkpoint, conversation included. The session then runs the new profile's default `model`, whatever `model` it was created with. Earlier turns keep their record and cost; each turn's `attempts[].profile_id` says what it ran on.\n\nThe new profile must run the same runtime kind and version, since the next worker restores checkpoints that runtime took, and must be billed the same way (`billing: none` or not), since the session's cost limit stays as it is. A session created from an agent release runs the release's profile and answers `409 RELEASE_PROFILE_MISMATCH`. The change settles in the request: the receipt is `succeeded` with result `{previous_profile_id, profile_id}`, and a `status` event on the stream carries both. Naming the profile the session already runs changes nothing and still answers `succeeded`.",
    scope: "control",
    body: "ChangeSessionProfileRequest",
    requestExample: { expected_revision: 8, profile_id: "claude-coding-fast" },
    success: {
      status: 200,
      schema: "ReceiptAcceptedResponse",
      description: "The session runs `profile_id` from its next turn on.",
      example: { receipt_id: EXAMPLE_RECEIPT_ID, receipt_status: "succeeded" },
    },
    errors: [...CONFLICTS, 413, 422, 503],
    errorCodes: {
      409: [
        "IDEMPOTENCY_CONFLICT",
        "REVISION_CONFLICT",
        "SESSION_PAUSED",
        "SESSION_RESUMING",
        "SESSION_STOPPED",
        "SESSION_CLOSING",
        "SESSION_CLOSED",
        "RECOVERY_REQUIRED",
        "RELEASE_PROFILE_MISMATCH",
      ],
    },
    errorNotes: {
      REVISION_CONFLICT:
        "Also when the session's profile changed between the read and the change.",
      SESSION_PAUSED: "The session is pausing.",
      SESSION_STOPPED: "The session is stopping.",
      RELEASE_PROFILE_MISMATCH:
        "The session belongs to an agent release, which sets its profile.",
      UNSUPPORTED_CAPABILITY:
        "The profile is not in the catalog, not allowed with the session's repository, runs another runtime, or is billed differently.",
    },
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/resume",
    operationId: "resumeSession",
    tag: "Session control",
    summary: "Restore from the last committed checkpoint or cancel a pause",
    description:
      "Brings a `stopped` or `paused` session back to `active`, or cancels a pause that is still draining. The receipt result is `{resulting_admission_state, checkpoint_revision, queued_turn_count}`.\n\n- **From `stopped`:** the session is `active` at once, the next worker restores the last committed checkpoint, queued input is dispatched, and the receipt is `succeeded` in the response.\n- **From `paused`:** the session goes `resuming` and a new worker restores the pause's checkpoint. The receipt stays `accepted` until that worker reports ready; then the session is `active` and the receipt `succeeded`. If the restore keeps failing, the receipt fails and the session goes `recovery_required`.\n- **From `pausing`, before the stop is committed:** the pause is cancelled (its receipt fails), the session is `active` again, and this receipt is `succeeded`. Once the stop is committed the answer is `409 PAUSE_COMMITTING`.\n\nEach change is a `status` event with `admission_state` on the stream.",
    scope: "control",
    body: "ResumeSessionRequest",
    requestExample: { expected_revision: 8 },
    success: {
      status: 202,
      schema: "ReceiptAcceptedResponse",
      description:
        "The resume is stored: `accepted` while a worker restores a paused session, `succeeded` when it took effect in the request.",
      example: ACCEPTED_RECEIPT,
    },
    // 409 PAUSE_COMMITTING once a pause can no longer be cancelled, 409
    // SESSION_RESUMING while a resume is restoring; 422: a legacy pod
    // binding; 413/503 as for every mutation.
    errors: [...CONFLICTS, 413, 422, 503],
    errorCodes: {
      409: [
        "IDEMPOTENCY_CONFLICT",
        "REVISION_CONFLICT",
        "REQUEST_STALE",
        "SESSION_RESUMING",
        "SESSION_CLOSING",
        "SESSION_CLOSED",
        "RECOVERY_REQUIRED",
        "CHECKPOINT_UNAVAILABLE",
        "PAUSE_COMMITTING",
        "PENDING_REQUESTS_OPEN",
      ],
    },
    errorNotes: {
      PENDING_REQUESTS_OPEN:
        "The session's parked turn still has a request that is neither answered nor expired: answer it, or wait for its `expires_at`. Its answer then resumes the session.",
      FORBIDDEN:
        "Also when an operator revoked the session's execution authority.",
      RECOVERY_REQUIRED:
        "The session is stopping or needs recovery, or a turn's outcome is unknown.",
      REQUEST_STALE: "The session is already active.",
      CHECKPOINT_UNAVAILABLE:
        "The stopped or paused session has no restore point it can resume from.",
      UNSUPPORTED_CAPABILITY: "The session runs on a legacy pod binding.",
      BACKEND_UNAVAILABLE:
        "Also while the stopped session's workspace is being reclaimed; `Retry-After` is 10.",
    },
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/recovery-decisions",
    operationId: "decideSessionRecovery",
    tag: "Recovery",
    summary:
      "Operator decision for an unknown outcome or a context no checkpoint covers",
    description:
      "Records an operator's decision where the platform will not guess: a turn whose outcome is unknown, or context no checkpoint covers. Nothing the execution did outside is reverted.\n\n- `abandon`: the `outcome_unknown` turn `target_turn_id` becomes `cancelled` and its input receipt fails; the session is `stopped`.\n- `confirm_completed`: with `evidence_ref`, the turn becomes `completed` and its input receipt succeeds; it needs a committed checkpoint that reaches the turn. The session is `stopped`.\n- `close`: ends the session for good.\n- `start_fresh`: continues on a new engine session that does not remember the turns before; the checkpoints so far are retired and queued input runs.\n- `retry_restore`: restores the same checkpoint again after what made the restores fail is fixed; queued input runs.\n\nThe decision takes effect in the request: the receipt is `succeeded` in the response, with result `{resulting_admission_state, checkpoint_revision, resumable}`. After `abandon` or `confirm_completed`, resume the session; `resumable: false` means a resume would answer `CHECKPOINT_UNAVAILABLE`. The decision is also recorded as a `system` event on the stream.",
    scope: "recover",
    body: "RecoveryDecisionRequest",
    requestExample: {
      decision: "abandon",
      expected_revision: 9,
      target_turn_id: "3",
      reason: "The call had no external effect.",
    },
    success: {
      status: 202,
      schema: "ReceiptAcceptedResponse",
      description: "The decision is applied; the receipt is `succeeded`.",
      example: { receipt_id: EXAMPLE_RECEIPT_ID, receipt_status: "succeeded" },
    },
    // 422: a legacy pod binding, as for terminate.
    errors: [...CONFLICTS, 413, 422, 503],
    errorNotes: {
      FORBIDDEN:
        "Also when an operator revoked the session's execution authority.",
      NOT_FOUND: "Also when `target_turn_id` names no turn of the session.",
      REQUEST_STALE:
        "The decision does not apply to the session now: `close` or `start_fresh` on a session not awaiting recovery, `confirm_completed` or `abandon` on a turn whose outcome is not unknown, or `retry_restore` on a session a failed restore did not stop.",
      RECOVERY_REQUIRED:
        "The execution is not yet confirmed gone, or `start_fresh` while a turn's outcome is still unknown.",
      CHECKPOINT_UNAVAILABLE:
        "`confirm_completed` with no committed checkpoint that reaches the target turn.",
      SESSION_PAUSED: `${RESERVED_HERE} A decision that does not apply to the session answers \`REQUEST_STALE\`.`,
      SESSION_RESUMING: `${RESERVED_HERE} A decision that does not apply to the session answers \`REQUEST_STALE\`.`,
      SESSION_STOPPED: `${RESERVED_HERE} A decision that does not apply to the session answers \`REQUEST_STALE\`.`,
      UNSUPPORTED_CAPABILITY: "The session runs on a legacy pod binding.",
      BACKEND_UNAVAILABLE:
        "Also while the stopped session's workspace is being reclaimed; `Retry-After` is 10.",
    },
    errorCodes: {
      409: [
        "IDEMPOTENCY_CONFLICT",
        "REVISION_CONFLICT",
        "REQUEST_STALE",
        "SESSION_PAUSED",
        "SESSION_RESUMING",
        "SESSION_STOPPED",
        "RECOVERY_REQUIRED",
        "SESSION_CLOSED",
        "CHECKPOINT_UNAVAILABLE",
      ],
    },
  },
  {
    method: "post",
    path: "/v1/invites",
    operationId: "createInvite",
    tag: "Members",
    summary: "Invite a person to the workspace",
    description:
      "The token is returned once and expires in seven days; only its sha256 is stored. Inviting an address that already has a live invite revokes that invite. An address that is already a live member answers 400. Every invite writes an `invite_member` receipt.",
    auth: "session",
    body: "CreateInviteRequest",
    success: { status: 201, schema: "CreateInviteResponse" },
    errors: [400, 401, 403, 413, 503],
    errorCodes: { 403: ["FORBIDDEN", "OWNER_PROTECTED"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/invites",
    operationId: "listInvites",
    tag: "Members",
    summary: "Invites of the workspace, newest first",
    description:
      "Each invite's status is pending, accepted, revoked or expired. Tokens are never returned.",
    auth: "session",
    success: { status: 200, schema: "ListInvitesResponse" },
    errors: [401, 403, 503],
  },
  {
    method: "delete",
    path: "/v1/invites/{id}",
    operationId: "revokeInvite",
    tag: "Members",
    summary: "Revoke an invite",
    description:
      "Writes a `revoke_invite` receipt. Revoking an invite that was already revoked does nothing; an accepted one answers 409.",
    auth: "session",
    success: { status: 204 },
    errors: [401, 403, 404, 409, 503],
    errorCodes: { 409: ["INVITE_USED"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/invites/accept",
    operationId: "acceptInvite",
    tag: "Auth",
    summary: "Redeem an invite; sets the session cookie",
    description:
      "An address with no account gets one with this password. An existing account joins with its current password, which is never changed. The token is spent once; a revoked, replaced or expired token answers 410, an accepted one 409. Writes an `accept_invite` receipt.",
    auth: "public",
    csrf: "always",
    body: "AcceptInviteRequest",
    success: { status: 200, schema: "AcceptInviteResponse" },
    errors: [400, 401, 403, 409, 410, 413, 429, 503],
    errorCodes: { 409: ["INVITE_USED"], 410: ["INVITE_EXPIRED"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/members",
    operationId: "listMembers",
    tag: "Members",
    summary: "Members of the workspace, oldest first",
    description:
      "Lists the workspace's members, disabled ones included, oldest membership first, `limit` per page (default 50, at most 100). Pass `next_cursor` back as `cursor` for the next page; it is null on the last one. `q` keeps the members whose display name or email contains it, ignoring case. `user_ids` (comma-separated, at most 100) keeps the members among those users, as one page of a screen that already holds the ids and needs their names or roles. Each row's `actions` says, for the caller as the list was read, whether each role change, disable and enable would be accepted, and if not, why: the reason is the lower-cased error code the write answers with, or `unchanged` when it would answer 200 and change nothing. The write checks again when it runs. A client that validates responses strictly needs this version's schema to read the field.",
    auth: "session",
    query: "ListMembersQuery",
    success: { status: 200, schema: "ListMembersResponse" },
    errors: [400, 401, 403, 503],
  },
  {
    method: "patch",
    path: "/v1/members/{user_id}",
    operationId: "updateMember",
    tag: "Members",
    summary: "Change a member's role",
    description:
      "When several apply, the first answers: no `member.manage` (403 FORBIDDEN), your own role (403 SELF_PROTECTED), no such member (404), an owner targeted, or the owner role granted, by an admin (403 OWNER_PROTECTED), a suspended account (409 ACCOUNT_DISABLED), a disabled membership (409 MEMBER_DISABLED), the role it already has (200, nothing written), demoting the workspace's last live owner (409 LAST_OWNER). Writes a `change_member_role` receipt when the role changes.",
    auth: "session",
    body: "UpdateMemberRequest",
    success: { status: 200, schema: "MemberView" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: {
      403: ["FORBIDDEN", "SELF_PROTECTED", "OWNER_PROTECTED"],
      409: ["ACCOUNT_DISABLED", "MEMBER_DISABLED", "LAST_OWNER"],
    },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/members/{user_id}/disable",
    operationId: "disableMember",
    tag: "Members",
    summary: "Disable a member of the workspace",
    description:
      "In the same transaction: the membership is disabled, every web session of the person is revoked (open event streams end), their personal keys in the workspace are revoked, and the sessions they asked for wait for an owner's takeover. Agent keys are untouched. Only an owner disables an owner: an admin targeting one answers 403 OWNER_PROTECTED and nothing changes. Disabling yourself answers 403 SELF_PROTECTED, the last live owner 409 LAST_OWNER. When several apply, the first answers: no `member.manage` (403 FORBIDDEN), no such member (404), yourself (403 SELF_PROTECTED), an owner targeted by an admin (403 OWNER_PROTECTED), already disabled (200, nothing written), the last live owner (409). Writes a `disable_member` receipt unless the membership was already disabled (`receipt_id` null).",
    auth: "session",
    body: "SetAccessRequest",
    success: { status: 200, schema: "SetAccessResponse" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: {
      403: ["FORBIDDEN", "SELF_PROTECTED", "OWNER_PROTECTED"],
      409: ["LAST_OWNER"],
    },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/members/{user_id}/enable",
    operationId: "enableMember",
    tag: "Members",
    summary: "Enable a disabled member again",
    description:
      "Revoked web sessions and personal keys stay revoked: the person signs in again. Sessions no owner took over go back to them. When several apply, the first answers: no `member.manage` (403 FORBIDDEN), no such member (404), yourself (403 SELF_PROTECTED), an owner targeted by an admin (403 OWNER_PROTECTED), a suspended account (409 ACCOUNT_DISABLED: the membership alone would not bring them back, lift the suspension), already live (200, nothing written). Writes an `enable_member` receipt unless the membership was already live (`receipt_id` null).",
    auth: "session",
    body: "SetAccessRequest",
    success: { status: 200, schema: "SetAccessResponse" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: {
      403: ["FORBIDDEN", "SELF_PROTECTED", "OWNER_PROTECTED"],
      409: ["ACCOUNT_DISABLED"],
    },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/users/{user_id}/disable",
    operationId: "disableUser",
    tag: "Members",
    summary: "Suspend an account",
    description:
      "Allowed only when every live membership of the account is in a workspace the caller owns or administers; otherwise 403 FORBIDDEN. An account that is an owner, even with that membership disabled, in any workspace the caller is not a live owner of answers 403 OWNER_PROTECTED first. The account cannot sign in anywhere, and the same cut-off as disabling a member applies in each of its workspaces. Suspending yourself answers 403 SELF_PROTECTED. Writes a `disable_user` receipt unless the account was already suspended (`receipt_id` null).",
    auth: "session",
    body: "SetAccessRequest",
    success: { status: 200, schema: "SetAccessResponse" },
    errors: [400, 401, 403, 404, 413, 503],
    errorCodes: { 403: ["FORBIDDEN", "SELF_PROTECTED", "OWNER_PROTECTED"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/users/{user_id}/enable",
    operationId: "enableUser",
    tag: "Members",
    summary: "Lift an account suspension",
    description:
      "The same rules as suspending, OWNER_PROTECTED included. Revoked web sessions and personal keys stay revoked. Writes an `enable_user` receipt unless the account was not suspended (`receipt_id` null).",
    auth: "session",
    body: "SetAccessRequest",
    success: { status: 200, schema: "SetAccessResponse" },
    errors: [400, 401, 403, 404, 413, 503],
    errorCodes: { 403: ["FORBIDDEN", "OWNER_PROTECTED"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/takeovers",
    operationId: "listTakeovers",
    tag: "Admin",
    summary: "Sessions waiting for an owner to take them over",
    description:
      "Sessions whose requester was offboarded. Each takes no further input until an owner takes it over. API keys are refused.",
    auth: "session",
    success: { status: 200, schema: "ListTakeoversResponse" },
    errors: [401, 403, 503],
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/takeover",
    operationId: "takeOverSession",
    tag: "Admin",
    summary: "Become the requester of an offboarded member's session",
    description:
      "The caller becomes the session's requester and its queued input runs again. A session shared with less than the whole workspace and not with the caller needs a `justification`, kept on the decision and the receipt; without one it answers 403 with `reason_code` `justification_required`. The body may be empty. API keys are refused.",
    auth: "session",
    body: "TakeOverSessionRequest",
    success: { status: 200, schema: "ReceiptAcceptedResponse" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["REQUEST_STALE"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/linked-accounts/slack/start",
    operationId: "startSlackLink",
    tag: "Linked accounts",
    summary: "Start linking the caller's Slack account",
    description:
      "Returns Slack's consent URL and sets a one-time state cookie for the callback, valid ten minutes. Scopes are `openid profile`; no email is requested. The consent is for the workspace's link app; a workspace without one gets it made now with its App Configuration Token (once: concurrent starts share it), unless the installation names a fallback OIDC app. Refused with 409 when the workspace has no verified Slack install, or nothing to link with. API keys are refused.",
    auth: "session",
    success: { status: 200, schema: "StartSlackLinkResponse" },
    errors: [401, 403, 409, 503],
    errorCodes: {
      409: [
        "SLACK_NOT_INSTALLED",
        "SLACK_LINK_NOT_CONFIGURED",
        "SLACK_APP_CREATING",
        "REVISION_CONFLICT",
      ],
    },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/linked-accounts/slack/callback",
    operationId: "slackLinkCallback",
    tag: "Linked accounts",
    summary: "Finish linking with the code Slack returned",
    description:
      "Spends the state cookie, exchanges the code and verifies the id_token, then links the Slack account to the caller and writes a `link_account` receipt. Refused when the account's Slack team is not installed for the workspace, when the account is linked to someone else (never overwritten), or when the caller already linked another account in that team. API keys are refused.",
    auth: "session",
    body: "SlackLinkCallbackRequest",
    success: { status: 201, schema: "SlackLinkCallbackResponse" },
    errors: [400, 401, 403, 409, 413, 503],
    errorCodes: {
      409: [
        "SLACK_NOT_INSTALLED",
        "LINK_TEAM_MISMATCH",
        "LINK_TAKEN",
        "LINK_EXISTS",
      ],
    },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/linked-accounts",
    operationId: "listLinkedAccounts",
    tag: "Linked accounts",
    summary: "The caller's linked accounts that are active or stale",
    description:
      "Each item's `expires_at` is its provider token's expiry, null when no token is kept (every Slack link). API keys are refused.",
    auth: "session",
    success: { status: 200, schema: "ListLinkedAccountsResponse" },
    errors: [401, 403, 503],
  },
  {
    method: "delete",
    path: "/v1/linked-accounts/{id}",
    operationId: "unlinkAccount",
    tag: "Linked accounts",
    summary: "Unlink one of the caller's accounts",
    description:
      "Revokes the link and writes an `unlink_account` receipt. Input from that Slack account is refused from then on, including input that was already waiting to be processed. API keys are refused.",
    auth: "session",
    success: { status: 200, schema: "ReceiptAcceptedResponse" },
    errors: [401, 403, 404, 503],
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/agents",
    operationId: "listAgents",
    tag: "Agents",
    summary: "The workspace's agents",
    description:
      "Lists the workspace's agents oldest `created_at` first, `limit` per page (default 50, at most 100). Pass `next_cursor` back as `cursor` for the next page; it is null on the last one. A cursor that does not decode to a position in that order answers 400; a cursor only positions the read, so one from another workspace shows nothing of it. `include=summary` adds to each item a `summary` of what a card shows (the version people talk to, its runtime profile, live credential bindings, admins, and how many of the agent's sessions the caller can see are `needs_input` and `running`, as `GET /v1/sessions` shows them), read for the whole page at once; without it the items are as before. `q` keeps the agents whose name or slug contains it, ignoring case, and `ids` the agents named (at most 100; an id of no agent in the workspace is left out); both narrow the same order, so the cursor works as before. An agent key that holds `sessions:write` gets its own agent alone, on one page, so it can find the `active_release_id` to send as `agent_release_id` to `POST /v1/sessions`; it is refused `include=summary`, `q` and `ids` keep its agent only when it matches them, and every other API key is refused.",
    // A key needs sessions:write here, the right to start a session on the
    // agent it finds; a person's role holds it.
    scope: "write",
    query: "ListAgentsQuery",
    success: {
      status: 200,
      schema: "ListAgentsResponse",
      description: "One page of agents.",
      example: {
        items: [EXAMPLE_AGENT],
        next_cursor:
          "eyJjcmVhdGVkX2F0IjoiMjAyNi0xMC0xMSAwODowMDowMCswMCIsImlkIjoiOGQyYzRmMWEtNmIzZS00YTlkLWI3YzUtMmUxZjBhOWI4YzdkIn0",
      },
    },
    errors: [400, 401, 403, 503],
  },
  {
    method: "get",
    path: "/v1/agents/counts",
    operationId: "countAgents",
    tag: "Agents",
    summary:
      "How many agents the workspace has, by state, and how many the caller administers",
    description:
      "`all` is how many agents GET /v1/agents lists read to the last page; `administered` is how many of them the caller administers now, directly or through a team they are a live member of; `active` is how many are `active` with an `active_release_id`, and `draft` how many are not `archived` and have none yet. Answered for the same callers as the list. API keys are refused. It changes nothing.",
    auth: "session",
    success: {
      status: 200,
      schema: "CountAgentsResponse",
      description: "The counts.",
      example: { counts: { all: 128, administered: 3, active: 97, draft: 24 } },
    },
    errors: [401, 403, 503],
  },
  {
    method: "post",
    path: "/v1/agents",
    operationId: "createAgent",
    tag: "Agents",
    summary: "Create an agent and its first card version",
    description:
      "Nothing is released or activated. A slug already used in the workspace answers 409 ALREADY_EXISTS. API keys are refused.",
    auth: "session",
    body: "CreateAgentRequest",
    success: { status: 201, schema: "AgentDetail" },
    errors: [400, 401, 403, 409, 413, 503],
    errorCodes: { 409: ["ALREADY_EXISTS"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/agents/{id}",
    operationId: "getAgent",
    tag: "Agents",
    summary: "An agent with its versions, releases and active release",
    auth: "session",
    success: { status: 200, schema: "AgentDetail" },
    errors: [401, 403, 404, 503],
  },
  {
    method: "patch",
    path: "/v1/agents/{id}",
    operationId: "updateAgent",
    tag: "Agents",
    summary: "Rename an agent or add a card version",
    description:
      "A `card` becomes a new version; existing versions never change. A card equal to one the agent already has adds nothing.",
    auth: "session",
    body: "UpdateAgentRequest",
    success: { status: 200, schema: "AgentDetail" },
    errors: [400, 401, 403, 404, 413, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/agents/{id}/releases",
    operationId: "createAgentRelease",
    tag: "Agents",
    summary: "Release a version against a runtime profile",
    description:
      "The release id is a hash of the card, the profile's digest and the resolved runtime settings; releasing the same content again returns the stored release with `created: false`. The optional `note` (trimmed, 1 to 200 characters) is stored with the release but is not part of its id, so a re-release keeps the note it was first made with. A card tool outside the profile, a different model or an unknown profile answers 422. `repository_id` names the catalog repository the release's sessions work on (`GET /v1/profiles`, `repository_ids`): required when the profile's `repository_mode` is `required` (422 `repository_id: Profile <id> needs a repository: send repository_id`), refused when it is `none`, and 422 when the catalog has no such repository or it does not allow the profile. Slack sessions and API sessions that send no `repository_id` work on it. A profile the operator blocked, or one over a blocked base, answers 409 PROFILE_BLOCKED. Releasing approves and activates nothing.",
    auth: "session",
    body: "CreateAgentReleaseRequest",
    success: { status: 200, schema: "CreateAgentReleaseResponse" },
    errors: [400, 401, 403, 404, 409, 413, 422, 503],
    errorCodes: { 409: ["PROFILE_BLOCKED"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/agents/{id}/activate",
    operationId: "activateAgent",
    tag: "Agents",
    summary: "Point the agent at a release (compare-and-swap)",
    description:
      "`expected_revision` is the agent's current `activation_revision` (-1 before the first activation); a stale one answers 409 REVISION_CONFLICT. Sending the same activation again is a no-op with a null `receipt_id`. A release whose runtime profile changed since answers 409 PROFILE_DIGEST_MISMATCH and has to be released again; one whose profile the operator blocked answers 409 PROFILE_BLOCKED. A release whose card names a credential not bound to the agent answers 409 CREDENTIAL_UNBOUND with the missing names in `details.missing` (`ActivationCredentialUnboundDetails`). Sessions already pinned keep their release.",
    auth: "session",
    body: "ActivateAgentRequest",
    success: { status: 200, schema: "ActivateAgentResponse" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: {
      409: [
        "REVISION_CONFLICT",
        "PROFILE_DIGEST_MISMATCH",
        "PROFILE_BLOCKED",
        "CREDENTIAL_UNBOUND",
      ],
    },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/agents/{id}/credential-bindings",
    operationId: "listCredentialBindings",
    tag: "Agents",
    summary: "The credential names bound to an agent",
    description:
      "Owners, admins and the agent's admins. Each binding carries `running_sessions`, the sessions of this agent that name it and have not closed, with the `revoke_notice` the unbind screen shows: unbinding stops the next session and the next message of a running one, and cuts its remote MCP calls within 30 seconds. Names only; no value is ever stored.",
    auth: "session",
    success: { status: 200, schema: "ListCredentialBindingsResponse" },
    errors: [401, 403, 404, 503],
  },
  {
    method: "post",
    path: "/v1/agents/{id}/credential-bindings",
    operationId: "createCredentialBinding",
    tag: "Agents",
    summary: "Bind a credential name to an agent",
    description:
      "Owners, admins and the agent's admins; never an API key. `credential_ref` names a credential held outside Werft (a secret store entry, a remote MCP server connection). Binding a name already bound answers `created: false` and a null `receipt_id`; otherwise writes a `bind_credential` receipt. A name an agent identity holds answers 409 CREDENTIAL_REF_IN_USE.",
    auth: "session",
    body: "CreateCredentialBindingRequest",
    success: { status: 200, schema: "CreateCredentialBindingResponse" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["CREDENTIAL_REF_IN_USE"] },
    idempotent: false,
  },
  {
    method: "delete",
    path: "/v1/agents/{id}/credential-bindings/{binding_id}",
    operationId: "revokeCredentialBinding",
    tag: "Agents",
    summary: "Unbind a credential name from an agent",
    description:
      "Takes what binding takes. The next session of a release naming it, and the next message to a running one, is refused 409 CREDENTIAL_UNBOUND with a failed receipt; a running session's remote MCP calls are refused from the next exchange and an open one is cut within 30 seconds, while a call already sent finishes. The answer's `binding.running_sessions` and `revoke_notice` say so. Writes an `unbind_credential` receipt; a binding already revoked is not found.",
    auth: "session",
    success: { status: 200, schema: "RevokeCredentialBindingResponse" },
    errors: [401, 403, 404, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/agents/{id}/identities",
    operationId: "linkAgentIdentity",
    tag: "Agents",
    summary: "Pin the agent to its Slack app's install in one team",
    description:
      "Slack events from that app and team then resolve to this agent and no other; events from another app, or after the identity or the install is revoked, are dropped. The install must be verified for the workspace (409 SLACK_NOT_INSTALLED); one already pinned to another agent answers 409 AGENT_IDENTITY_TAKEN, and to this agent 409 ALREADY_EXISTS. `credential_ref` names the bot token in the secret store, never its value, and is this identity's alone: a name bound to an agent or another identity answers 409 CREDENTIAL_REF_IN_USE, and the name is freed when the identity is revoked. Owners, admins and the agent's admins; API keys are refused. Writes a `link_agent_identity` receipt.",
    auth: "session",
    body: "LinkAgentIdentityRequest",
    success: { status: 201, schema: "LinkAgentIdentityResponse" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: {
      409: [
        "SLACK_NOT_INSTALLED",
        "AGENT_IDENTITY_TAKEN",
        "ALREADY_EXISTS",
        "CREDENTIAL_REF_IN_USE",
      ],
    },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/agents/{id}/identities",
    operationId: "listAgentIdentities",
    tag: "Agents",
    summary: "The agent's Slack app identities",
    description:
      "Active first, then revoked, newest first within each; up to 50. Owners, admins and the agent's admins.",
    auth: "session",
    success: { status: 200, schema: "ListAgentIdentitiesResponse" },
    errors: [401, 403, 404, 503],
  },
  {
    method: "delete",
    path: "/v1/agents/{id}/identities/{identity_id}",
    operationId: "revokeAgentIdentity",
    tag: "Agents",
    summary: "Revoke an agent identity",
    description:
      "Events from that app and team are dropped from then on, including events already waiting to be processed. Revoking one already revoked changes nothing and answers a null `receipt_id`; otherwise writes a `revoke_agent_identity` receipt. The agent's Slack channel bindings in that install are revoked with it. Linking again makes a new identity.",
    auth: "session",
    success: { status: 200, schema: "RevokeAgentIdentityResponse" },
    errors: [401, 403, 404, 503],
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/agents/{id}/slack-bindings",
    operationId: "listSlackBindings",
    tag: "Agents",
    summary: "The agent's Slack channel bindings",
    description:
      "Live bindings of the channels of the agent's Slack app, and its DM binding (`surface_kind: dm`, no `external_surface_id`): the home channel first, then oldest first; up to 500. Channel ids only; the console resolves names. Owners, admins and the agent's admins.",
    auth: "session",
    success: { status: 200, schema: "ListSlackBindingsResponse" },
    errors: [401, 403, 404, 503],
  },
  {
    method: "put",
    path: "/v1/agents/{id}/slack-bindings",
    operationId: "putSlackBinding",
    tag: "Agents",
    summary: "Set how the agent answers in one Slack channel or its DMs",
    description:
      "Replaces the binding of `channel_id` in the agent's Slack app install, or the install's one DM binding when `channel_id` is null, creating it the first time. The channel's kind is what Slack's `conversations.info` answers with the bot token; `channel_kind`, when sent, only has to agree on whether this is the DM row (400 when Slack names a DM or does not know the channel, 503 when Slack cannot be read). `mode` is `off` (the channel takes nothing; a mention there is refused) or `on` (in use; the agent's `mention_only` setting says whether it also answers a top-level message without a mention).`home: true` makes this channel the agent's home and clears the previous one; a DM is never home. A missing `ceiling` is the default: every Slack action, shown in full. The agent needs a live Slack app identity (409 SLACK_NOT_INSTALLED); a concurrent change to the same channel or home answers 409 REVISION_CONFLICT. The bot does not join the channel here. Owners, admins and the agent's admins; API keys are refused. Writes a `set_surface_binding` receipt.",
    auth: "session",
    body: "PutSlackBindingRequest",
    success: { status: 200, schema: "PutSlackBindingResponse" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["SLACK_NOT_INSTALLED", "REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/agents/{id}/slack-channels",
    operationId: "lookupSlackChannels",
    tag: "Agents",
    summary: "Resolve up to 50 Slack channel IDs by name",
    description:
      "Accepts comma-separated IDs only, with no cursor or full scan. Reads conversations.info concurrently and caches each app and channel for 60 seconds, coalescing concurrent reads. IDs Slack reports as missing or inaccessible return state and name unknown. Transport failures and upstream errors answer 503 without caching; a revoked or invalid bot token answers 409 SLACK_NOT_INSTALLED. Slack rate limits answer 503 with Retry-After. Agent managers only.",
    auth: "session",
    query: "LookupSlackChannelsQuery",
    success: {
      status: 200,
      schema: "LookupSlackChannelsResponse",
      description: "Names for the requested IDs.",
      example: { items: [{ id: "C0DEPLOY1", name: "deploy", state: "known" }] },
    },
    errors: [400, 401, 403, 404, 409, 503],
    errorCodes: { 409: ["SLACK_NOT_INSTALLED"] },
  },
  {
    method: "get",
    path: "/v1/agents/{id}/slack/channels",
    operationId: "searchSlackChannels",
    tag: "Agents",
    summary: "Search the channels the agent's Slack bot can see",
    description:
      "Channels whose name starts with `q` (any case, a leading `#` ignored), by name, `limit` per page (default 20, at most 50): every public channel of the install and the private ones the bot is already in. `is_member` says whether the bot is in the channel. The server reads the app's whole list from Slack (`conversations.list` with the bot token) and keeps it for 60 seconds per app, up to 10,000 channels (`truncated: true` past that); a binding change in the same API process drops it sooner. Pass `next_cursor` back as `cursor` with the same `q` for the next page; once the list it pages through has been replaced the cursor answers 400 CURSOR_EXPIRED, and the search starts over. When Slack rate limits, the last list read is returned with `stale: true`, or 503 with Slack's `Retry-After` when there is none; Slack is not asked again before then. The agent needs an installed Slack app with a bot token (409 SLACK_NOT_INSTALLED). Owners, admins and the agent's admins.",
    auth: "session",
    query: "SearchSlackChannelsQuery",
    success: {
      status: 200,
      schema: "SearchSlackChannelsResponse",
      description: "One page of matching channels.",
      example: {
        items: [
          {
            id: "C0DEPLOY1",
            name: "deploy",
            is_private: false,
            is_member: true,
          },
          {
            id: "G0DESIGN1",
            name: "design",
            is_private: true,
            is_member: true,
          },
        ],
        next_cursor: "eyJzIjoiYWJjIiwibyI6MiwicSI6ImRlIn0",
        truncated: false,
        stale: false,
      },
    },
    errors: [400, 401, 403, 404, 409, 503],
    errorCodes: {
      400: ["BAD_REQUEST", "CURSOR_EXPIRED"],
      409: ["SLACK_NOT_INSTALLED"],
    },
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "Also when Slack is rate limiting with no list read yet (`Retry-After` is Slack's), when Slack does not answer, or when the API runs without a master key (PLATFORM_SECRET_KEY).",
    },
  },
  {
    method: "get",
    path: "/v1/agents/{id}/slack/app/manifest",
    operationId: "getSlackAppManifest",
    tag: "Agents",
    summary: "Read the agent app manifest as YAML",
    description:
      "Builds the manifest from the agent and server configuration without reading secret values. Agent managers with a web session only.",
    auth: "session",
    success: {
      status: 200,
      schema: "GetSlackAppManifestResponse",
      description: "The generated manifest without secret values.",
      example: { manifest_yaml: "display_information:\n  name: Agent\n" },
    },
    errors: [401, 403, 404, 503],
  },
  {
    method: "get",
    path: "/v1/agents/{id}/slack/app/settings",
    operationId: "getSlackAppSettings",
    tag: "Agents",
    summary: "Read whether the agent answers only when mentioned in Slack",
    description:
      "Returns `mention_only`: `true` (the initial value) answers only a mention, `false` also any person's top-level message without one. Either way, a reply in a thread already linked to the agent's session continues it without a mention. It covers every channel in use, connected before or after; DMs do not follow it. Agent managers with a web session only.",
    auth: "session",
    success: {
      status: 200,
      schema: "SlackAppSettings",
      description: "The saved setting.",
      example: { mention_only: true },
    },
    errors: [401, 403, 404, 503],
  },
  {
    method: "put",
    path: "/v1/agents/{id}/slack/app/settings",
    operationId: "putSlackAppSettings",
    tag: "Agents",
    summary: "Save whether the agent answers only when mentioned in Slack",
    description:
      "Saves `mention_only` for every channel of the agent that is in use, the ones already connected included; the next message reads it. DMs do not follow it. Agent managers with a web session only.",
    auth: "session",
    body: "SlackAppSettings",
    requestExample: { mention_only: false },
    success: {
      status: 200,
      schema: "SlackAppSettings",
      description: "The saved setting.",
      example: { mention_only: true },
    },
    errors: [400, 401, 403, 404, 413, 503],
  },
  {
    method: "get",
    path: "/v1/agents/{id}/github",
    operationId: "getAgentGitHub",
    tag: "Agents",
    summary: "The agent's GitHub switch, settings and what may be turned on",
    description:
      "`enabled` is the switch that applies at once (`PUT …/github/enabled`). `github` is the active release's GitHub settings; null before one is saved, when `legacy_defaults` is what a first save starts from (the release's repository, push approval on, nothing optional) and the release meanwhile runs on every repository its profile allows. Settings are saved as a new release (`POST /v1/agents/{id}/releases` with `github`). `unsavable` says why none can be: `no_active_release`, `repository_none` (the release names no repository) or `app_required` (its repository is a PAT one). `options.repositories` lists the catalog's GitHub repositories with why one cannot be picked (`repository_not_allowed` by the release's profile, `app_required` for a PAT one). `options.features` says, per optional permission, why it cannot be turned on: `github_host_unsupported` (every chosen repository is on a GitHub Enterprise host), `over_workspace_ceiling`, `no_reviewer_app`, or `app_permission_missing` (the App's permissions as last read lack it; the token request decides). Whoever manages the agent reads it.",
    auth: "session",
    success: {
      status: 200,
      schema: "AgentGitHubResponse",
      description: "The switch, the pinned settings and the options.",
      example: {
        enabled: true,
        active_release_id: "rel_example",
        release_repository_id: "werft-sandbox",
        github: {
          repositories: ["werft-sandbox"],
          push_approval: true,
          features: {
            workflows: false,
            actions: true,
            checks: false,
            issues: false,
            review: false,
          },
          actions_allow: [{ workflow: "ci.yml", ref: "release/*" }],
        },
        legacy_defaults: null,
        unsavable: null,
        options: {
          repositories: [
            {
              id: "werft-sandbox",
              url: "https://github.com/example/werft-sandbox",
              available: true,
              reason: null,
            },
          ],
          features: {
            workflows: { available: false, reason: "app_permission_missing" },
            actions: { available: true, reason: null },
            checks: { available: false, reason: "over_workspace_ceiling" },
            issues: { available: false, reason: "over_workspace_ceiling" },
            review: { available: false, reason: "no_reviewer_app" },
          },
        },
      },
    },
    errors: [401, 403, 404, 503],
  },
  {
    method: "put",
    path: "/v1/agents/{id}/github/enabled",
    operationId: "putAgentGitHubEnabled",
    tag: "Agents",
    summary: "Turn the agent's GitHub use on or off",
    description:
      "Applies at once, without a release: off refuses every GitHub token for the agent's sessions from the next request on, running ones included (403 `GITHUB_REFUSED` `github_disabled`). Writes a `set_agent_github` receipt when the value changes; `receipt_id` is null when it already held. Agent managers with a web session only; API keys are refused.",
    auth: "session",
    body: "PutAgentGitHubEnabledRequest",
    requestExample: { enabled: false },
    success: {
      status: 200,
      schema: "PutAgentGitHubEnabledResponse",
      description: "Saved.",
      example: { enabled: false, receipt_id: EXAMPLE_RECEIPT_ID },
    },
    errors: [400, 401, 403, 404, 413, 503],
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/agents/{id}/github/activity",
    operationId: "getAgentGitHubActivity",
    tag: "Agents",
    summary: "The agent's latest GitHub receipts",
    description:
      "Up to 20 receipts, newest first: `set_agent_github`, the `create_agent_release` and `activate_agent` receipts that changed the GitHub settings (`result.github_changed`), and for the agent's sessions `mint_github_token` (a refusal is `failed` with `result.reason_code`), `dispatch_workflow`, `rerun_workflow` and `review_pull_request`. Found by target, not by actor, so a release a person made is listed. Session receipts come only from sessions the caller can see, filtered before the 20 are cut: an agent manager is not shown a private session nobody shared with them. Whoever manages the agent reads it.",
    auth: "session",
    success: {
      status: 200,
      schema: "AgentGitHubActivityResponse",
      description: "The receipts.",
      example: { items: [] },
    },
    errors: [401, 403, 404, 503],
  },
  {
    method: "get",
    path: "/v1/agents/{id}/slack/app",
    operationId: "getSlackApp",
    tag: "Agents",
    summary: "The agent's Slack app, if the platform made one",
    description:
      "The agent's live Slack app (`creating`, `created` or `deleting`), or null when it has none. Secrets appear only as whether each is stored; `secrets.slack_bot_token.configured` says whether Slack handed over a bot token; an install refused after the code exchange keeps it, so the agent's `slack_bot` identity is what says the app is installed. The install link comes from `POST /v1/agents/{id}/slack/install/start`. `warnings` says why every Slack mention and DM would be refused with a notice in the thread: `no_active_release` before an activation, `profile_unavailable` (with the `profile_id`) while the catalog no longer has the active release's profile, defines it otherwise than it was released, or an owner blocked it, and `repository_required` (with the `profile_id`) while the release names no repository and its profile needs one. Connecting is not blocked. Owners, admins and the agent's admins; API keys are refused.",
    auth: "session",
    success: {
      status: 200,
      schema: "GetSlackAppResponse",
      description: "The agent's app, or null.",
      example: {
        slack_app: EXAMPLE_SLACK_APP,
        event_url:
          "https://agents.example.test/v1/slack/events/019a0000-0000-7000-8000-0000000000c1",
        events: {
          state: "pending",
          checked_at: "2026-10-28T00:00:00.000Z",
          url: "https://agents.example.test/v1/slack/events/019a0000-0000-7000-8000-0000000000c1",
        },
        warnings: [],
      },
    },
    errors: [401, 403, 404, 503],
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY).",
    },
  },
  {
    method: "post",
    path: "/v1/agents/{id}/slack/app/events/recheck",
    operationId: "recheckSlackAppEvents",
    tag: "Agents",
    // Sending the same manifest again is harmless.
    idempotent: false,
    summary: "Send the agent app's Request URL to Slack again",
    description:
      "Sends the app's whole manifest again with its Request URL (`apps.manifest.update`), as the install does, so Slack checks the URL anew. Slack's check arrives as a signed `url_verification`, which the events route answers with its challenge and nothing else; the app then reads `events.state: verified`. An app already verified for the same URL stays verified; a changed URL reads `pending` until Slack checks it. `events.url` is the Request URL last sent to Slack, null before any. Owners, admins and the agent's admins from a signed-in console; API keys are refused.",
    auth: "session",
    success: {
      status: 200,
      schema: "GetSlackAppResponse",
      description: "The agent's app after the manifest was sent.",
      example: {
        slack_app: EXAMPLE_SLACK_APP,
        event_url:
          "https://agents.example.test/v1/slack/events/019a0000-0000-7000-8000-0000000000c1",
        events: {
          state: "verified",
          checked_at: "2026-10-28T00:00:00.000Z",
          url: "https://agents.example.test/v1/slack/events/019a0000-0000-7000-8000-0000000000c1",
        },
        warnings: [],
      },
    },
    errors: [401, 403, 404, 409, 503],
    errorCodes: { 409: ["CONFIG_TOKEN_INVALID"] },
    errorNotes: {
      BACKEND_UNAVAILABLE:
        "Also without a master key (PLATFORM_SECRET_KEY), without SLACK_EVENTS_PUBLIC_URL, or when Slack refuses or loses the manifest update.",
    },
  },
  {
    method: "post",
    path: "/v1/agents/{id}/slack/app",
    operationId: "createSlackApp",
    tag: "Agents",
    summary: "Create the agent's Slack app",
    description:
      "Creates one Slack app for the agent with the workspace's App Configuration Token (`apps.manifest.create`): the agent's name, its bot, the agent view and the bot scopes, with no event subscriptions yet. The app is recorded as `creating` before Slack is asked; its signing and client secrets are stored by the server under the app and never returned. Asking again for an agent that has its app returns the same app with `created: false`. If Slack's answer was lost the app stays `creating` and the next request answers 409 SLACK_APP_CREATING; once `uncertain`, check api.slack.com/apps, delete any app made then, and retry with `replace_uncertain: true`. `warnings` says when the config token now belongs to another Slack user than the one who made the workspace's previous app (`config_token_issuer_changed`), and, as on GET, when the active release cannot start a session (`profile_unavailable`, `repository_required`); none stops the request. The agent needs an active release. Installing it into Slack starts at `POST /v1/agents/{id}/slack/install/start`. Owners, admins and the agent's admins from a signed-in console; API keys are refused.",
    auth: "session",
    body: "CreateSlackAppRequest",
    requestExample: { replace_uncertain: false },
    success: {
      status: 200,
      schema: "CreateSlackAppResponse",
      description:
        "The agent's app, whether this request created it, and any warnings.",
      example: {
        slack_app: EXAMPLE_SLACK_APP,
        created: true,
        warnings: [],
      },
    },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: {
      409: [
        "AGENT_NOT_ACTIVE",
        "CONFIG_TOKEN_INVALID",
        "SLACK_APP_CREATING",
        "REVISION_CONFLICT",
      ],
    },
    errorNotes: {
      REVISION_CONFLICT: "Here: the agent's app is being deleted.",
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY) or SLACK_OIDC_REDIRECT_URI, when Slack refused the manifest (`error.details.slack_error`; nothing was created) or could not be reached.",
    },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/agents/{id}/slack/install/start",
    operationId: "startSlackInstall",
    tag: "Agents",
    summary: "Get a single-use link that installs the agent's Slack app",
    description: `Returns Slack's consent URL for the agent's app with a new OAuth \`state\`, valid ${SLACK_INSTALL_STATE_TTL_SECONDS / 60} minutes; every call makes another. The state is bound to the caller, the workspace, the agent and the app, and only that caller can complete it (\`POST /v1/slack/install/complete\`). The app must be \`created\`: none answers 404, one still being created 409 SLACK_APP_CREATING, one being deleted 409 REVISION_CONFLICT. The Slack team it must be installed in is the one the workspace's App Configuration Token belongs to (409 CONFIG_TOKEN_INVALID when none is set). Owners, admins and the agent's admins from a signed-in console; API keys are refused.`,
    auth: "session",
    success: {
      status: 200,
      schema: "StartSlackInstallResponse",
      description: "Where the browser goes next, and when the link expires.",
      example: {
        authorize_url: `${EXAMPLE_SLACK_AUTHORIZE_URL}&state=<single-use>`,
        expires_at: "2026-10-24T09:10:00Z",
      },
    },
    errors: [401, 403, 404, 409, 503],
    errorCodes: {
      409: ["SLACK_APP_CREATING", "REVISION_CONFLICT", "CONFIG_TOKEN_INVALID"],
    },
    errorNotes: {
      REVISION_CONFLICT: "Here: the agent's app is being deleted.",
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY).",
    },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/slack/install/complete",
    operationId: "completeSlackInstall",
    tag: "Agents",
    summary: "Finish installing an agent's Slack app with what Slack returned",
    description:
      "The console's callback page sends the `state` and the `code` (or Slack's `error`) from Slack's redirect, with the agent it is for. The state is spent first, whatever happens next: unknown, spent, expired, or issued to another caller, workspace, agent or app answers 409 SLACK_INSTALL_STATE_INVALID with `error.details.reason_code`. An `error` from Slack (e.g. `access_denied`) answers 409 SLACK_INSTALL_DENIED. The code is exchanged with `oauth.v2.access`; unless the answer names the agent's app, the workspace's Slack team, no enterprise install and every bot scope, nothing is stored (409 SLACK_INSTALL_REJECTED). Then the bot token is sealed under the app (never returned), the install is verified with the token itself (`auth.test` and `bots.info`), the agent's identity is linked, and the steps after an install run; `finalized: false` says those failed and the install stands. Installing again with a new link replaces the bot token and keeps the one install. Every answer carries `Referrer-Policy: no-referrer`. Owners, admins and the agent's admins from a signed-in console; API keys are refused. A new identity writes a `link_agent_identity` receipt.",
    auth: "session",
    body: "CompleteSlackInstallRequest",
    requestExample: {
      agent_id: EXAMPLE_AGENT_ID,
      state: "state-from-the-redirect",
      code: "code-from-the-redirect",
    },
    success: {
      status: 200,
      schema: "CompleteSlackInstallResponse",
      description:
        "The app, its verified install, the agent's identity and whether the steps after the install ran.",
      example: {
        slack_app: {
          ...EXAMPLE_SLACK_APP,
          secrets: {
            ...EXAMPLE_SLACK_APP.secrets,
            slack_bot_token: {
              configured: true,
              last4: "a1b2",
              updated_at: "2026-10-24T09:05:00Z",
              updated_by: null,
            },
          },
        },
        installation: {
          id: "3c5e7a9b-1d2f-4a6b-8c0d-2e4f6a8b0c1d",
          app_id: EXAMPLE_SLACK_APP.app_id,
          team_id: "T0A1B2C3D",
          bot_user_id: "U0B1C2D3E",
          status: "verified",
        },
        agent_identity: {
          id: "5e7a9c1b-3d4f-4b6c-8d0e-4f6a8b0c2d3e",
          agent_id: EXAMPLE_AGENT_ID,
          provider: "slack_bot",
          app_id: EXAMPLE_SLACK_APP.app_id,
          team_id: "T0A1B2C3D",
          bot_user_id: "U0B1C2D3E",
          credential_ref: `slack_app:${EXAMPLE_SLACK_APP.id}/slack_bot_token`,
          status: "active",
          revision: 1,
          created_by: "7a9c1e3b-5d6f-4c8d-9e0f-6a8b0c2d4e5f",
          created_at: "2026-10-24T09:05:00Z",
          revoked_at: null,
        },
        receipt_id: "9c1e3a5b-7d8f-4e0a-8b1c-8b0c2d4e6f7a",
        finalized: true,
        warnings: [],
      },
    },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: {
      409: [
        "SLACK_INSTALL_STATE_INVALID",
        "SLACK_INSTALL_DENIED",
        "SLACK_INSTALL_REJECTED",
        "SLACK_INSTALL_CONFLICT",
        "AGENT_IDENTITY_TAKEN",
        "CREDENTIAL_REF_IN_USE",
        "REVISION_CONFLICT",
      ],
    },
    errorNotes: {
      REVISION_CONFLICT:
        "Here: the agent's app changed, or the install was revoked, while it was being installed; start again.",
      BACKEND_UNAVAILABLE:
        "Also when the API runs without a master key (PLATFORM_SECRET_KEY), or Slack could not be reached; start again.",
    },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/slack/events/{agent_id}",
    operationId: "receiveSlackEvent",
    tag: "Agents",
    summary: "Slack's Events API request URL for one agent's app",
    description:
      "Called by Slack, not by people: each agent app's event subscription points here (Finalize registers it when SLACK_EVENTS_PUBLIC_URL is set). The body is read up to 256 KiB (413 above that), then checked in this order: the `v0` signature (`X-Slack-Signature`) over the raw bytes with the app's signing secret, the `X-Slack-Request-Timestamp` within 300 seconds, then the JSON. An unknown agent, an agent without a created app, an app without a signing secret, a wrong, missing or stale signature all answer the same 401. A signed `url_verification` answers its `challenge`. An `event_callback` is stored once per `(team_id, event_id)`, so Slack's retries (`X-Slack-Retry-Num`) answer 200 without a second row; one for another app or team than the agent's install, from a bot, or of a message subtype other than `thread_broadcast`, is stored as dropped with its reason. `app_uninstalled` and `tokens_revoked` mark the install revoked. Any other envelope type answers 200 and is ignored. A failed write answers 5xx so Slack sends the event again. Rate limited per agent and overall before any database read (429).",
    auth: "public",
    body: "SlackEventEnvelope",
    requestExample: {
      token: "legacy-verification-token",
      team_id: "T0A1B2C3D",
      api_app_id: EXAMPLE_SLACK_APP.app_id,
      event: {
        type: "app_mention",
        user: "U0PERSON1",
        text: "<@U0B1C2D3E> summarize this thread",
        channel: "C0CHANNEL1",
        ts: "1761300000.000100",
      },
      type: "event_callback",
      event_id: "Ev0A1B2C3D4E",
      event_time: 1761300000,
    },
    success: {
      status: 200,
      schema: "SlackEventsResponse",
      description:
        '`{"challenge": ...}` for a url_verification, `{"ok": true}` for everything else that was signed.',
      example: { ok: true },
    },
    errors: [400, 401, 413, 429, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/api-keys",
    operationId: "createApiKey",
    tag: "API keys",
    summary: "Issue a personal key or an agent key",
    description:
      "A personal key is the caller's own; an agent key names its agent in `agent_id` and takes an owner, an admin, or that agent's admin. No key reaches a whole workspace: an agent key without `agent_id` is a 400. `name` (1-64 characters once trimmed) is optional. `scopes` may not exceed what the caller holds now, and an agent key never holds `sessions:approve` (403 SCOPE_NOT_GRANTABLE). An API key never issues one. The secret is returned once; only its sha256 is stored. Writes a `create_api_key` receipt.",
    auth: "session",
    body: "CreateApiKeyRequest",
    success: { status: 201, schema: "CreateApiKeyResponse" },
    errors: [400, 401, 403, 404, 413, 503],
    errorCodes: { 403: ["FORBIDDEN", "SCOPE_NOT_GRANTABLE"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/api-keys",
    operationId: "listApiKeys",
    tag: "API keys",
    summary: "The caller's personal keys and the agent keys they manage",
    description:
      "Owners and admins see every agent key; an agent's admin sees that agent's keys. Who sees which agent keys is read from the caller's role on every page, so a page read after a role change follows the new role. Newest `created_at` first, `limit` per page (default 50, at most 100). Pass `next_cursor` back as `cursor` for the next page; it is null on the last one. A cursor that does not decode to a position in that order answers 400; a cursor only positions the read, so one from another workspace shows nothing of it. Secrets are never returned.",
    auth: "session",
    query: "ListApiKeysQuery",
    success: { status: 200, schema: "ListApiKeysResponse" },
    errors: [400, 401, 403, 503],
  },
  {
    method: "delete",
    path: "/v1/api-keys/{id}",
    operationId: "revokeApiKey",
    tag: "API keys",
    summary: "Revoke a key",
    description:
      "Takes the right issuing that kind of key takes. Revoking a key already revoked changes nothing and answers a null `receipt_id`; otherwise writes a `revoke_api_key` receipt.",
    auth: "session",
    success: { status: 200, schema: "RevokeApiKeyResponse" },
    errors: [401, 403, 404, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/teams",
    operationId: "createTeam",
    tag: "Teams",
    summary: "Create a team",
    description:
      "Owners and admins (`team.manage`). A live team's name is unique in its workspace (409 ALREADY_EXISTS). Writes a `create_team` receipt.",
    auth: "session",
    body: "CreateTeamRequest",
    success: { status: 201, schema: "TeamChangeResponse" },
    errors: [400, 401, 403, 409, 413, 503],
    errorCodes: { 409: ["ALREADY_EXISTS"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/teams",
    operationId: "listTeams",
    tag: "Teams",
    summary: "The workspace's teams, by name",
    description: `Owners and admins. Archived teams are left out. \`q\` keeps the teams whose name contains it, ignoring case. ${TEAM_PAGES}`,
    auth: "session",
    query: "ListTeamsQuery",
    success: { status: 200, schema: "ListTeamsResponse" },
    errors: [400, 401, 403, 503],
  },
  {
    method: "get",
    path: "/v1/my-teams",
    operationId: "listMyTeams",
    tag: "Teams",
    summary: "The teams the caller belongs to",
    description: `Any signed-in person, as of this request: each team's id and name, never who else is in it. ${TEAM_PAGES}`,
    auth: "session",
    query: "ListMyTeamsQuery",
    success: {
      status: 200,
      schema: "ListMyTeamsResponse",
      description: "The caller's live teams, by name.",
      example: {
        items: [
          {
            id: "019a0000-0000-7000-8000-00000000b0a1",
            name: "research admins",
          },
        ],
        next_cursor: null,
      },
    },
    errors: [400, 401, 403, 503],
  },
  {
    method: "get",
    path: "/v1/teams/{team_id}",
    operationId: "getTeam",
    tag: "Teams",
    summary: "A team and its members",
    description:
      "An owner or an admin reads any team. Anyone else reads only a team they are in now, read only: changing it stays with owners and admins. Any other team is 403.",
    auth: "session",
    success: { status: 200, schema: "TeamDetail" },
    errors: [401, 403, 404, 503],
  },
  {
    method: "patch",
    path: "/v1/teams/{team_id}",
    operationId: "updateTeam",
    tag: "Teams",
    summary: "Rename a team",
    description:
      "Writes a `rename_team` receipt unless the name is unchanged (`receipt_id` null).",
    auth: "session",
    body: "UpdateTeamRequest",
    success: { status: 200, schema: "TeamChangeResponse" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["ALREADY_EXISTS"] },
    idempotent: false,
  },
  {
    method: "delete",
    path: "/v1/teams/{team_id}",
    operationId: "deleteTeam",
    tag: "Teams",
    summary: "Delete a team",
    description:
      "Every agent the team administered loses it from the next request on; its members keep whatever they hold on their own. Writes a `delete_team` receipt.",
    auth: "session",
    success: { status: 200, schema: "DeleteTeamResponse" },
    errors: [401, 403, 404, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/teams/{team_id}/members",
    operationId: "addTeamMember",
    tag: "Teams",
    summary: "Add a member of the workspace to a team",
    description:
      "No invite and no acceptance: the person is a member of the team at once. A disabled member is not found. Writes an `add_team_member` receipt naming the person, unless they already were in (`receipt_id` null).",
    auth: "session",
    body: "AddTeamMemberRequest",
    success: { status: 200, schema: "TeamChangeResponse" },
    errors: [400, 401, 403, 404, 413, 503],
    idempotent: false,
  },
  {
    method: "delete",
    path: "/v1/teams/{team_id}/members/{user_id}",
    operationId: "removeTeamMember",
    tag: "Teams",
    summary: "Take a member out of a team",
    description:
      "What the person held through the team ends from their next request. Writes a `remove_team_member` receipt naming the person, unless they were not in (`receipt_id` null).",
    auth: "session",
    success: { status: 200, schema: "TeamChangeResponse" },
    errors: [401, 403, 404, 503],
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/agents/{id}/admins",
    operationId: "listAgentAdmins",
    tag: "Agents",
    summary: "The people and teams who administer an agent",
    description:
      "Owners, admins and the agent's own admins (`agent.admin.manage`).",
    auth: "session",
    success: { status: 200, schema: "AgentAdmins" },
    errors: [401, 403, 404, 503],
  },
  {
    method: "post",
    path: "/v1/agents/{id}/admins",
    operationId: "addAgentAdmin",
    tag: "Agents",
    summary: "Name a person or a team an agent's admin",
    description:
      "Owners, admins and the agent's own admins. A team's members administer the agent while they are in it. Writes an `add_agent_admin` receipt unless they already were one (`receipt_id` null).",
    auth: "session",
    body: "AddAgentAdminRequest",
    success: { status: 200, schema: "AgentAdminChangeResponse" },
    errors: [400, 401, 403, 404, 413, 503],
    idempotent: false,
  },
  {
    method: "delete",
    path: "/v1/agents/{id}/admins/{kind}/{subject_id}",
    operationId: "removeAgentAdmin",
    tag: "Agents",
    summary: "Stop a person or a team administering an agent",
    description:
      "`kind` is `users` or `teams`. Writes a `remove_agent_admin` receipt unless they were not one (`receipt_id` null).",
    auth: "session",
    success: { status: 200, schema: "AgentAdminChangeResponse" },
    errors: [401, 403, 404, 503],
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/administered-agents",
    operationId: "listAdministeredAgents",
    tag: "Agents",
    summary: "The agents the caller administers",
    description:
      "Directly or through a team, as of this request: what an agent's admin needs to issue that agent's own key.",
    auth: "session",
    success: { status: 200, schema: "ListAdministeredAgentsResponse" },
    errors: [401, 403, 503],
  },
  {
    method: "get",
    path: "/v1/profiles",
    operationId: "listProfiles",
    tag: "Agents",
    summary: "The runtime profiles this workspace can run",
    description:
      "Lists the profiles a session's `profile_id` or a release's `runtime_profile_id` may name, by `id`: the installation ceilings (`source: operator`, imported from `profiles.yaml` or saved by the operator, each with an `installation` object) and the caller's workspace's (`source: workspace`, ids starting `ws_`), each with the models it offers, its tools, permission mode and `repository_mode`: whether a session of it names a repository (`required`), may (`optional`) or never does (`none`). Every ceiling and every workspace version is listed with its state (`installation.state`, `workspace.state`); only `usable` takes a new release or session. A profile's provider endpoint and credential are not included.",
    scope: "read",
    success: {
      status: 200,
      schema: "ListProfilesResponse",
      description:
        "The operator's profiles ordered by `id`, then the workspace's.",
      example: {
        items: [
          {
            id: "claude-coding-real",
            source: "operator",
            model: "claude-sonnet-5",
            models: ["claude-sonnet-5", "claude-haiku-5"],
            tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
            permission_mode: "acceptEdits",
            runtime_kind: "claude_agent_sdk",
            runtime_version: "0.3.270",
            billing: "metered",
            repository_mode: "required",
          },
          INSTALLATION_PROFILE_EXAMPLE,
          WORKSPACE_PROFILE_EXAMPLE,
        ],
      },
    },
    errors: [401, 503],
  },
  {
    method: "post",
    path: "/v1/workspace-profiles",
    operationId: "createWorkspaceProfile",
    tag: "Agents",
    summary: "Save a new version of a workspace profile",
    description:
      "Owners and admins (`workspace.manage`), signed in. Narrows the operator profile `base_profile_id`: `models` and `tools` are subsets of the base's, and `permission_mode` the base's or one that leaves more to a person. Anything wider is 400 with `details.field`. Each save makes the next version of `name` with a new id (`ws_<workspace slug>_<name>_v<n>`); earlier versions, and what already runs on them, stay as they were. Two saves of one name at once: the second is 409 REVISION_CONFLICT, and saving again makes the version after. Writes a `create_workspace_profile` receipt.",
    auth: "session",
    body: "CreateWorkspaceProfileRequest",
    requestExample: {
      name: "strict-review",
      base_profile_id: "claude-coding-real",
      model: "claude-sonnet-5",
      models: ["claude-sonnet-5"],
      tools: ["Read", "Glob", "Grep"],
      permission_mode: "default",
    },
    success: {
      status: 201,
      schema: "WorkspaceProfileChangeResponse",
      description: "The version saved, and its receipt.",
      example: {
        profile: WORKSPACE_PROFILE_EXAMPLE,
        receipt_id: "019a0000-0000-7000-8000-0000000000e1",
      },
    },
    errors: [400, 401, 403, 409, 413, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/workspace-profiles/{profile_id}/retire",
    operationId: "retireWorkspaceProfile",
    tag: "Agents",
    summary: "Retire a version of a workspace profile",
    description:
      "Owners and admins (`workspace.manage`), signed in. A retired version takes no new release and no new session of a new release; releases and sessions already on it keep running. Retiring one already retired changes nothing and answers a null `receipt_id`; otherwise writes a `retire_workspace_profile` receipt. Another workspace's version is 404.",
    auth: "session",
    success: {
      status: 200,
      schema: "WorkspaceProfileChangeResponse",
      description: "The version as retired.",
      example: {
        profile: {
          ...WORKSPACE_PROFILE_EXAMPLE,
          workspace: {
            ...WORKSPACE_PROFILE_EXAMPLE.workspace,
            state: "retired",
            retired_at: "2026-10-28T01:00:00.000Z",
          },
        },
        receipt_id: "019a0000-0000-7000-8000-0000000000e2",
      },
    },
    errors: [401, 403, 404, 503],
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/installation-profiles/options",
    operationId: "getInstallationProfileOptions",
    tag: "Agents",
    summary: "What a new installation ceiling may name",
    description:
      "The operator (`profile.installation.manage`, the workspace owner), signed in. The installation's connections by id, `kind` and `billing` (never an endpoint or a credential reference), the installed runtimes with the permission modes each accepts, the catalog repositories, and whether `PLATFORM_ALLOW_UNATTENDED_PERMISSIONS` lets a ceiling run `bypassPermissions` here.",
    auth: "session",
    success: {
      status: 200,
      schema: "InstallationProfileOptionsResponse",
      description: "What a new ceiling may name on this installation.",
      example: {
        connections: [
          { id: "anthropic-main", kind: "anthropic", billing: "metered" },
        ],
        runtimes: [
          {
            runtime_kind: "claude_agent_sdk",
            permission_modes: [
              "default",
              "acceptEdits",
              "dontAsk",
              "plan",
              "bypassPermissions",
              "auto",
            ],
          },
        ],
        repositories: [{ id: "sample-app" }],
        unattended_allowed: false,
      },
    },
    errors: [401, 403, 503],
  },
  {
    method: "post",
    path: "/v1/installation-profiles",
    operationId: "createInstallationProfile",
    tag: "Agents",
    summary: "Save a new version of an installation ceiling",
    description:
      "The operator (`profile.installation.manage`, the workspace owner), signed in; an API key is 403 whatever its scopes. Saves the next version of `name` with a new id (`op_<name>_v<n>`) on the connection `connection_id`, whose provider the server copies in; earlier versions, and the workspace profiles and releases on them, stay as they were. A new version of an existing name sends that name's latest id as `previous_id`; anything else is 409 REVISION_CONFLICT (`details.reason_code: stale_previous`, `details.latest_id`), as is the second of two saves at once. A first version may name the ceiling it replaces in `previous_id` (400 `unknown_previous` when there is none). 400 `details.reason_code`: `unknown_connection`, `runtime_not_installed`, `unattended_not_allowed` (`bypassPermissions` while `PLATFORM_ALLOW_UNATTENDED_PERMISSIONS` is not `true`), `unknown_repository`, `model_not_in_models` or `invalid_profile`, each with `details.field`. 409 `details.reason_code: id_taken` when the id is already an imported profile's. A ceiling runs against its `repository_ids` and no other repository. Writes a `create_installation_profile` receipt.",
    auth: "session",
    body: "CreateInstallationProfileRequest",
    requestExample: {
      name: "coding",
      connection_id: "anthropic-main",
      runtime_kind: "claude_agent_sdk",
      runtime_version: "0.3.270",
      model: "claude-sonnet-5",
      models: ["claude-sonnet-5", "claude-haiku-5"],
      title_model: "claude-haiku-5",
      tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
      permission_mode: "acceptEdits",
      project_settings: { claude_md: true },
      repository_mode: "required",
      repository_ids: ["sample-app"],
      previous_id: "op_coding_v1",
    },
    success: {
      status: 201,
      schema: "WorkspaceProfileChangeResponse",
      description: "The ceiling saved, and its receipt.",
      example: {
        profile: INSTALLATION_PROFILE_EXAMPLE,
        receipt_id: "019a0000-0000-7000-8000-0000000000e3",
      },
    },
    errors: [400, 401, 403, 409, 413, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/installation-profiles/{profile_id}/retire",
    operationId: "retireInstallationProfile",
    tag: "Agents",
    summary: "Retire an installation ceiling",
    description:
      "The operator (`profile.installation.manage`, the workspace owner), signed in. Any ceiling, imported or saved in the console. A retired ceiling takes no new release, no session without a release and no new workspace profile over it, and a workspace profile over it reads `base_retired`; releases already made on either, and their sessions, keep running. Retiring one already retired changes nothing and answers a null `receipt_id`; otherwise writes a `retire_installation_profile` receipt.",
    auth: "session",
    success: {
      status: 200,
      schema: "WorkspaceProfileChangeResponse",
      description: "The ceiling as retired.",
      example: {
        profile: {
          ...INSTALLATION_PROFILE_EXAMPLE,
          installation: {
            ...INSTALLATION_PROFILE_EXAMPLE.installation,
            state: "retired",
            retired_by: "019a0000-0000-7000-8000-0000000000b1",
            retired_at: "2026-10-28T02:00:00.000Z",
          },
        },
        receipt_id: "019a0000-0000-7000-8000-0000000000e4",
      },
    },
    errors: [401, 403, 404, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/installation-profiles/{profile_id}/block",
    operationId: "blockInstallationProfile",
    tag: "Agents",
    summary: "Block an installation ceiling",
    description:
      "The operator (`profile.installation.manage`, the workspace owner), signed in. Stops everything on one ceiling, imported or saved in the console, within a second on every replica: it reads `blocked` and the workspace profiles over it `base_blocked`; new releases, sessions (with a release or without) and workspace profiles on either are refused; a session waiting for its next turn fails at its next claim (`catalog_mismatch`, its input kept); a running turn loses its provider and repository access at the egress proxy's next regrant. Unblocking lets it run again but revives no failed session. Blocking one already blocked changes nothing and answers a null `receipt_id`; otherwise writes a `block_installation_profile` receipt.",
    auth: "session",
    success: {
      status: 200,
      schema: "WorkspaceProfileChangeResponse",
      description: "The ceiling as blocked.",
      example: {
        profile: {
          ...INSTALLATION_PROFILE_EXAMPLE,
          installation: {
            ...INSTALLATION_PROFILE_EXAMPLE.installation,
            state: "blocked",
            blocked_by: "019a0000-0000-7000-8000-0000000000b1",
            blocked_at: "2026-10-28T03:00:00.000Z",
          },
        },
        receipt_id: "019a0000-0000-7000-8000-0000000000e5",
      },
    },
    errors: [401, 403, 404, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/installation-profiles/{profile_id}/unblock",
    operationId: "unblockInstallationProfile",
    tag: "Agents",
    summary: "Unblock an installation ceiling",
    description:
      "The operator (`profile.installation.manage`, the workspace owner), signed in. The ceiling returns to the state it would have without the block (`usable`, or `retired` when it was retired); sessions failed while it was blocked stay failed. Unblocking one not blocked changes nothing and answers a null `receipt_id`; otherwise writes an `unblock_installation_profile` receipt.",
    auth: "session",
    success: {
      status: 200,
      schema: "WorkspaceProfileChangeResponse",
      description: "The ceiling as unblocked.",
      example: {
        profile: INSTALLATION_PROFILE_EXAMPLE,
        receipt_id: "019a0000-0000-7000-8000-0000000000e6",
      },
    },
    errors: [401, 403, 404, 503],
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/limits",
    operationId: "getInstallationLimits",
    tag: "Limits & receipts",
    summary: "Installation limits and installation-wide usage",
    description:
      "Reads the limits this installation runs under (execution slots, queued input per session, storage, turn length, per-session cost and token limits, provider retries) and the usage against the installation-wide ones, summed over every owner. Use it to explain `STORAGE_LIMIT_EXCEEDED`, a full input queue, or sessions waiting in `queued` for a slot. `usage.outputs` is the bytes of session outputs kept in the object store, shown beside storage and never enforced.\n\nWithout `scope`, or with `scope=installation`, only the workspace owner, signed in, reads it: any other member and every API key get 403.\n\n`scope=me` gives any signed-in member the per-session limits alone (`queued_input_limit_per_session`, `max_turn_seconds`, `session_cost_limit_usd`, `session_token_limit`), with no `usage`; an API key gets 403. It changes nothing.",
    scope: "read",
    query: "LimitsQuery",
    success: {
      status: 200,
      schema: "LimitsResponse",
      description: "The limits and usage as of `refreshed_at`.",
      example: {
        scope: "installation",
        refreshed_at: "2026-10-11T08:15:43Z",
        limits: {
          execution_slot_limit: 4,
          queued_input_limit_per_session: 20,
          storage_limit_bytes: 1073741824,
          max_turn_seconds: 3600,
          session_cost_limit_usd: "20",
          session_token_limit: null,
          provider_max_retries: 2,
        },
        usage: {
          execution_slots_used: 1,
          queued_input_count: 3,
          storage: {
            used_bytes: 524288,
            accounted_content: ["input_messages"],
            updated_at: "2026-10-11T08:14:00Z",
          },
          outputs: {
            used_bytes: 3145728,
            updated_at: "2026-10-11T08:12:30Z",
            complete: true,
          },
        },
      },
    },
    errors: [400, 401, 503],
  },
  {
    method: "get",
    path: "/v1/usage/summary",
    operationId: "getUsageSummary",
    tag: "Limits & receipts",
    summary: "Cost, tokens and run time of the sessions created in a period",
    description:
      "Adds up the sessions created in `[since, until)`: how many, their estimated provider cost, their tokens, and how long their turns ran. `since` and `until` take a date (`2026-10-01`, that day's 00:00 UTC) or a timestamp with an offset, which is moved to UTC; without `until` the period ends when the figures are read, so `since` must then be in the past.\n\n- `scope=me`: the sessions the caller started. A personal API key counts as the person who created it; a key nobody created counts the sessions it started itself. Sessions shared with the caller are not added. A key bound to an agent gets 403, as it does from `GET /v1/sessions`.\n- `scope=installation`: every session of every owner. Only the workspace owner, signed in, reads it: any other member and every API key get 403.\n- `scope=agent` with `agent_id`: the sessions started from any release of that agent, whoever started them. The workspace's owner and admins and the agent's admins read it; anyone else, and every API key, gets 403, and an agent of another workspace, or none, is 404 for everyone. `agent_id` is required with it and refused with any other scope, and `group_by` is refused with it.\n\n`cost_usd` is the sum of `cost.amount_usd` from `GET /v1/sessions/{id}/usage` over the same sessions: an estimate, not a bill. `cost_complete: false` means one of them has a turn still open or one that ended without reporting its cost, so the true total is unknown. `run_seconds` is wall-clock turn time, waiting for an answer included; an open turn counts up to `refreshed_at`. Sessions from before tokens were metered count 0 tokens.\n\n`group_by=agent`, `group_by=user` or `group_by=profile` adds `groups`: the same sessions, each once, under its agent, the user holding it or the session's current profile (`sessions.profile_id`; a session that changed profile counts whole under the one it has now), largest cost first, read in the same statement as the totals. The groups' `session_count`, `cost_usd` and `run_seconds` add up to the totals (`run_seconds` is the floor of the running total minus the floor of the one before it, so two groups of 1.5 seconds read 1 and 2), and `cost_complete` is false when any group's is. `id` is the agent id, user id or profile id; it is null for sessions without an agent or a profile, or started by a key no person created. `name` is the agent's name, the user's display name (never an email) or, as profiles have no display name, the profile id; under `scope=me` a user other than the caller is null. Without `group_by` there is no `groups`. It changes nothing.",
    scope: "read",
    query: "UsageSummaryQuery",
    success: {
      status: 200,
      schema: "UsageSummaryResponse",
      description: "The figures as of `refreshed_at`.",
      example: {
        scope: "me",
        period: {
          since: "2026-10-01T00:00:00.000Z",
          until: "2026-10-11T08:15:43.000Z",
        },
        refreshed_at: "2026-10-11T08:15:43.000Z",
        session_count: 12,
        cost_usd: "3.218400",
        cost_complete: false,
        token_count: 1824500,
        run_seconds: 5410,
        basis: {
          sessions: "created_in_period",
          cost: "provider_usage_estimate",
          run_time: "turn_wall_clock",
        },
      },
    },
    errors: [400, 401, 404, 503],
  },
  {
    method: "get",
    path: "/v1/usage/series",
    operationId: "getUsageSeries",
    tag: "Limits & receipts",
    summary: "The usage summary of a period, one bucket per UTC day",
    description:
      "Splits `GET /v1/usage/summary` by the UTC day each session was created on: one bucket per day the period `[since, until)` touches, oldest first, days without sessions included. `scope`, `since`, `until` and who may read which scope are exactly the summary's; the period spans at most 366 days. `bucket` is `day`, the only size.\n\nThe buckets of one response add up to the summary of the same period: `session_count`, `cost_usd` and `token_count` sum, and `cost_complete` is false on a day whose sessions include one the summary would mark incomplete. `run_seconds` is the floor of the running total of turn time minus the floor of the one before it, so two days of 0.6 seconds read 0 and 1, as the summary reads 1. A long session's cost and time count on the day it started. It changes nothing.",
    scope: "read",
    query: "UsageSeriesQuery",
    success: {
      status: 200,
      schema: "UsageSeriesResponse",
      description: "The buckets as of `refreshed_at`.",
      example: {
        period: {
          since: "2026-10-09T00:00:00.000Z",
          until: "2026-10-11T08:15:43.000Z",
        },
        refreshed_at: "2026-10-11T08:15:43.000Z",
        buckets: [
          {
            date: "2026-10-09",
            session_count: 5,
            cost_usd: "1.204100",
            cost_complete: true,
            token_count: 702300,
            run_seconds: 2210,
          },
          {
            date: "2026-10-10",
            session_count: 0,
            cost_usd: "0",
            cost_complete: true,
            token_count: 0,
            run_seconds: 0,
          },
          {
            date: "2026-10-11",
            session_count: 2,
            cost_usd: "0.381000",
            cost_complete: false,
            token_count: 154200,
            run_seconds: 640,
          },
        ],
      },
    },
    errors: [400, 401, 503],
  },
  {
    method: "get",
    path: "/v1/usage/breakdown",
    operationId: "getUsageBreakdown",
    tag: "Limits & receipts",
    summary: "The usage summary of a period by model or by agent",
    description:
      "Groups the sessions `GET /v1/usage/summary` adds up by the model their metered calls named (`by=model`) or by their agent (`by=agent`), largest cost first, with the input, output, cache read and cache write tokens of those calls. `scope`, `since`, `until` and who may read which scope are exactly the summary's; the period spans at most 366 days.\n\n`token_count` is the four token columns' sum; the 1-hour cache writes are inside `cache_creation_input_tokens`. `totals` is the summary of the same period: its `session_count`, `token_count` and `cost_usd` equal it.\n\n- `by=agent`: each session counts once under its agent (`key` is the agent id, `label` its name), so the rows add up to `totals` in every column. Sessions without an agent are the row whose `key` and `label` are null.\n- `by=model`: a session counts under every model it called, so the rows' `session_count` may add up to more than the totals'. A session's cost its metered calls do not explain, such as an engine's turn totals from before proxy metering, is the row whose `key` and `label` are null, with no tokens.\n\nIt changes nothing.",
    scope: "read",
    query: "UsageBreakdownQuery",
    success: {
      status: 200,
      schema: "UsageBreakdownResponse",
      description: "The groups and their totals; this example is `by=model`.",
      example: {
        rows: [
          {
            key: "claude-opus-5-5",
            label: "claude-opus-5-5",
            session_count: 9,
            input_tokens: 182000,
            output_tokens: 64000,
            cache_read_input_tokens: 1210000,
            cache_creation_input_tokens: 96000,
            token_count: 1552000,
            cost_usd: "2.811000",
          },
          {
            key: null,
            label: null,
            session_count: 1,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            token_count: 0,
            cost_usd: "0.407400",
          },
        ],
        totals: {
          session_count: 10,
          input_tokens: 182000,
          output_tokens: 64000,
          cache_read_input_tokens: 1210000,
          cache_creation_input_tokens: 96000,
          token_count: 1552000,
          cost_usd: "3.218400",
        },
      },
    },
    errors: [400, 401, 503],
  },
  {
    method: "get",
    path: "/v1/usage/tools",
    operationId: "getUsageTools",
    tag: "Limits & receipts",
    summary: "Calls, failures and time per tool in a period",
    description:
      "Counts the tool calls whose `tool_use` event was stored in `[since, until)`, per tool name, the most-called first and at most 200 names. `scope`, `since` and `until` work as in `GET /v1/usage/summary`; `agent_id` narrows to the sessions pinned to a release of that agent. Subagent calls count too.\n\nA call is timed from its `tool_use` to the `tool_result` paired with it in the same session and attempt by `tool_use_id`. A call with no result yet, or with either event's time missing, counts in `calls` but in no `_ms` figure. `failed` counts results with `is_error: true`; a result without `is_error` is a success, and one whose `is_error` is not a boolean is neither. `median_ms` is read from a histogram: the middle call's time, or the mean of the two middle calls' for an even count, each read within 5% or 1 ms, except that a call of about 65 minutes or more reads as about 65 minutes, so a median that takes in such a call reads low. It is never above `max_ms`. Over whole UTC days `max_ms` is the largest time a call has had: if an earlier result later replaces a call's time, it does not come down there. Figures come from a table the reconciler fills on each pass, so a call shows up within one pass of being stored, usually seconds. Each finding names a row of `tools`: `most_time` the largest `total_ms`, `fails_often` the highest `failed / calls`, `slowest` the largest `median_ms`; a kind no tool qualifies for is left out. `description` is the line an MCP server gave its tool when a session in the same scope started, the newest such session's, redacted, on one line and at most 200 characters; built-in tools, and tools no session in scope described, have `null`. The response names tools and figures only, never a session. It changes nothing.",
    scope: "read",
    query: "UsageToolsQuery",
    success: {
      status: 200,
      schema: "UsageToolsResponse",
      description: "The tools called in the period.",
      example: {
        tools: [
          {
            name: "Bash",
            calls: 1840,
            failed: 21,
            total_ms: 13320000,
            median_ms: 3100,
            max_ms: 298000,
            description: null,
          },
          {
            name: "mcp__linear__get_issue",
            calls: 702,
            failed: 12,
            total_ms: 1620000,
            median_ms: 900,
            max_ms: 14200,
            description: "Retrieve detailed information about an issue by ID",
          },
        ],
        findings: [
          { kind: "most_time", name: "Bash" },
          { kind: "fails_often", name: "mcp__linear__get_issue" },
          { kind: "slowest", name: "Bash" },
        ],
      },
    },
    errors: [400, 401, 503],
  },
  {
    method: "get",
    path: "/v1/usage/tools/{name}/calls",
    operationId: "getUsageToolCalls",
    tag: "Limits & receipts",
    summary: "Recent or slowest calls of one tool, and its calls per day",
    description:
      "Lists the calls of the tool `name` whose `tool_use` event was stored in `[since, until)`, with the scopes, period and `agent_id` of `GET /v1/usage/tools`; the period spans at most 366 days. `sort=recent` (the default) lists the latest `occurred_at` first, `sort=slowest` the longest `duration_ms` first with untimed calls last; ties go to the later event. Read the next page with `next_cursor`, which is null on the last page; a cursor from the other sort is 400.\n\n`session_id` and `title` are null for a session the caller may not read (one in another owner, or private and not shared with the caller); the call's time, duration, outcome and agent still show. `agent` is null for a session made without an agent. `outcome` is `unknown` while no result is paired or when the result's `is_error` is not a boolean; `duration_ms` is null without a paired result or with either time missing, and set even when `outcome` is `unknown`. `per_day` counts the tool's calls on every UTC date the period touches, zeros included. Calls show up within one reconciler pass of being stored. It changes nothing.",
    scope: "read",
    query: "UsageToolCallsQuery",
    success: {
      status: 200,
      schema: "UsageToolCallsResponse",
      description: "One page of the tool's calls.",
      example: {
        calls: [
          {
            session_id: EXAMPLE_SESSION_ID,
            title: "Fix the flaky login test",
            agent: "Reviewer",
            occurred_at: "2026-10-24T09:14:03.120Z",
            duration_ms: 3120,
            outcome: "ok",
          },
          {
            session_id: null,
            title: null,
            agent: null,
            occurred_at: "2026-10-24T09:12:41.004Z",
            duration_ms: null,
            outcome: "unknown",
          },
        ],
        next_cursor:
          "eyJzb3J0IjoicmVjZW50IiwiYXQiOiIyMDI2LTEwLTI0IDA5OjEyOjQxLjAwNCswMCIsImlkIjo0MjEsIm9yZCI6MX0",
        per_day: [
          { date: "2026-10-23", calls: 0 },
          { date: "2026-10-24", calls: 2 },
        ],
      },
    },
    errors: [400, 401, 503],
  },
  {
    method: "get",
    path: "/v1/receipts/{id}",
    operationId: "getReceipt",
    tag: "Limits & receipts",
    summary: "Current outcome of an accepted command",
    description:
      "Reads the current outcome of a command by the `receipt_id` its response returned: `accepted` while it is in progress, then `succeeded`, `failed` (with `error`) or `unknown` (nobody can say; `error` explains). Poll until it leaves `accepted`. `result` depends on `operation`:\n\n- `create_session`, `append_message`: the acceptance response exactly as first returned, never rewritten. The turn's outcome is read from `GET /v1/sessions/{session_id}/turns/{turn_id}` using `target_ref`.\n- `interrupt`: `{turn_id, terminal, no_op}` once settled.\n- `pause`, `resume`: `{resulting_admission_state, checkpoint_revision, queued_turn_count}`.\n- `close`: `{resulting_admission_state, checkpoint_revision, cancelled_turn_count}`; `checkpoint_revision` is null only for a session that never ran a turn.\n- `terminate`: `{execution_gone, checkpoint_revision, unconfirmed_turn_id, external_effects_reverted}`.\n- `recovery_decision`: `{resulting_admission_state, checkpoint_revision, resumable}`.\n- `answer`: null; only `status` and `error` change.\n- `request_push`, `decide_push`, `push`: `{push_request_id, decision, verdict, refusal, repository_id, checkpoint_revision, git_commit, target_branch}`; `verdict` is `allow` or `refuse`, a refused attempt is `failed` with the reason in `refusal` and `error`, and fields the attempt never read are null. `actor` names who made it.\n- `open_pull_request`, `comment_pull_request`: `{push_request_id, verdict, refusal, repository_id, number, url, head, base, created}`, and for a comment also `{comment_id, comment_url, marker}`; `created` is false when the call answered an open pull request or edited the marked comment.\n- `set_slack_secret`, `delete_slack_secret`: `{purpose, last4}`; the value itself is never in a receipt.\n- `set_github_app`, `delete_github_app`: `{app_id}`; the private key is never in a receipt.\n\nAny credential of the same owner can read a receipt. It changes nothing.",
    scope: "read",
    success: {
      status: 200,
      schema: "Receipt",
      description: "The receipt as it stands now.",
      example: {
        id: EXAMPLE_RECEIPT_ID,
        operation: "pause",
        target_ref: {
          session_id: EXAMPLE_SESSION_ID,
          turn_id: null,
          request_id: null,
        },
        status: "succeeded",
        result: {
          resulting_admission_state: "paused",
          checkpoint_revision: 3,
          queued_turn_count: 1,
        },
        error: null,
        created_at: "2026-10-11T08:20:00Z",
        updated_at: "2026-10-11T08:20:09Z",
      },
    },
    errors: [401, 404, 503],
  },
] as const satisfies readonly RouteDeclaration[];

export const OPENAPI_COMPONENT_SCHEMAS: Record<ComponentName, z.ZodType> = {
  ...requestComponents,
  ...responseComponents,
};

export type ApiOperationId =
  (typeof API_ROUTE_DECLARATIONS)[number]["operationId"];

/**
 * The session scope each operation demands, as the API enforces it before
 * reading a body or a resource. Routes without a scope are the
 * probes, the public auth routes and cookie-only logout.
 */
export const DOCUMENTED_ROUTE_SCOPES: ReadonlyArray<{
  method: Uppercase<RouteDeclaration["method"]>;
  path: string;
  scope: SessionScope;
  checkedBy: "api" | "service";
}> = API_ROUTE_DECLARATIONS.flatMap((declaration) => {
  const route: RouteDeclaration = declaration;
  const scope = scopeOf(route);
  return scope
    ? [
        {
          method: route.method.toUpperCase() as Uppercase<
            RouteDeclaration["method"]
          >,
          path: route.path,
          scope,
          checkedBy: route.scopeCheckedBy ?? "api",
        },
      ]
    : [];
});

export const API_ROUTE_SCOPES = DOCUMENTED_ROUTE_SCOPES.filter(
  (route) => route.checkedBy === "api",
).map(({ method, path, scope }) => ({ method, path, scope }));

type JsonSchema = Record<string, unknown>;

function scopeOf(route: RouteDeclaration): SessionScope | undefined {
  return route.scope ? `sessions:${route.scope}` : undefined;
}

function securityFor(route: RouteDeclaration): Array<Record<string, string[]>> {
  if (route.auth === "public") return [];
  if (route.auth === "session") return [{ cookieSession: [] }];
  const scope = scopeOf(route);
  return scope ? [{ bearerApiKey: [scope] }, { cookieSession: [scope] }] : [];
}

function takesIdempotencyKey(route: RouteDeclaration): boolean {
  return route.method !== "get" && route.idempotent !== false;
}

function errorContext(route: RouteDeclaration): ErrorContext {
  return {
    scope: scopeOf(route),
    auth: route.auth ?? "any",
    csrf:
      route.csrf === "always"
        ? "always"
        : takesCookieMutation(route)
          ? "cookie"
          : "none",
    idempotencyKey: takesIdempotencyKey(route),
    lastEventId: route.lastEventId === true,
    body: route.body !== undefined,
    message:
      route.body !== undefined &&
      "message" in requestShape(OPENAPI_COMPONENT_SCHEMAS[route.body]),
    query: route.query !== undefined,
  };
}

function requestShape(schema: z.ZodType): Record<string, unknown> {
  return schema instanceof z.ZodObject ? schema.shape : {};
}

// The /v1 middleware refuses a cookie-authenticated mutation without the
// CSRF header (403), so every such operation documents both; bearer calls
// never send it, hence `required: false`.
function takesCookieMutation(route: RouteDeclaration): boolean {
  return (
    route.method !== "get" &&
    securityFor(route).some((scheme) => "cookieSession" in scheme)
  );
}

function ref(name: ComponentName) {
  return { $ref: `#/components/schemas/${name}` };
}

function jsonContent(name: ComponentName, example?: unknown) {
  return {
    "application/json": {
      schema: ref(name),
      ...(example === undefined ? {} : { example }),
    },
  };
}

function errorCodesFor(
  route: RouteDeclaration,
  status: number,
): readonly ApiErrorCode[] {
  const codes = route.errorCodes?.[status] ?? COMMON_ERROR_CODES[status];
  if (!codes || codes.length === 0) {
    throw new Error(
      `No ApiErrorResponse.code values registered for ${route.method.toUpperCase()} ${route.path} ${status}`,
    );
  }
  return codes;
}

// Retry-After rides on every 429 and on a storage 503 (app.ts), not on the
// readiness probe's NOT_READY.
function responseHeaders(retryAfter = false) {
  return {
    "X-Request-Id": { $ref: "#/components/headers/RequestId" },
    ...(retryAfter
      ? { "Retry-After": { $ref: "#/components/headers/RetryAfter" } }
      : {}),
  };
}

function errorContent(codes: readonly ApiErrorCode[]) {
  return {
    "application/json": {
      schema: {
        allOf: [
          ref("ApiErrorResponse"),
          {
            type: "object",
            properties: {
              error: {
                type: "object",
                properties: {
                  code: { type: "string", enum: codes },
                },
              },
            },
          },
        ],
      },
    },
  };
}

function queryParameters(schema: JsonSchema) {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((schema.required ?? []) as string[]);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: "query",
    required: required.has(name),
    schema: property,
  }));
}

function paramsSchemaFor(path: string): z.ZodObject {
  if (path === "/v1/receipts/{id}") return receiptIdParamsSchema;
  if (path.startsWith("/v1/agents/{id}/admins/")) return agentAdminParamsSchema;
  if (path.includes("{binding_id}")) return credentialBindingParamsSchema;
  if (path === "/v1/agents/{id}/identities/{identity_id}")
    return agentIdentityParamsSchema;
  if (path.startsWith("/v1/agents/{id}")) return agentIdParamsSchema;
  if (path.startsWith("/v1/teams/{team_id}/members/"))
    return teamMemberParamsSchema;
  if (path.startsWith("/v1/teams/{team_id}")) return teamIdParamsSchema;
  if (path.startsWith("/v1/workspace-profiles/{profile_id}"))
    return workspaceProfileIdParamsSchema;
  if (path.startsWith("/v1/installation-profiles/{profile_id}"))
    return installationProfileIdParamsSchema;
  if (path.startsWith("/v1/workspaces/{id}/members/{userId}"))
    return memberParamsSchema;
  if (path.includes("{app_id}/secrets/{purpose}"))
    return slackAppSecretParamsSchema;
  if (path.includes("{app_id}")) return slackAppParamsSchema;
  if (path === "/v1/invites/{id}") return inviteIdParamsSchema;
  if (path === "/v1/api-keys/{id}") return apiKeyIdParamsSchema;
  if (path.startsWith("/v1/members/{user_id}")) return memberUserParamsSchema;
  if (path.startsWith("/v1/users/{user_id}")) return memberUserParamsSchema;
  if (path.startsWith("/v1/workspaces/{id}")) return workspaceParamsSchema;
  if (path.includes("{turn_id}")) return turnIdParamsSchema;
  if (path.includes("{push_request_id}")) return pushRequestParamsSchema;
  if (path.includes("{run_id}")) return workflowRunParamsSchema;
  if (path === "/v1/sessions/{id}/outputs/{path}") {
    return sessionOutputParamsSchema;
  }
  if (
    path.startsWith("/v1/sessions/{id}") ||
    path.startsWith("/v1/admin/sessions/{id}")
  ) {
    return sessionIdParamsSchema;
  }
  if (path.startsWith("/v1/linked-accounts/{id}"))
    return linkedAccountParamsSchema;
  if (path === "/v1/slack/events/{agent_id}") return slackEventsParamsSchema;
  if (path === "/v1/usage/tools/{name}/calls") {
    return usageToolCallsParamsSchema;
  }
  throw new Error(`No params schema registered for ${path}`);
}

function pathParameters(path: string) {
  const names = [...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => name);
  if (names.length === 0) return [];
  const schema = paramsSchemaFor(path);
  const properties = (
    z.toJSONSchema(schema as z.ZodType, { io: "input" }) as JsonSchema
  ).properties as Record<string, JsonSchema>;
  return names.map((name) => {
    const property = properties[name as string];
    if (!property) throw new Error(`No params schema for ${name} in ${path}`);
    return { name, in: "path", required: true, schema: property };
  });
}

function buildSchemas(): Record<string, JsonSchema> {
  const schemas: Record<string, JsonSchema> = {};
  for (const [io, components] of [
    ["input", requestComponents],
    ["output", responseComponents],
  ] as const) {
    const registry = z.registry<{ id: string }>();
    for (const [id, schema] of Object.entries(components)) {
      registry.add(schema, { id });
    }
    const generated = z.toJSONSchema(registry, {
      io,
      uri: (id) => `#/components/schemas/${id}`,
      unrepresentable: "throw",
    }).schemas as Record<string, JsonSchema>;
    for (const [id, generatedSchema] of Object.entries(generated)) {
      const { $schema: _schema, $id: _id, ...schema } = generatedSchema;
      schemas[id] = schema;
    }
  }
  return schemas;
}

const schemas = buildSchemas();

export type ApiRouteConfig = RouteConfig & {
  path: string;
  getRoutingPath(): string;
};

function createApiRouteConfig(route: RouteDeclaration): ApiRouteConfig {
  const parameters: unknown[] = pathParameters(route.path);
  if (route.query) {
    const querySchema = schemas[route.query];
    if (!querySchema) throw new Error(`Missing query schema ${route.query}`);
    parameters.push(...queryParameters(querySchema));
  }
  if (takesIdempotencyKey(route)) {
    parameters.push({
      name: "Idempotency-Key",
      in: "header",
      required: true,
      description: IDEMPOTENCY_KEY_DESCRIPTION,
      schema: { type: "string", minLength: 1, maxLength: 255 },
    });
  }
  if (route.lastEventId) {
    parameters.push({
      name: "Last-Event-ID",
      in: "header",
      required: false,
      description: LAST_EVENT_ID_DESCRIPTION,
      schema: { type: "string", minLength: 1 },
    });
  }
  const csrf = route.csrf === "always" || takesCookieMutation(route);
  if (csrf) {
    parameters.push({
      name: "X-Requested-With",
      in: "header",
      required: route.csrf === "always",
      description:
        route.csrf === "always"
          ? "Always required: the literal `agent-platform-web`."
          : "Required with a cookie session: the literal `agent-platform-web`.",
      schema: { type: "string", enum: ["agent-platform-web"] },
    });
  }
  const success = route.success;
  const responses: Record<string, unknown> = {
    [success.status]:
      success.status === 204
        ? {
            description: success.description ?? "No content",
            headers: responseHeaders(),
          }
        : "download" in success
          ? {
              description: success.description,
              headers: {
                ...responseHeaders(),
                "Content-Disposition": {
                  description:
                    "Always `attachment`, with the file's name as `filename*` (RFC 6266, UTF-8) and an ASCII `filename` fallback.",
                  schema: { type: "string" },
                },
                "Content-Length": {
                  description: "The file's size in bytes.",
                  schema: { type: "integer" },
                },
              },
              content: {
                "application/octet-stream": {
                  schema: {
                    type: "string",
                    contentMediaType: "application/octet-stream",
                  },
                },
              },
            }
          : {
              description:
                success.description ??
                (success.sse ? "Event stream" : "Success"),
              headers: responseHeaders(),
              content: success.sse
                ? {
                    "text/event-stream": {
                      schema: ref(success.schema),
                      ...(success.example === undefined
                        ? {}
                        : { example: success.example }),
                    },
                  }
                : jsonContent(success.schema, success.example),
            },
  };
  const errors = new Set<number>(route.errors);
  if (csrf || route.scope) errors.add(403);
  if (route.method !== "get") errors.add(408);
  const context = errorContext(route);
  for (const status of [...errors].sort((a, b) => a - b)) {
    const codes = errorCodesFor(route, status);
    responses[status] = {
      description: errorResponseDescription(codes, context, route.errorNotes),
      headers: responseHeaders(
        status === 429 ||
          (status === 503 && codes.includes("BACKEND_UNAVAILABLE")),
      ),
      content: errorContent(codes),
    };
  }
  responses[500] = { $ref: "#/components/responses/InternalError" };

  return createRoute({
    method: route.method,
    path: route.path,
    operationId: route.operationId,
    tags: [route.tag],
    summary: route.summary,
    description: [
      route.description,
      accessNote(errorContext(route), route.method),
    ]
      .filter(Boolean)
      .join("\n\n"),
    ...(route.scope ? { "x-scope": scopeOf(route) } : {}),
    security: securityFor(route),
    parameters,
    ...(route.body
      ? {
          request: {
            body: {
              required: true,
              content: jsonContent(route.body, route.requestExample),
            },
          },
        }
      : {}),
    responses,
  } as RouteConfig & { path: string }) as ApiRouteConfig;
}

const routeConfigs = new Map<ApiOperationId, ApiRouteConfig>(
  API_ROUTE_DECLARATIONS.map((route) => [
    route.operationId,
    createApiRouteConfig(route),
  ]),
);

export function apiRouteConfig(
  operationId: ApiOperationId,
  basePath = "",
): ApiRouteConfig {
  const route = routeConfigs.get(operationId);
  if (!route) throw new Error(`Unknown API operation ${operationId}`);
  if (!basePath) return route;
  if (route.path !== basePath && !route.path.startsWith(`${basePath}/`)) {
    throw new Error(`${route.path} is not under ${basePath}`);
  }
  const path = route.path.slice(basePath.length) || "/";
  return createRoute({ ...route, path }) as ApiRouteConfig;
}

export function buildOpenApiDocument() {
  const registry = new OpenAPIHono();
  for (const route of API_ROUTE_DECLARATIONS) {
    registry.openapi(
      apiRouteConfig(route.operationId) as never,
      (() => new Response()) as never,
    );
  }
  const generated = registry.getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: "Werft API",
      version: OPENAPI_VERSION,
      description: API_INFO_DESCRIPTION,
    },
  });

  return {
    openapi: generated.openapi,
    info: generated.info,
    tags: OPENAPI_TAGS,
    "x-tagGroups": OPENAPI_TAG_GROUPS,
    components: {
      securitySchemes: {
        bearerApiKey: {
          type: "http",
          scheme: "bearer",
          description: SECURITY_SCHEME_DESCRIPTIONS.bearerApiKey,
        },
        cookieSession: {
          type: "apiKey",
          in: "cookie",
          name: WEB_SESSION_COOKIE_NAME,
          description: SECURITY_SCHEME_DESCRIPTIONS.cookieSession,
        },
      },
      headers: RESPONSE_HEADERS,
      schemas,
      responses: {
        InternalError: {
          description:
            "- `INTERNAL_ERROR`: An unexpected server failure. Report it with the `X-Request-Id`.",
          headers: responseHeaders(),
          content: errorContent(["INTERNAL_ERROR"]),
        },
      },
    },
    paths: generated.paths ?? {},
  };
}

export function renderOpenApiDocument(): string {
  return `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
}
