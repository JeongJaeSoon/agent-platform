import { SessionServiceError } from "../sessions/session-service.ts";

export const NOT_FOUND = () =>
  new SessionServiceError("NOT_FOUND", "Resource not found");

export const ACTOR_INACTIVE = () =>
  new SessionServiceError(
    "FORBIDDEN",
    "This principal is no longer a member of the workspace",
  );

export const OUTRANKED = () =>
  new SessionServiceError(
    "FORBIDDEN",
    "The caller no longer holds this right",
    undefined,
    { reason_code: "role" },
  );
