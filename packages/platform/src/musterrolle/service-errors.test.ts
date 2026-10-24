import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { SessionServiceError } from "../sessions/session-service.ts";
import { ACTOR_INACTIVE, NOT_FOUND, OUTRANKED } from "./service-errors.ts";

const digest = (error: SessionServiceError) =>
  createHash("sha256")
    .update(JSON.stringify([error.name, error.message, error]))
    .digest("hex");

describe("shared service error compatibility", () => {
  test("agent-admin-service.ts NOT_FOUND", () => {
    const original = new SessionServiceError("NOT_FOUND", "Resource not found");
    const shared = NOT_FOUND();
    expect(shared).toBeInstanceOf(SessionServiceError);
    expect(digest(shared)).toBe(digest(original));
    expect(shared).not.toBe(NOT_FOUND());
  });
  test("agent-identity-service.ts NOT_FOUND", () => {
    const original = new SessionServiceError("NOT_FOUND", "Resource not found");
    const shared = NOT_FOUND();
    expect(shared).toBeInstanceOf(SessionServiceError);
    expect(digest(shared)).toBe(digest(original));
    expect(shared).not.toBe(NOT_FOUND());
  });
  test("agent-identity-service.ts OUTRANKED", () => {
    const original = new SessionServiceError(
      "FORBIDDEN",
      "The caller no longer holds this right",
      undefined,
      { reason_code: "role" },
    );
    const shared = OUTRANKED();
    expect(shared).toBeInstanceOf(SessionServiceError);
    expect(digest(shared)).toBe(digest(original));
    expect(shared).not.toBe(OUTRANKED());
  });
  test("agent-identity-service.ts ACTOR_INACTIVE", () => {
    const original = new SessionServiceError(
      "FORBIDDEN",
      "This principal is no longer a member of the workspace",
    );
    const shared = ACTOR_INACTIVE();
    expect(shared).toBeInstanceOf(SessionServiceError);
    expect(digest(shared)).toBe(digest(original));
    expect(shared).not.toBe(ACTOR_INACTIVE());
  });
  test("api-key-service.ts NOT_FOUND", () => {
    const original = new SessionServiceError("NOT_FOUND", "Resource not found");
    const shared = NOT_FOUND();
    expect(shared).toBeInstanceOf(SessionServiceError);
    expect(digest(shared)).toBe(digest(original));
    expect(shared).not.toBe(NOT_FOUND());
  });
  test("api-key-service.ts OUTRANKED", () => {
    const original = new SessionServiceError(
      "FORBIDDEN",
      "The caller no longer holds this right",
      undefined,
      { reason_code: "role" },
    );
    const shared = OUTRANKED();
    expect(shared).toBeInstanceOf(SessionServiceError);
    expect(digest(shared)).toBe(digest(original));
    expect(shared).not.toBe(OUTRANKED());
  });
  test("api-key-service.ts ACTOR_INACTIVE", () => {
    const original = new SessionServiceError(
      "FORBIDDEN",
      "This principal is no longer a member of the workspace",
    );
    const shared = ACTOR_INACTIVE();
    expect(shared).toBeInstanceOf(SessionServiceError);
    expect(digest(shared)).toBe(digest(original));
    expect(shared).not.toBe(ACTOR_INACTIVE());
  });
  test("credential-binding-service.ts NOT_FOUND", () => {
    const original = new SessionServiceError("NOT_FOUND", "Resource not found");
    const shared = NOT_FOUND();
    expect(shared).toBeInstanceOf(SessionServiceError);
    expect(digest(shared)).toBe(digest(original));
    expect(shared).not.toBe(NOT_FOUND());
  });
  test("credential-binding-service.ts OUTRANKED", () => {
    const original = new SessionServiceError(
      "FORBIDDEN",
      "The caller no longer holds this right",
      undefined,
      { reason_code: "role" },
    );
    const shared = OUTRANKED();
    expect(shared).toBeInstanceOf(SessionServiceError);
    expect(digest(shared)).toBe(digest(original));
    expect(shared).not.toBe(OUTRANKED());
  });
  test("credential-binding-service.ts ACTOR_INACTIVE", () => {
    const original = new SessionServiceError(
      "FORBIDDEN",
      "This principal is no longer a member of the workspace",
    );
    const shared = ACTOR_INACTIVE();
    expect(shared).toBeInstanceOf(SessionServiceError);
    expect(digest(shared)).toBe(digest(original));
    expect(shared).not.toBe(ACTOR_INACTIVE());
  });
  test("session-share-service.ts NOT_FOUND", () => {
    const original = new SessionServiceError("NOT_FOUND", "Resource not found");
    const shared = NOT_FOUND();
    expect(shared).toBeInstanceOf(SessionServiceError);
    expect(digest(shared)).toBe(digest(original));
    expect(shared).not.toBe(NOT_FOUND());
  });
  test("slack-app-service.ts NOT_FOUND", () => {
    const original = new SessionServiceError("NOT_FOUND", "Resource not found");
    const shared = NOT_FOUND();
    expect(shared).toBeInstanceOf(SessionServiceError);
    expect(digest(shared)).toBe(digest(original));
    expect(shared).not.toBe(NOT_FOUND());
  });
  test("slack-app-service.ts ACTOR_INACTIVE", () => {
    const original = new SessionServiceError(
      "FORBIDDEN",
      "This principal is no longer a member of the workspace",
    );
    const shared = ACTOR_INACTIVE();
    expect(shared).toBeInstanceOf(SessionServiceError);
    expect(digest(shared)).toBe(digest(original));
    expect(shared).not.toBe(ACTOR_INACTIVE());
  });
  test("slack-app-service.ts OUTRANKED", () => {
    const original = new SessionServiceError(
      "FORBIDDEN",
      "The caller no longer holds this right",
      undefined,
      { reason_code: "role" },
    );
    const shared = OUTRANKED();
    expect(shared).toBeInstanceOf(SessionServiceError);
    expect(digest(shared)).toBe(digest(original));
    expect(shared).not.toBe(OUTRANKED());
  });
  test("slack-install-service.ts NOT_FOUND", () => {
    const original = new SessionServiceError("NOT_FOUND", "Resource not found");
    const shared = NOT_FOUND();
    expect(shared).toBeInstanceOf(SessionServiceError);
    expect(digest(shared)).toBe(digest(original));
    expect(shared).not.toBe(NOT_FOUND());
  });
  test("slack-link-app-service.ts NOT_FOUND", () => {
    const original = new SessionServiceError("NOT_FOUND", "Resource not found");
    const shared = NOT_FOUND();
    expect(shared).toBeInstanceOf(SessionServiceError);
    expect(digest(shared)).toBe(digest(original));
    expect(shared).not.toBe(NOT_FOUND());
  });
  test("slack-link-app-service.ts ACTOR_INACTIVE", () => {
    const original = new SessionServiceError(
      "FORBIDDEN",
      "This principal is no longer a member of the workspace",
    );
    const shared = ACTOR_INACTIVE();
    expect(shared).toBeInstanceOf(SessionServiceError);
    expect(digest(shared)).toBe(digest(original));
    expect(shared).not.toBe(ACTOR_INACTIVE());
  });
  test("slack-link-app-service.ts OUTRANKED", () => {
    const original = new SessionServiceError(
      "FORBIDDEN",
      "The caller no longer holds this right",
      undefined,
      { reason_code: "role" },
    );
    const shared = OUTRANKED();
    expect(shared).toBeInstanceOf(SessionServiceError);
    expect(digest(shared)).toBe(digest(original));
    expect(shared).not.toBe(OUTRANKED());
  });
  test("slack-secret-service.ts ACTOR_INACTIVE", () => {
    const original = new SessionServiceError(
      "FORBIDDEN",
      "This principal is no longer a member of the workspace",
    );
    const shared = ACTOR_INACTIVE();
    expect(shared).toBeInstanceOf(SessionServiceError);
    expect(digest(shared)).toBe(digest(original));
    expect(shared).not.toBe(ACTOR_INACTIVE());
  });
  test("slack-secret-service.ts OUTRANKED", () => {
    const original = new SessionServiceError(
      "FORBIDDEN",
      "The caller no longer holds this right",
      undefined,
      { reason_code: "role" },
    );
    const shared = OUTRANKED();
    expect(shared).toBeInstanceOf(SessionServiceError);
    expect(digest(shared)).toBe(digest(original));
    expect(shared).not.toBe(OUTRANKED());
  });
  test("slack-secret-service.ts NOT_FOUND", () => {
    const original = new SessionServiceError("NOT_FOUND", "Resource not found");
    const shared = NOT_FOUND();
    expect(shared).toBeInstanceOf(SessionServiceError);
    expect(digest(shared)).toBe(digest(original));
    expect(shared).not.toBe(NOT_FOUND());
  });
  test("team-service.ts NOT_FOUND", () => {
    const original = new SessionServiceError("NOT_FOUND", "Resource not found");
    const shared = NOT_FOUND();
    expect(shared).toBeInstanceOf(SessionServiceError);
    expect(digest(shared)).toBe(digest(original));
    expect(shared).not.toBe(NOT_FOUND());
  });
  test("agent-service.ts NOT_FOUND", () => {
    const original = new SessionServiceError("NOT_FOUND", "Resource not found");
    const shared = NOT_FOUND();
    expect(shared).toBeInstanceOf(SessionServiceError);
    expect(digest(shared)).toBe(digest(original));
    expect(shared).not.toBe(NOT_FOUND());
  });
  test("agent-service.ts ACTOR_INACTIVE", () => {
    const original = new SessionServiceError(
      "FORBIDDEN",
      "This principal is no longer a member of the workspace",
    );
    const shared = ACTOR_INACTIVE();
    expect(shared).toBeInstanceOf(SessionServiceError);
    expect(digest(shared)).toBe(digest(original));
    expect(shared).not.toBe(ACTOR_INACTIVE());
  });
});
