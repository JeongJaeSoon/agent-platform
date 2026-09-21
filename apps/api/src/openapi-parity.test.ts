import { expect, test } from "bun:test";
import { buildOpenApiDocument } from "@agent-platform/contracts";
import type { SessionService } from "@agent-platform/platform";
import { createApiApp } from "./app.ts";
import { registerSessionRoutes } from "./routes/sessions.ts";

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

function openApiRoutes(): Set<string> {
  const document = buildOpenApiDocument();
  return new Set(
    Object.entries(document.paths).flatMap(([path, operations]) =>
      Object.keys(operations).map(
        (method) => `${method.toUpperCase()} ${path}`,
      ),
    ),
  );
}

test("every Hono handler is declared in the OpenAPI route table", () => {
  const declared = openApiRoutes();
  for (const route of honoRoutes()) {
    expect(declared, `${route} is served but not in OpenAPI`).toContain(route);
  }
});

test("OpenAPI routes without a handler are exactly the pending list", () => {
  const served = honoRoutes();
  const pending = [...openApiRoutes()].filter((route) => !served.has(route));
  expect(pending.sort()).toEqual([...NOT_YET_IMPLEMENTED].sort());
});
