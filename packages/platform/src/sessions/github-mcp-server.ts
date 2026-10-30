import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  type AgentGitHub,
  GITHUB_MCP_SERVER,
  GITHUB_MCP_TOOL_ARGUMENTS,
  type GitHubMcpTool,
  githubMcpTools,
  type ReceiptActor,
} from "@werft-ai/contracts";
import { z } from "zod";
import type { AuthorizationPolicy, Caller } from "../musterrolle/policy.ts";
import type { GitHubMcpStore } from "../ports/github-mcp.ts";
import type { GitHubWorkService } from "./github-work-service.ts";
import type { PullRequestService } from "./pull-request-service.ts";
import type { PushActor, PushRequestService } from "./push-request-service.ts";
import { SessionServiceError } from "./session-service.ts";

/**
 * The built-in `github` MCP server (design github-agent.md §3 "내장 MCP 서버
 * github"): the session's agent calls the same service functions as the
 * session API, for its own session only. The egress proxy reaches it with
 * a grant the authorizer signed for one session and attempt; nothing in a
 * request body picks the session.
 */

const GRANT_VERSION = "v1";
export const GITHUB_MCP_GRANT_TTL_MS = 60_000;

export type GitHubMcpGrant = { sessionId: string; attemptId: string };

const grantPayloadSchema = z
  .object({
    session_id: z.string().min(1),
    attempt_id: z.string().min(1),
    exp: z.number().int(),
  })
  .strict();

function mac(key: Uint8Array, signed: string): Buffer {
  return createHmac("sha256", key).update(signed, "utf8").digest();
}

/** The bearer the authorizer hands the proxy for one exchange. */
export function signGitHubMcpGrant(
  key: Uint8Array,
  grant: GitHubMcpGrant,
  nowMs: number,
): string {
  const payload = Buffer.from(
    JSON.stringify({
      session_id: grant.sessionId,
      attempt_id: grant.attemptId,
      exp: nowMs + GITHUB_MCP_GRANT_TTL_MS,
    }),
    "utf8",
  ).toString("base64url");
  const signed = `${GRANT_VERSION}.${payload}`;
  return `${signed}.${mac(key, signed).toString("base64url")}`;
}

/** The session and attempt a bearer names, or null for any other bearer. */
export function verifyGitHubMcpGrant(
  key: Uint8Array,
  bearer: string,
  nowMs: number,
): GitHubMcpGrant | null {
  const parts = bearer.split(".");
  if (parts.length !== 3 || parts[0] !== GRANT_VERSION) return null;
  const [, payload = "", given = ""] = parts;
  const expected = mac(key, `${GRANT_VERSION}.${payload}`);
  const presented = Buffer.from(given, "base64url");
  if (
    presented.length !== expected.length ||
    !timingSafeEqual(presented, expected)
  ) {
    return null;
  }
  let parsed: z.infer<typeof grantPayloadSchema>;
  try {
    parsed = grantPayloadSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
  } catch {
    return null;
  }
  if (parsed.exp <= nowMs) return null;
  return { sessionId: parsed.session_id, attemptId: parsed.attempt_id };
}

export type GitHubMcpServices = {
  pushRequests: Pick<PushRequestService, "create">;
  pullRequests: Pick<PullRequestService, "open" | "comment">;
  githubWork: Pick<
    GitHubWorkService,
    "dispatch" | "getRun" | "rerun" | "review"
  >;
};

const DESCRIPTIONS: Record<GitHubMcpTool, string> = {
  request_push:
    "Ask to push this session's last checkpoint (the end of the previous turn, not commits made in this turn) to its agent/<session-id> branch. When the release requires approval the request waits for a person and this returns at once; call open_pull_request after it is pushed.",
  open_pull_request:
    "Open (or answer the already open) pull request from a pushed push request's branch and commit.",
  comment_pull_request:
    "Comment on the pull request of a pushed push request; the same marker edits the same comment.",
  dispatch_workflow:
    "Dispatch an allow-listed workflow on a branch. Inputs go to GitHub only.",
  get_workflow_run: "Read a workflow run of this session's repository.",
  rerun_workflow:
    "Rerun a workflow run the platform dispatched for this repository.",
  submit_review:
    "Review a pull request with the reviewer App, on the commit you read (commit_id).",
};

