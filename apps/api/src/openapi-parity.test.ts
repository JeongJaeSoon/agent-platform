import { expect, test } from "bun:test";
import { buildOpenApiDocument } from "@agent-platform/contracts";
import type {
  PendingRequestService,
  SessionService,
} from "@agent-platform/platform";
import { createApiApp, probeRouteErrors, rootRouteErrors } from "./app.ts";
import { eventRouteErrors, registerEventRoutes } from "./routes/events.ts";
import { pendingRouteErrors, registerPendingRoutes } from "./routes/pending.ts";
import {
  receiptRouteErrors,
  registerReceiptRoutes,
} from "./routes/receipts.ts";
import {
  registerSessionRoutes,
  sessionRouteErrors,
} from "./routes/sessions.ts";

// Routes the OpenAPI table declares but no Hono handler serves yet. Shrink
// this list as sibling tickets land; a route removed from here must exist.
const NOT_YET_IMPLEMENTED = [
  "POST /v1/sessions/{id}/interrupt",
  "POST /v1/sessions/{id}/pause",
  "POST /v1/sessions/{id}/resume",
  "POST /v1/sessions/{id}/recovery-decisions",
];

function honoRoutes(): Set<string> {
  const app = createApiApp({
    authMode: "none",
    registerRoutes: (router) => {
      registerSessionRoutes(router, {} as SessionService);
      registerReceiptRoutes(router, {} as SessionService);
      registerPendingRoutes(router, {} as PendingRequestService);
      registerEventRoutes(router, {} as SessionService, {
        wakeup: { wait: async () => {} },
      });
    },
  });
  // /internal/* is the worker protocol, not part of the public document.
  return new Set(
    app.routes
      .filter(
        (route) =>
          route.method !== "ALL" && !route.path.startsWith("/internal/"),
      )
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
  "POST /v1/sessions/{id}/messages": [429],
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
      route === "GET /v1"
        ? rootRouteErrors
        : (probeRouteErrors[route] ??
          receiptRouteErrors[route] ??
          eventRouteErrors[route] ??
          pendingRouteErrors[route] ??
          sessionRouteErrors[route]);
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
