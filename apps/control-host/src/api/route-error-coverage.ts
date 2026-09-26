import { afterAll, expect } from "bun:test";
import {
  API_ROUTE_SCOPES,
  buildOpenApiDocument,
} from "@agent-platform/contracts";
import {
  bodyRouteErrors,
  createApiApp,
  globalRouteErrors,
  mutationRouteErrors,
  rootRouteErrors,
} from "./app.ts";
import { scopedRouteErrors } from "./scope-policy.ts";

// The test file whose requests must produce every error status a route's
// handler declares. The OpenAPI parity test holds the keys' union to the
// routes Hono serves.
export const ROUTE_ERROR_TESTS: Record<string, string[]> = {
  "app.test.ts": ["GET /v1"],
  "probes.test.ts": ["GET /healthz", "GET /readyz"],
  "auth.test.ts": [
    "POST /v1/auth/bootstrap",
    "POST /v1/auth/login",
    "POST /v1/auth/logout",
    "GET /v1/auth/me",
  ],
  "sessions.test.ts": [
    "POST /v1/sessions",
    "GET /v1/sessions",
    "GET /v1/sessions/{id}",
    "POST /v1/sessions/{id}/messages",
    "GET /v1/sessions/{id}/turns",
    "GET /v1/sessions/{id}/turns/{turn_id}",
    "POST /v1/sessions/{id}/terminate",
    "POST /v1/sessions/{id}/resume",
    "POST /v1/sessions/{id}/recovery-decisions",
  ],
  "receipts.test.ts": ["GET /v1/receipts/{id}"],
  "pending.test.ts": [
    "GET /v1/sessions/{id}/pending-requests",
    "POST /v1/sessions/{id}/answers",
  ],
  "interrupt.test.ts": ["POST /v1/sessions/{id}/interrupt"],
  "pause.test.ts": ["POST /v1/sessions/{id}/pause"],
  "usage.test.ts": ["GET /v1/limits", "GET /v1/sessions/{id}/usage"],
  "events.test.ts": ["GET /v1/sessions/{id}/events"],
};

// Declared for clients but produced by nothing yet: alpha never trims
// events, so no cursor expires.
const DECLARED_ONLY: Record<string, number[]> = {
  "GET /v1/sessions/{id}/events": [410],
};

const SCOPED = new Set(
  API_ROUTE_SCOPES.map((route) => `${route.method} ${route.path}`),
);

type Operation = {
  route: string;
  pattern: RegExp;
  errors: number[];
  authenticated: boolean;
};

const OPERATIONS: Operation[] = Object.entries(
  buildOpenApiDocument().paths,
).flatMap(([path, operations]) =>
  Object.entries(operations).map(([method, operation]) => {
    const { responses, security } = operation as {
      responses: object;
      security?: unknown[];
    };
    return {
      route: `${method.toUpperCase()} ${path}`,
      pattern: new RegExp(
        `^${method.toUpperCase()} ${path.replace(/\{\w+\}/g, "[^/]+")}$`,
      ),
      errors: Object.keys(responses)
        .map(Number)
        .filter((status) => status >= 400),
      authenticated: (security?.length ?? 0) > 0,
    };
  }),
);

// What the app answers around a handler: the error hook everywhere, the
// auth middleware on authenticated routes, the body deadline and the cookie
// CSRF refusal on POSTs, and the scope check.
function middlewareErrors(operation: Operation): number[] {
  const post = operation.route.startsWith("POST /v1");
  return [
    ...globalRouteErrors,
    ...(operation.authenticated ? rootRouteErrors : []),
    ...(post ? bodyRouteErrors : []),
    ...(post && operation.authenticated ? mutationRouteErrors : []),
    ...(SCOPED.has(operation.route) ? scopedRouteErrors : []),
  ];
}

/**
 * A `createApiApp` that records the status of every error response its
 * `request` returns. After the file's tests, each route the file owns in
 * ROUTE_ERROR_TESTS must have answered every status its OpenAPI operation
 * declares beyond what the middleware adds, and no route may have answered
 * a status its operation does not declare.
 */
export function recordRouteErrors(file: string): typeof createApiApp {
  const owned = ROUTE_ERROR_TESTS[file];
  if (!owned) throw new Error(`${file} owns no routes in ROUTE_ERROR_TESTS`);
  const seen = new Map<string, Set<number>>();
  afterAll(() => {
    const undeclared: string[] = [];
    const unproduced: string[] = [];
    for (const operation of OPERATIONS) {
      const observed = seen.get(operation.route) ?? new Set();
      for (const status of observed) {
        if (!operation.errors.includes(status)) {
          undeclared.push(`${operation.route} ${status}`);
        }
      }
      if (!owned.includes(operation.route)) continue;
      const exempt = new Set([
        ...middlewareErrors(operation),
        ...(DECLARED_ONLY[operation.route] ?? []),
      ]);
      for (const status of operation.errors) {
        if (!exempt.has(status) && !observed.has(status)) {
          unproduced.push(`${operation.route} ${status}`);
        }
      }
    }
    expect(undeclared, "answered but not declared in OpenAPI").toEqual([]);
    expect(unproduced, `declared but no test in ${file} produced it`).toEqual(
      [],
    );
  });
  return (options) => {
    const app = createApiApp(options);
    const request = app.request.bind(app);
    app.request = async (input, init, ...rest) => {
      const response = await request(input, init, ...rest);
      if (response.status >= 400) {
        const method =
          init?.method ?? (input instanceof Request ? input.method : "GET");
        const url = input instanceof Request ? input.url : String(input);
        const target = `${method.toUpperCase()} ${new URL(url, "http://localhost").pathname}`;
        const operation = OPERATIONS.find((candidate) =>
          candidate.pattern.test(target),
        );
        if (operation) {
          const statuses = seen.get(operation.route) ?? new Set();
          statuses.add(response.status);
          seen.set(operation.route, statuses);
        }
      }
      return response;
    };
    return app;
  };
}