// The protocol revisions this server answers; an unknown request gets the
// newest, as the specification lets a server do.
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

type JsonRpcId = string | number;
export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The authorization the services see on this route: the attempt's own
 * session, to read and to submit to, and nothing else. The attempt's
 * authority comes from the egress fence, which the proxy re-asks on every
 * exchange; no scope is held, so no push can be decided.
 */
export function sessionBoundAuthorization(
  sessionId: string,
): AuthorizationPolicy {
  return {
    async authorize(request) {
      const allowed =
        (request.action === "session.read" ||
          request.action === "session.submit") &&
        request.resource.kind === "session" &&
        request.resource.id === sessionId;
      return {
        outcome: allowed ? "allow" : "deny",
        reason_code: allowed ? "ok" : "surface_ceiling",
        effective_scopes: [],
        policy_version: "github-mcp-1",
        decision_id: randomUUID(),
      };
    },
  };
}

function actorFor(
  ownerId: string,
  receiptActor: ReceiptActor,
  requestId: string,
): PushActor {
  const { principal } = receiptActor;
  // No scope: a push decision refuses it, and a pull request opens only from
  // a pushed request (design github-agent.md §2 decision 6).
  const unscoped = {
    kind: "api_key" as const,
    id: principal.id,
    owner_id: ownerId,
    workspace_id: null,
    scopes: [],
  };
  const caller: Caller = {
    ownerId,
    // What the receipts name (receiptActorOf).
    actor: {
      principal,
      userId: receiptActor.actor_user_id,
      workspaceId: null,
      apiKeyId: principal.kind === "api_key" ? principal.id : null,
      agentId: receiptActor.agent_id,
    },
    // Only sessionBoundAuthorization reads this, and it judges the session.
    subject: { principal: unscoped, surface: { kind: "api" } },
    requestId,
  };
  return { caller, principal: unscoped, ownerId, verified: true };
}

