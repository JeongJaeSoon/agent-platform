import { expect, test } from "bun:test";
import { buildOpenApiDocument } from "@agent-platform/contracts";
import type { SessionService } from "@agent-platform/platform";
import { createApiApp, rootRouteErrors } from "./app.ts";
import {
  registerSessionRoutes,
  sessionRouteErrors,
} from "./routes/sessions.ts";

// Routes the OpenAPI table declares but no Hono handler serves yet. Shrink
// this list as sibling tickets land; a route removed from here must exist.
const NOT_YET_IMPLEMENTED = [
  "GET /healthz",
  "GET /readyz",
  "POST /v1/sessions/{id}/messages",
  "GET /v1/sessions/{id}/turns",
  "GET /v1/sessions/{id}/turns/{turn_id}",
  "GET /v1/sessions/{id}/events",
  "GET /v1/sessions/{id}/pending-requests",
  "POST /v1/sessions/{id}/answers",
  "POST /v1/sessions/{id}/interrupt",
  "POST /v1/sessions/{id}/pause",
  "POST /v1/sessions/{id}/terminate",
  "POST /v1/sessions/{id}/resume",
  "POST /v1/sessions/{id}/recovery-decisions",
  "GET /v1/receipts/{id}",
];

function honoRoutes(): Set<string> {
  const app = createApiApp({
    authMode: "none",
    registerRoutes: (router) =>
      registerSessionRoutes(router, {} as SessionService),
  });
  return new Set(
    app.routes
      .filter((route) => route.method !== "ALL")
      .map(
        (route) =>
          `${route.method} ${route.path.replace(/\/$/, "").replace(/:(\w+)/g, "{$1}") || "/"}`,
      ),
  );
}

function openApiOperations(): Map<string, { errors: number[] }> {
  const document = buildOpenApiDocument();
  return new Map(
    Object.entries(document.paths).flatMap(([path, operations]) =>
      Object.entries(operations).map(([method, operation]) => [
        `${method.toUpperCase()} ${path}`,
        {
          errors: Object.keys((operation as { responses: object }).responses)
            .map(Number)
            .filter((status) => status >= 400),
        },
      ]),
    ),
  );
}

function openApiRoutes(): Set<string> {
  return new Set(openApiOperations().keys());
}

// Declared but not yet produced by any handler.
const DECLARED_ONLY_ERRORS: Record<string, number[]> = {
  "POST /v1/sessions": [429],
};

test("every Hono handler is declared in the OpenAPI route table", () => {
  const declared = openApiRoutes();
  for (const route of honoRoutes()) {
    expect(declared, `${route} is served but not in OpenAPI`).toContain(route);
  }
});

test("each handler's error statuses match its OpenAPI operation", () => {
  const declared = openApiOperations();
  for (const route of honoRoutes()) {
    const implemented =
      route === "GET /v1" ? rootRouteErrors : sessionRouteErrors[route];
    expect(implemented, `${route} has no error status table`).toBeDefined();
    const expected = [
      ...(implemented ?? []),
      ...(DECLARED_ONLY_ERRORS[route] ?? []),
    ].sort();
    expect([...(declared.get(route)?.errors ?? [])].sort(), route).toEqual(
      expected,
    );
  }
});

test("OpenAPI routes without a handler are exactly the pending list", () => {
  const served = honoRoutes();
  const pending = [...openApiRoutes()].filter((route) => !served.has(route));
  expect(pending.sort()).toEqual([...NOT_YET_IMPLEMENTED].sort());
});
