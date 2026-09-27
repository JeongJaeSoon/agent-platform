import { expect, test } from "bun:test";
import type {
  InterruptService,
  PendingRequestService,
  SessionService,
  UsageService,
} from "@agent-platform/platform";
import { createApiApp } from "./app.ts";
import type { BootstrapGate, IdentityStore } from "./auth.ts";
import { API_ROUTE_SCOPES, buildOpenApiDocument } from "./openapi.ts";
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
// The API reference UI and its same-origin asset are public documentation,
// not API operations. Keep this exception explicit so adding another Hono
// handler still requires either an OpenAPI declaration or a reviewed reason.
const NON_API_ROUTES = new Set(["GET /docs", "GET /docs/scalar.js"]);

function apiApp() {
  const auth = {
    identity: {} as IdentityStore,
    bootstrap: {} as BootstrapGate,
  };
  return createApiApp({
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
}

function registeredHonoRoutes(): Set<string> {
  const app = apiApp();
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

function honoRoutes(): Set<string> {
  return new Set(
    [...registeredHonoRoutes()].filter((route) => !NON_API_ROUTES.has(route)),
  );
}

function routesFromDocument(paths: Record<string, object>): Set<string> {
  return new Set(
    Object.entries(paths).flatMap(([path, operations]) =>
      Object.keys(operations).map(
        (method) => `${method.toUpperCase()} ${path}`,
      ),
    ),
  );
}

function openApiRoutes(): Set<string> {
  return routesFromDocument(buildOpenApiDocument().paths);
}

test("every Hono handler is declared in the OpenAPI route table", () => {
  const declared = openApiRoutes();
  for (const route of honoRoutes()) {
    expect(declared, `${route} is served but not in OpenAPI`).toContain(route);
  }
});

test("only the documentation UI routes are excluded from OpenAPI", () => {
  const served = registeredHonoRoutes();
  for (const route of NON_API_ROUTES) {
    expect(served).toContain(route);
    expect(openApiRoutes()).not.toContain(route);
  }
});

test("the production OpenAPIHono registry contains every declared route", () => {
  const document = apiApp().getOpenAPI31Document({
    openapi: "3.1.0",
    info: { title: "test", version: "test" },
  });
  expect(routesFromDocument(document.paths ?? {})).toEqual(openApiRoutes());
});

// The statuses themselves are compared where the handlers answer them: each
// route test file records its responses (route-error-coverage.ts).
test("every Hono handler has one test file that checks its error statuses", async () => {
  const owned = Object.values(ROUTE_ERROR_TESTS).flat();
  expect(owned.length, "a route is owned by two files").toBe(
    new Set(owned).size,
  );
  expect(owned.sort()).toEqual([...honoRoutes()].sort());
  for (const file of Object.keys(ROUTE_ERROR_TESTS)) {
    const source = await Bun.file(`${import.meta.dir}/${file}`).text();
    expect(source, `${file} does not record its route errors`).toContain(
      `recordRouteErrors("${file}")`,
    );
  }
});

test("OpenAPI routes without a handler are exactly the pending list", () => {
  const served = honoRoutes();
  const pending = [...openApiRoutes()].filter((route) => !served.has(route));
  expect(pending.sort()).toEqual([...NOT_YET_IMPLEMENTED].sort());
});

test("every OpenAPI x-scope matches the enforced scope map", () => {
  const documented = Object.entries(buildOpenApiDocument().paths).flatMap(
    ([path, operations]) =>
      Object.entries(operations).flatMap(([method, raw]) => {
        const scope = (raw as { "x-scope"?: string })["x-scope"];
        return scope ? [{ method: method.toUpperCase(), path, scope }] : [];
      }),
  );
  expect(documented).toEqual([...API_ROUTE_SCOPES]);
});