function text(value: unknown, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function createGitHubMcpServer(deps: {
  store: GitHubMcpStore;
  /** The session services, made with the authorization they run under. */
  services: (authorization: AuthorizationPolicy) => GitHubMcpServices;
}) {
  const toolList = (github: AgentGitHub) =>
    githubMcpTools(github).map((name) => ({
      name,
      description: DESCRIPTIONS[name],
      inputSchema: z.toJSONSchema(GITHUB_MCP_TOOL_ARGUMENTS[name], {
        io: "input",
        unrepresentable: "any",
      }),
    }));

  async function call(
    grant: GitHubMcpGrant,
    tool: GitHubMcpTool,
    args: unknown,
    requestId: string,
    github: AgentGitHub,
    state: { ownerId: string; actor: ReceiptActor },
  ) {
    if (!githubMcpTools(github).includes(tool)) {
      return text({ code: "FORBIDDEN", message: `Tool ${tool} is off` }, true);
    }
    const parsed = GITHUB_MCP_TOOL_ARGUMENTS[tool].safeParse(args ?? {});
    if (!parsed.success) {
      return text(
        {
          code: "VALIDATION_ERROR",
          message: parsed.error.issues
            .map(
              (issue) =>
                `${issue.path.join(".") || "arguments"}: ${issue.message}`,
            )
            .join("; "),
        },
        true,
      );
    }
    const actor = actorFor(state.ownerId, state.actor, requestId);
    const services = deps.services(sessionBoundAuthorization(grant.sessionId));
    const { sessionId } = grant;
    try {
      return text(await run(services, actor, sessionId, tool, parsed.data));
    } catch (error) {
      if (error instanceof SessionServiceError) {
        return text(
          {
            code: error.code,
            message: error.message,
            ...(error.details === null ? {} : { details: error.details }),
          },
          true,
        );
      }
      throw error;
    }
  }

  return async function handle(
    grant: GitHubMcpGrant,
    message: unknown,
    requestId: string,
  ): Promise<JsonRpcResponse | null> {
    if (!isRecord(message) || message.jsonrpc !== "2.0") {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid request" },
      };
    }
    const id = message.id;
    // A notification, or a response to a request this server never sends.
    if (
      typeof message.method === "string"
        ? id === undefined
        : "result" in message || "error" in message
    ) {
      return null;
    }
    if (typeof message.method !== "string") {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid request" },
      };
    }
    if (typeof id !== "string" && typeof id !== "number") {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid request id" },
      };
    }
    const answer = (result: unknown): JsonRpcResponse => ({
      jsonrpc: "2.0",
      id,
      result,
    });
    const fail = (code: number, text: string): JsonRpcResponse => ({
      jsonrpc: "2.0",
      id,
      error: { code, message: text },
    });
    const params = isRecord(message.params) ? message.params : {};
    switch (message.method) {
      case "initialize": {
        const asked = params.protocolVersion;
        return answer({
          protocolVersion:
            typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked)
              ? asked
              : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: GITHUB_MCP_SERVER, version: "1" },
        });
      }
      case "ping":
        return answer({});
      case "tools/list":
      case "tools/call":
        break;
      default:
        return fail(-32601, `Method ${message.method} is not served`);
    }
    // Read for every call: the proxy judged the exchange a moment ago, and
    // the same reads here keep a switch flipped since then from acting.
    const state = await deps.store.sessionState(grant.sessionId);
    if (
      state === null ||
      state.github === null ||
      !state.enabled ||
      state.actor === null
    ) {
      return fail(-32001, "GitHub tools are not available to this session");
    }
    if (message.method === "tools/list") {
      return answer({ tools: toolList(state.github) });
    }
    const name = params.name;
    if (
      typeof name !== "string" ||
      !Object.hasOwn(GITHUB_MCP_TOOL_ARGUMENTS, name)
    ) {
      return fail(-32602, "Unknown tool");
    }
    return answer(
      await call(
        grant,
        name as GitHubMcpTool,
        params.arguments,
        requestId,
        state.github,
        { ownerId: state.ownerId, actor: state.actor },
      ),
    );
  };
}

// Each tool is one call to the session API's own service function.
async function run(
  services: GitHubMcpServices,
  actor: PushActor,
  sessionId: string,
  tool: GitHubMcpTool,
  args: unknown,
): Promise<unknown> {
  switch (tool) {
    case "request_push":
      return services.pushRequests.create(actor, sessionId, {
        idempotencyKey: `mcp-${randomUUID()}`,
      });
    case "open_pull_request": {
      const { push_request_id, ...body } = args as z.infer<
        (typeof GITHUB_MCP_TOOL_ARGUMENTS)["open_pull_request"]
      >;
      return services.pullRequests.open(actor, sessionId, push_request_id, {
        readBody: async () => body,
      });
    }
    case "comment_pull_request": {
      const { push_request_id, ...body } = args as z.infer<
        (typeof GITHUB_MCP_TOOL_ARGUMENTS)["comment_pull_request"]
      >;
      return services.pullRequests.comment(actor, sessionId, push_request_id, {
        readBody: async () => body,
      });
    }
    case "dispatch_workflow":
      return services.githubWork.dispatch(
        actor,
        sessionId,
        args as z.infer<
          (typeof GITHUB_MCP_TOOL_ARGUMENTS)["dispatch_workflow"]
        >,
      );
    case "get_workflow_run": {
      const { run_id } = args as z.infer<
        (typeof GITHUB_MCP_TOOL_ARGUMENTS)["get_workflow_run"]
      >;
      return services.githubWork.getRun(actor, sessionId, run_id);
    }
    case "rerun_workflow": {
      const { run_id, ...body } = args as z.infer<
        (typeof GITHUB_MCP_TOOL_ARGUMENTS)["rerun_workflow"]
      >;
      return services.githubWork.rerun(actor, sessionId, run_id, body);
    }
    case "submit_review": {
      const { number, ...body } = args as z.infer<
        (typeof GITHUB_MCP_TOOL_ARGUMENTS)["submit_review"]
      >;
      return services.githubWork.review(actor, sessionId, number, body);
    }
  }
}
