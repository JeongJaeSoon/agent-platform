import type { AuthMeResponse } from "@agent-platform/contracts";

export interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly headers: Headers;
  readonly body: unknown;
}

type Handler = (request: Request) => Response | Promise<Response>;

/**
 * A fetch that answers by "METHOD /path" and records what it was sent, so a
 * screen test can assert on the request as well as on what it drew.
 */
export function fakeApi(routes: Record<string, Handler>) {
  const calls: Recorded[] = [];
  const fetch = async (input: Request): Promise<Response> => {
    const url = new URL(input.url);
    const key = `${input.method} ${url.pathname}`;
    const text = await input.text();
    calls.push({
      method: input.method,
      path: url.pathname,
      headers: input.headers,
      body: text ? JSON.parse(text) : null,
    });
    const handler = routes[key];
    if (!handler) return apiError(404, "NOT_FOUND", `no fake for ${key}`);
    return handler(input);
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function apiError(status: number, code: string, message: string) {
  return json(status, {
    error: {
      code,
      message,
      retryable: false,
      request_id: "req-1",
      details: null,
    },
  });
}

export const WORKSPACE_ID = "6d4c1f5e-4c39-4d7a-9a51-0f4f3c7a2b10";
export const USER_ID = "0b1d0c7e-1f27-4a3e-8a8e-9c1b2d3e4f50";

export function me(
  scopes: AuthMeResponse["scopes"] = [
    "sessions:read",
    "sessions:write",
    "sessions:approve",
    "sessions:control",
    "sessions:recover",
  ],
): AuthMeResponse {
  return {
    principal: {
      kind: "user",
      id: USER_ID,
      workspace_id: WORKSPACE_ID,
      role: "owner",
      scopes,
    },
    user: { id: USER_ID, email: "owner@example.com", display_name: "Owner" },
    workspace: {
      id: WORKSPACE_ID,
      slug: "acme",
      name: "Acme",
      settings: {
        dispatch_model: null,
        kill_switch: false,
        daily_cost_limit_usd: null,
        idle_pause_minutes: 30,
        audit_retention_days: 90,
      },
      created_at: "2026-10-01T00:00:00.000Z",
    },
    scopes,
  };
}
