import type {
  AuthorizationAction,
  Principal,
  SessionScope,
} from "@agent-platform/contracts";
import { ACTION_SCOPES } from "@agent-platform/platform";
import { API_ROUTE_SCOPES } from "./openapi.ts";

// Which session scope a /v1 request needs, read from the OpenAPI route table
// so the document and the check cannot drift. Checked after authentication
// and CSRF but before the body or any resource is read: a key without the
// scope learns nothing about the session it named, and the owner check that
// follows still answers 404 for another owner's resource.
//
// The first refusal only: every session service asks the platform policy
// again before it reads anything, so a caller without HTTP is refused too.

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

// The edge names the action it refused when it asks the policy to record
// that refusal, so a scope two actions need would be ambiguous.
const ACTION_FOR_SCOPE = new Map<SessionScope, AuthorizationAction>();
for (const [action, scope] of Object.entries(ACTION_SCOPES)) {
  if (ACTION_FOR_SCOPE.has(scope)) {
    throw new Error(`${scope} is needed by more than one action`);
  }
  ACTION_FOR_SCOPE.set(scope, action as AuthorizationAction);
}

export function actionForScope(scope: SessionScope): AuthorizationAction {
  const action = ACTION_FOR_SCOPE.get(scope);
  if (action === undefined) throw new Error(`no action needs ${scope}`);
  return action;
}

// What the check adds to every scoped route's error table.
export const scopedRouteErrors = [403];
