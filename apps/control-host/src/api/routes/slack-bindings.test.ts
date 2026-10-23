import { describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  DEFAULT_SURFACE_CEILING,
  listSlackBindingsResponseSchema,
  putSlackBindingResponseSchema,
  REQUEST_BODY_MAX_BYTES,
  type SurfaceBinding,
} from "@werft-ai/contracts";
import {
  SessionServiceError,
  type SurfaceBindingService,
} from "@werft-ai/platform";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerSlackBindingRoutes } from "./slack-bindings.ts";

const createApiApp = recordRouteErrors("routes/slack-bindings.test.ts");

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const AGENT = "019a0000-0000-7000-8000-0000000000b1";
const BINDING = "019a0000-0000-7000-8000-0000000000d1";
const INSTALLATION = "019a0000-0000-7000-8000-0000000000c1";
const RECEIPT = "019a0000-0000-7000-8000-0000000000e1";
const owner = { "X-Owner-Id": WORKSPACE, "Content-Type": "application/json" };

const VIEW: SurfaceBinding = {
  id: BINDING,
  workspace_id: WORKSPACE,
  owner_id: WORKSPACE,
  surface: "slack",
  installation_id: INSTALLATION,
  external_surface_id: "C0OPS",
  surface_kind: "public_channel",
  agent_id: AGENT,
  mode: "mention",
  ceiling: DEFAULT_SURFACE_CEILING,
  home: true,
  memory_write_policy: "deny",
  status: "ready",
  muted: false,
  revision: 1,
  created_at: "2026-10-23T00:00:00.000Z",
  revoked_at: null,
};

const BODY = {
  channel_id: "C0OPS",
  channel_kind: "public_channel",
  mode: "mention",
  home: true,
};

const outage = () =>
  Promise.reject(
    Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
  );

function app(service: Partial<SurfaceBindingService>) {
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) =>
      registerSlackBindingRoutes(router, {
        service: service as SurfaceBindingService,
      }),
  });
}

async function errorOf(response: Response) {
  return apiErrorResponseSchema.parse(await response.json()).error;
}

function put(api: ReturnType<typeof app>, body: unknown, agent = AGENT) {
  return api.request(`/v1/agents/${agent}/slack-bindings`, {
    method: "PUT",
    headers: owner,
    body: JSON.stringify(body),
  });
}

describe("PUT /v1/agents/{id}/slack-bindings", () => {
  test("sets the binding and answers 200 with the receipt", async () => {
    let asked: unknown;
    const response = await put(
      app({
        putSlackBinding: async (_caller, agentId, request) => {
          asked = { agentId, request };
          return { slack_binding: VIEW, receipt_id: RECEIPT };
        },
      }),
      { channel_id: null, channel_kind: "dm", mode: "off" },
    );
    expect(response.status).toBe(200);
    expect(putSlackBindingResponseSchema.parse(await response.json())).toEqual({
      slack_binding: VIEW,
      receipt_id: RECEIPT,
    });
    // `home` defaults off; no ceiling means the service's default.
    expect(asked).toEqual({
      agentId: AGENT,
      request: {
        channel_id: null,
        channel_kind: "dm",
        mode: "off",
        home: false,
      },
    });
  });

  test("a malformed body, agent id or oversized body never reaches the service", async () => {
    const untouched = app({});
    for (const body of [
      { ...BODY, mode: "ambient" },
      { ...BODY, channel_id: "c0-lowercase" },
      { ...BODY, channel_id: null },
      { ...BODY, channel_kind: "dm" },
      { channel_id: null, channel_kind: "dm", mode: "mention", home: true },
      {
        ...BODY,
        ceiling: { actions: ["session.recover"], disclosure: "full" },
      },
      { ...BODY, name: "#ops" },
    ]) {
      expect((await put(untouched, body)).status).toBe(400);
    }
    expect((await put(untouched, BODY, "not-an-agent")).status).toBe(404);
    expect(
      (
        await put(untouched, {
          ...BODY,
          pad: "x".repeat(REQUEST_BODY_MAX_BYTES),
        })
      ).status,
    ).toBe(413);
  });

  test("each refusal keeps its code and status", async () => {
    const cases: [SessionServiceError, number][] = [
      [
        new SessionServiceError("FORBIDDEN", "no", undefined, {
          reason_code: "role",
        }),
        403,
      ],
      [new SessionServiceError("NOT_FOUND", "Resource not found"), 404],
      [new SessionServiceError("SLACK_NOT_INSTALLED", "연결"), 409],
      [new SessionServiceError("REVISION_CONFLICT", "동시에"), 409],
    ];
    for (const [error, status] of cases) {
      const response = await put(
        app({
          putSlackBinding: async () => {
            throw error;
          },
        }),
        BODY,
      );
      expect(response.status).toBe(status);
      expect(await errorOf(response)).toMatchObject({
        code: error.code,
        message: error.message,
      });
    }
    expect((await put(app({ putSlackBinding: outage }), BODY)).status).toBe(
      503,
    );
  });
});

describe("GET /v1/agents/{id}/slack-bindings", () => {
  test("lists, refuses and fails closed", async () => {
    const path = `/v1/agents/${AGENT}/slack-bindings`;
    const listed = await app({
      listSlackBindings: async () => ({ items: [VIEW] }),
    }).request(path, { headers: owner });
    expect(listed.status).toBe(200);
    expect(
      listSlackBindingsResponseSchema.parse(await listed.json()).items,
    ).toEqual([VIEW]);

    const refused = await app({
      listSlackBindings: async () => {
        throw new SessionServiceError("FORBIDDEN", "no");
      },
    }).request(path, { headers: owner });
    expect(refused.status).toBe(403);
    expect(
      (
        await app({}).request("/v1/agents/not-an-agent/slack-bindings", {
          headers: owner,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app({ listSlackBindings: outage }).request(path, {
          headers: owner,
        })
      ).status,
    ).toBe(503);
  });
});
