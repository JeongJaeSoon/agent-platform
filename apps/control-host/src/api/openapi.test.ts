import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { API_ERROR_CODE_VALUES } from "@agent-platform/contracts";
import {
  API_REFERENCE_OUTPUT_PATH,
  OPENAPI_OUTPUT_PATH,
  renderApiReferenceDocument,
  renderScalarAsset,
  SCALAR_ASSET_OUTPUT_PATH,
} from "../../scripts/generate-openapi.ts";
import {
  buildOpenApiDocument,
  OPENAPI_TAGS,
  renderOpenApiDocument,
} from "./openapi.ts";

describe("OpenAPI document", () => {
  test("is committed and matches the generator output", () => {
    expect(readFileSync(OPENAPI_OUTPUT_PATH, "utf8")).toBe(
      renderOpenApiDocument(),
    );
  });

  test("keeps OpenAPIHono route metadata in a Bun production bundle", async () => {
    const outdir = await mkdtemp(join(tmpdir(), "openapi-bundle-"));
    try {
      const result = await Bun.build({
        entrypoints: [join(import.meta.dir, "app.ts")],
        outdir,
        target: "bun",
        format: "esm",
        minify: true,
        splitting: true,
        naming: "[name]-[hash].[ext]",
      });
      expect(result.success).toBe(true);
      const entry = result.outputs.find(
        (output) => output.kind === "entry-point",
      );
      expect(entry).toBeDefined();
      const bundled = (await import(
        `${pathToFileURL(entry?.path ?? "").href}?${crypto.randomUUID()}`
      )) as typeof import("./app.ts");
      const app = bundled.createApiApp({
        authMode: "none",
        registerRoutes(router) {
          bundled.apiRoute(router, "getInstallationLimits", () =>
            Promise.resolve(new Response()),
          );
        },
      });
      const document = app.getOpenAPI31Document({
        openapi: "3.1.0",
        info: { title: "test", version: "test" },
      });
      expect(Object.keys(document.paths ?? {}).sort()).toEqual(
        ["/healthz", "/readyz", "/v1", "/v1/limits", "/v1/openapi.json"].sort(),
      );
    } finally {
      await rm(outdir, { recursive: true, force: true });
    }
  });

  test("commits an offline read-only Scalar reference from the same document", () => {
    expect(readFileSync(API_REFERENCE_OUTPUT_PATH, "utf8")).toBe(
      renderApiReferenceDocument(),
    );
    expect(readFileSync(SCALAR_ASSET_OUTPUT_PATH, "utf8")).toBe(
      renderScalarAsset(),
    );
    const html = renderApiReferenceDocument();
    const scalarAsset = renderScalarAsset();
    expect(html).toContain('src="./scalar.js"');
    expect(html).toContain("&quot;disabled&quot;:true");
    expect(html).toContain("&quot;hideClientButton&quot;:true");
    expect(html).toContain("&quot;hideTestRequestButton&quot;:true");
    expect(html).toContain("&quot;showDeveloperTools&quot;:&quot;never&quot;");
    expect(html).toContain("&quot;showToolbar&quot;:&quot;never&quot;");
    expect(html).toContain("&quot;telemetry&quot;:false");
    expect(html).toContain("&quot;withDefaultFonts&quot;:false");
    expect(html).not.toMatch(/(?:src|href)="https?:\/\//);
    expect(html).not.toContain("Authorization");
    expect(scalarAsset).not.toContain("./chunks/");
  });

  test("groups every operation under exactly one declared tag", () => {
    const document = buildOpenApiDocument();
    expect(document.tags).toEqual(OPENAPI_TAGS);
    const declared = new Set<string>(document.tags.map((tag) => tag.name));
    const used = new Set<string>();

    for (const [path, operations] of Object.entries(document.paths)) {
      for (const [method, raw] of Object.entries(operations)) {
        const { tags } = raw as { tags?: string[] };
        expect(tags, `${method} ${path}`).toHaveLength(1);
        expect(declared.has(tags?.[0] ?? ""), `${method} ${path}`).toBe(true);
        if (tags?.[0]) used.add(tags[0]);
      }
    }

    expect([...used].sort()).toEqual([...declared].sort());
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
        "/v1/openapi.json",
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

  test("narrows every operation error response to its expected codes", () => {
    const document = buildOpenApiDocument();
    const known = new Set<string>(API_ERROR_CODE_VALUES);
    for (const [path, operations] of Object.entries(document.paths)) {
      for (const [method, raw] of Object.entries(operations)) {
        const { responses } = raw as {
          responses: Record<
            string,
            {
              $ref?: string;
              content?: {
                "application/json"?: {
                  schema?: {
                    allOf?: Array<{
                      properties?: {
                        error?: {
                          properties?: { code?: { enum?: string[] } };
                        };
                      };
                    }>;
                  };
                };
              };
            }
          >;
        };
        for (const [status, response] of Object.entries(responses)) {
          if (Number(status) < 400 || status === "500") continue;
          const codes =
            response.content?.["application/json"]?.schema?.allOf?.[1]
              ?.properties?.error?.properties?.code?.enum;
          expect(codes?.length, `${method} ${path} ${status}`).toBeGreaterThan(
            0,
          );
          for (const code of codes ?? []) {
            expect(known.has(code), `${method} ${path} ${status} ${code}`).toBe(
              true,
            );
          }
        }
      }
    }
    const bootstrap = document.paths["/v1/auth/bootstrap"]?.post as
      | { responses: Record<string, unknown> }
      | undefined;
    expect(bootstrap?.responses["409"]).toEqual(
      expect.objectContaining({ description: "Error: BOOTSTRAP_DONE" }),
    );
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
