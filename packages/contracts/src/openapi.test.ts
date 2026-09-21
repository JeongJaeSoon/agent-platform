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

  test("documents every api.md endpoint with $ref components", () => {
    const document = buildOpenApiDocument();
    expect(Object.keys(document.paths).sort()).toEqual(
      [
        "/healthz",
        "/readyz",
        "/v1",
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
});
