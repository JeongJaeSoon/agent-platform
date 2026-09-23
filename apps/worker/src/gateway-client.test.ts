import { describe, expect, test } from "bun:test";

import {
  HttpWorkerGatewayClient,
  isOwnershipLost,
  isRetryable,
  WorkerGatewayRequestError,
} from "./gateway-client.ts";

type Recorded = { body: unknown; headers: Record<string, string>; url: string };

function client(
  respond: (recorded: Recorded) => Response | Promise<Response>,
  recorded: Recorded[] = [],
) {
  return {
    recorded,
    gateway: new HttpWorkerGatewayClient({
      baseUrl: "http://gateway.internal/",
      credential: "wln_launch",
      requestTimeoutMs: 1_000,
      fetch: async (input, init) => {
        const entry: Recorded = {
          body: JSON.parse(String(init?.body ?? "null")),
          headers: Object.fromEntries(
            Object.entries((init?.headers ?? {}) as Record<string, string>),
          ),
          url: String(input),
        };
        recorded.push(entry);
        return respond(entry);
      },
    }),
  };
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function apiError(status: number, code: string, retryable = false): Response {
  return new Response(
    JSON.stringify({
      error: {
        code,
        message: `${code} from the gateway`,
        retryable,
        request_id: "req_1",
        details: null,
      },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

const scope = {
  session_id: "11111111-1111-4111-8111-111111111111",
  turn_id: null,
  attempt_id: "att_1",
  lease_epoch: 1,
  execution_generation: 2,
  auth_revision: 0,
};

describe("HttpWorkerGatewayClient", () => {
  test("posts to the worker protocol path with the current credential", async () => {
    const { gateway, recorded } = client(() =>
      ok({
        ...scope,
        session_credential: "wsc_session",
        lease_expires_at: new Date().toISOString(),
        runtime: {
          kind: "claude_agent_sdk",
          version: "0.3.270",
          profile_id: "p",
        },
        profile_fingerprint: `sha256:${"0".repeat(64)}`,
        runtime_config: {
          model: "claude-sonnet-4-5",
          tools: [],
          permission_mode: "default",
          provider: {
            kind: "litellm",
            endpoint: "http://litellm:4000",
            auth: { kind: "api_key", value: "placeholder" },
          },
        },
        workspace: {
          repository: {
            id: "sample-app",
            url: "https://git.example.test/sample.git",
            branch: "main",
          },
        },
        principal: { owner_scope: "owner-a" },
        restore: null,
      }),
    );
    const claim = await gateway.bootstrapClaim({
      execution_id: "exec-1",
      execution_generation: 2,
      credential: { kind: "launch_nonce", nonce: "wln_launch" },
    });

    expect(recorded[0]?.url).toBe(
      "http://gateway.internal/internal/worker/bootstrap-claim",
    );
    expect(recorded[0]?.headers.Authorization).toBe("Bearer wln_launch");
    expect(claim.session_credential).toBe("wsc_session");

    gateway.useCredential(claim.session_credential);
    await gateway.release({ ...scope, reason: "done" }).catch(() => {});
    expect(recorded[1]?.headers.Authorization).toBe("Bearer wsc_session");
  });

  test("decodes an API error body into a typed decision", async () => {
    const { gateway } = client(() => apiError(409, "LEASE_EXPIRED"));
    const error = await gateway
      .heartbeat({ ...scope, attempt_state: "running" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerGatewayRequestError);
    expect((error as WorkerGatewayRequestError).code).toBe("LEASE_EXPIRED");
    expect(isOwnershipLost(error)).toBe(true);
    expect(isRetryable(error)).toBe(false);
  });

  test("treats a body that is not an API error as an untyped failure", async () => {
    // What an unrouted path or a proxy answers: HTML, not the error envelope.
    const { gateway } = client(
      () => new Response("<html>404</html>", { status: 404 }),
    );
    const error = (await gateway
      .pendingControl({ ...scope, answers_after: 0 })
      .catch((caught: unknown) => caught)) as WorkerGatewayRequestError;

    expect(error.code).toBeNull();
    expect(error.status).toBe(404);
    expect(error.retryable).toBe(false);
  });

  test("keeps a 5xx without a body retryable", async () => {
    const { gateway } = client(() => new Response("", { status: 503 }));
    const error = (await gateway
      .nextInput({ ...scope })
      .catch((caught: unknown) => caught)) as WorkerGatewayRequestError;

    expect(error.retryable).toBe(true);
    expect(isOwnershipLost(error)).toBe(false);
  });

  test("reports a socket that never answered as retryable", async () => {
    const { gateway } = client(() => {
      throw new Error("connect ECONNREFUSED");
    });
    const error = (await gateway
      .nextInput({ ...scope })
      .catch((caught: unknown) => caught)) as WorkerGatewayRequestError;

    expect(error.status).toBe(0);
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("ECONNREFUSED");
  });

  test("refuses a success body that does not match the contract", async () => {
    const { gateway } = client(() => ok({ accepted_through: "not a number" }));
    const error = (await gateway
      .appendEvents({
        ...scope,
        batch_key: "b1",
        events: [
          {
            event: "system",
            data: { type: "system" },
            source_sequence: 1,
            occurred_at: new Date().toISOString(),
          },
        ],
      })
      .catch((caught: unknown) => caught)) as WorkerGatewayRequestError;

    expect(error).toBeInstanceOf(WorkerGatewayRequestError);
    expect(error.retryable).toBe(false);
  });
});
