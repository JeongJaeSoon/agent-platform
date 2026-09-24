import {
  API_ROUTE_SCOPES,
  type Principal,
  type SessionScope,
} from "@agent-platform/contracts";

// Which session scope a /v1 request needs, read from the OpenAPI route table
// so the document and the check cannot drift. Checked after authentication
// and CSRF but before the body or any resource is read: a key without the
// scope learns nothing about the session it named, and the owner check that
// follows still answers 404 for another owner's resource.
//
// Enforced here, at the only production entry into the session services.
// A caller that reaches those services without HTTP (a chat adapter, a job)
// is the trigger for moving this into the platform policy.

const TABLE = API_ROUTE_SCOPES.map((route) => ({
  method: route.method,
  // Path parameters are one segment; `strict: false` routing also serves
  // the path with a trailing slash.
  pattern: new RegExp(`^${route.path.replace(/\{\w+\}/g, "[^/]+")}/?$`),
  scope: route.scope,
}));

export function requiredScope(
  method: string,
  path: string,
): SessionScope | null {
  const verb = method === "HEAD" ? "GET" : method;
  return (
    TABLE.find((route) => route.method === verb && route.pattern.test(path))
      ?.scope ?? null
  );
}

/** The scope the principal lacks for this request, or null. */
export function missingScope(
  method: string,
  path: string,
  principal: Principal,
): SessionScope | null {
  const scope = requiredScope(method, path);
  if (scope === null) return null;
  return (principal.scopes as readonly SessionScope[]).includes(scope)
    ? null
    : scope;
}

// What the check adds to every scoped route's error table.
export const scopedRouteErrors = [403];
