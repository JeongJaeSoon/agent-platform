import { expect, test } from "bun:test";
import {
  API_ROUTE_SCOPES,
  buildOpenApiDocument,
} from "@agent-platform/contracts";
import type {
  InterruptService,
  PendingRequestService,
  SessionService,
  UsageService,
} from "@agent-platform/platform";
import {
  bodyRouteErrors,
  createApiApp,
  mutationRouteErrors,
  probeRouteErrors,
  rootRouteErrors,
} from "./app.ts";
import type { BootstrapGate, IdentityStore } from "./auth.ts";
import {
  authRouteErrors,
  registerAuthRoutes,
  registerPublicAuthRoutes,
} from "./routes/auth.ts";
import { eventRouteErrors, registerEventRoutes } from "./routes/events.ts";
import {
  interruptRouteErrors,
  registerInterruptRoutes,
} from "./routes/interrupt.ts";
import { pauseRouteErrors, registerPauseRoutes } from "./routes/pause.ts";
import { pendingRouteErrors, registerPendingRoutes } from "./routes/pending.ts";
import {
  receiptRouteErrors,
  registerReceiptRoutes,
} from "./routes/receipts.ts";
import {
  registerSessionRoutes,
  sessionRouteErrors,
} from "./routes/sessions.ts";
import { registerUsageRoutes, usageRouteErrors } from "./routes/usage.ts";
import { scopedRouteErrors } from "./scope-policy.ts";

const SCOPED_ROUTES = new Set(
  API_ROUTE_SCOPES.map((route) => `${route.method} ${route.path}`),
);

// Routes the OpenAPI table declares but no Hono handler serves yet. Shrink
// this list as sibling tickets land; a route removed from here must exist.
const NOT_YET_IMPLEMENTED: string[] = [];

function honoRoutes(only?: "public"): Set<string> {
  const auth = {
    identity: {} as IdentityStore,
    bootstrap: {} as BootstrapGate,
  };
  const app = createApiApp({
    authMode: "none",
    registerPublicRoutes: (router) => registerPublicAuthRoutes(router, auth),
    registerRoutes: (router) => {
      if (only === "public") return;
      registerAuthRoutes(router, auth);
      registerSessionRoutes(router, {} as SessionService);
      registerReceiptRoutes(router, {} as SessionService);
      registerPendingRoutes(router, {} as PendingRequestService);
      registerInterruptRoutes(router, {} as InterruptService);
      registerPauseRoutes(router, {} as SessionService);
      registerUsageRoutes(router, {} as UsageService);
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
const DECLARED_ONLY_ERRORS: Record<string, number[]> = {};

test("every Hono handler is declared in the OpenAPI route table", () => {
  const declared = openApiRoutes();
  for (const route of honoRoutes()) {
    expect(declared, `${route} is served but not in OpenAPI`).toContain(route);
  }
});

test("each handler's error statuses match its OpenAPI operation", () => {
  const declared = openApiOperations();
  const publicRoutes = honoRoutes("public");
  for (const route of honoRoutes()) {
    const implemented =
      route === "GET /v1"
        ? rootRouteErrors
        : (probeRouteErrors[route] ??
          authRouteErrors[route] ??
          receiptRouteErrors[route] ??
          eventRouteErrors[route] ??
          pendingRouteErrors[route] ??
          interruptRouteErrors[route] ??
          pauseRouteErrors[route] ??
          usageRouteErrors[route] ??
          sessionRouteErrors[route]);
    expect(implemented, `${route} has no error status table`).toBeDefined();
    // Errors the /v1 middleware adds before the handler runs.
    const middleware = [
      ...(route.startsWith("POST /v1")
        ? [
            ...bodyRouteErrors,
            ...(publicRoutes.has(route) ? [] : mutationRouteErrors),
          ]
        : []),
      ...(SCOPED_ROUTES.has(route) ? scopedRouteErrors : []),
    ];
    const expected = [
      ...new Set([
        ...(implemented ?? []),
        ...(DECLARED_ONLY_ERRORS[route] ?? []),
        ...middleware,
      ]),
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
