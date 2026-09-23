import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { OPENAPI_OUTPUT_PATH } from "../scripts/generate-openapi.ts";
import { buildOpenApiDocument, renderOpenApiDocument } from "./openapi.ts";

describe("OpenAPI document", () => {
  test("is committed and matches the generator output", () => {
    expect(readFileSync(OPENAPI_OUTPUT_PATH, "utf8")).toBe(
      renderOpenApiDocument(),
    );
  });

  test("every cookie-authenticated mutation documents the CSRF header and 403", () => {
    const document = buildOpenApiDocument();
    const checked: string[] = [];
    for (const [path, operations] of Object.entries(document.paths)) {
      for (const [method, raw] of Object.entries(operations)) {
        const operation = raw as {
          security: Array<Record<string, string[]>>;
          parameters: Array<{ name: string; in: string; required: boolean }>;
          responses: Record<string, unknown>;
        };
        const cookie = operation.security.some((s) => "cookieSession" in s);
        const header = operation.parameters.find(
          (p) => p.in === "header" && p.name === "X-Requested-With",
        );
        if (path === "/v1/auth/login") {
          // Login sets the cookie, so every caller sends the header.
          expect(header?.required, path).toBe(true);
          expect(operation.responses, path).toHaveProperty("403");
        } else if (method === "post" && cookie) {
          checked.push(`${method} ${path}`);
          expect(header?.required, path).toBe(false);
          expect(operation.responses, path).toHaveProperty("403");
        } else {
          expect(header, `${method} ${path}`).toBeUndefined();
        }
      }
    }
    expect(checked).toContain("post /v1/sessions");
    expect(checked).toContain("post /v1/auth/logout");
    expect(checked).not.toContain("post /v1/auth/login");
  });

  test("documents every api.md endpoint with $ref components", () => {
    const document = buildOpenApiDocument();
    expect(Object.keys(document.paths).sort()).toEqual(
      [
        "/healthz",
        "/readyz",
        "/v1",
        "/v1/auth/bootstrap",
        "/v1/auth/login",
        "/v1/auth/logout",
        "/v1/auth/me",
        "/v1/limits",
        "/v1/receipts/{id}",
        "/v1/sessions",
        "/v1/sessions/{id}",
        "/v1/sessions/{id}/answers",
        "/v1/sessions/{id}/events",
        "/v1/sessions/{id}/interrupt",
        "/v1/sessions/{id}/messages",
        "/v1/sessions/{id}/pause",
        "/v1/sessions/{id}/pending-requests",
        "/v1/sessions/{id}/recovery-decisions",
        "/v1/sessions/{id}/resume",
        "/v1/sessions/{id}/terminate",
        "/v1/sessions/{id}/turns",
        "/v1/sessions/{id}/turns/{turn_id}",
        "/v1/sessions/{id}/usage",
      ].sort(),
    );
    const rendered = renderOpenApiDocument();
    for (const name of [
      "ApiErrorResponse",
      "SessionDetail",
      "SessionDurability",
      "SseEvent",
      "Receipt",
      "PostSessionAnswerRequest",
    ]) {
      expect(rendered).toContain(`"#/components/schemas/${name}"`);
    }
    expect(rendered).not.toContain('"$schema"');
    expect(JSON.stringify(document.paths["/v1/sessions"]?.post)).toContain(
      "Idempotency-Key",
    );
    expect(
      JSON.stringify(document.paths["/v1/sessions/{id}/events"]?.get),
    ).toContain("text/event-stream");
  });

  test("every operation declares the shared 500 response", () => {
    const document = buildOpenApiDocument();
    expect(document.components.responses.InternalError).toBeDefined();
    for (const [path, operations] of Object.entries(document.paths)) {
      for (const [method, raw] of Object.entries(operations)) {
        const { responses } = raw as { responses: Record<string, unknown> };
        expect(responses["500"], `${method} ${path}`).toEqual({
          $ref: "#/components/responses/InternalError",
        });
      }
    }
  });

  test("widening the receipt target keeps every alpha response valid", () => {
    const receipt = buildOpenApiDocument().components.schemas.Receipt as {
      required: string[];
      properties: {
        target_ref: { anyOf: { required: string[] }[] };
      };
    };
    // A client written against alpha still validates: the session shape is a
    // branch of the union, and the new actor field is not required.
    expect(receipt.properties.target_ref.anyOf[0]?.required).toEqual([
      "session_id",
      "turn_id",
      "request_id",
    ]);
    expect(receipt.properties.target_ref.anyOf[1]?.required).toEqual([
      "resource",
      "workspace_id",
    ]);
    expect(receipt.required).not.toContain("actor");
  });
});
