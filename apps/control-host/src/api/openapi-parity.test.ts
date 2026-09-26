import { expect, test } from "bun:test";
import { buildOpenApiDocument } from "@agent-platform/contracts";
import type {
  InterruptService,
  PendingRequestService,
  SessionService,
  UsageService,
} from "@agent-platform/platform";
import { createApiApp } from "./app.ts";
import type { BootstrapGate, IdentityStore } from "./auth.ts";
import { ROUTE_ERROR_TESTS } from "./route-error-coverage.ts";
import { registerAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";
import { registerEventRoutes } from "./routes/events.ts";
import { registerInterruptRoutes } from "./routes/interrupt.ts";
import { registerPauseRoutes } from "./routes/pause.ts";
import { registerPendingRoutes } from "./routes/pending.ts";
import { registerReceiptRoutes } from "./routes/receipts.ts";
import { registerSessionRoutes } from "./routes/sessions.ts";
import { registerUsageRoutes } from "./routes/usage.ts";

// Routes the OpenAPI table declares but no Hono handler serves yet. Shrink
// this list as sibling tickets land; a route removed from here must exist.
const NOT_YET_IMPLEMENTED: string[] = [];

function honoRoutes(): Set<string> {
  const auth = {
    identity: {} as IdentityStore,
    bootstrap: {} as BootstrapGate,
  };
  const app = createApiApp({
    authMode: "none",
    registerPublicRoutes: (router) => registerPublicAuthRoutes(router, auth),
    registerRoutes: (router) => {
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

function openApiRoutes(): Set<string> {
  return new Set(
    Object.entries(buildOpenApiDocument().paths).flatMap(([path, operations]) =>
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

// The statuses themselves are compared where the handlers answer them: each
// route test file records its responses (route-error-coverage.ts).
test("every Hono handler has one test file that checks its error statuses", () => {
  const owned = Object.values(ROUTE_ERROR_TESTS).flat();
  expect(owned.length, "a route is owned by two files").toBe(
    new Set(owned).size,
  );
  expect(owned.sort()).toEqual([...honoRoutes()].sort());
});

test("OpenAPI routes without a handler are exactly the pending list", () => {
  const served = honoRoutes();
  const pending = [...openApiRoutes()].filter((route) => !served.has(route));
  expect(pending.sort()).toEqual([...NOT_YET_IMPLEMENTED].sort());
});
