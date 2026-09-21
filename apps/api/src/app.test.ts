import { describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  healthResponseSchema,
  postSessionMessageRequestSchema,
} from "@agent-platform/contracts";
import { MemoryLogSink, StructuredLogger } from "@agent-platform/observability";
import { createApiApp, jsonWithSchema, parseJsonBody } from "./app.ts";
import { type ApiKeyStore, hashApiKey } from "./keys.ts";

function loggerWithMemory(): {
  logger: StructuredLogger;
  sink: MemoryLogSink;
} {
  const sink = new MemoryLogSink();
  return { logger: new StructuredLogger({ sinks: [sink] }), sink };
}

describe("API authentication", () => {
  test("fails closed when AUTH_MODE is missing and ignores X-Owner-Id", async () => {
    const previous = process.env.AUTH_MODE;
    delete process.env.AUTH_MODE;
    try {
      const app = createApiApp();
      const response = await app.request("/v1", {
        headers: { "X-Owner-Id": "forged-owner" },
      });
      expect(response.status).toBe(401);
      expect(apiErrorResponseSchema.parse(await response.json())).toMatchObject(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "Authentication is required",
            retryable: false,
            details: null,
          },
        },
      );
    } finally {
      if (previous === undefined) {
        delete process.env.AUTH_MODE;
      } else {
        process.env.AUTH_MODE = previous;
      }
    }
  });

  test("treats an unknown AUTH_MODE as authenticated mode", async () => {
    const app = createApiApp({ authMode: "unexpected" });
    const response = await app.request("/v1", {
      headers: { "X-Owner-Id": "forged-owner" },
    });
    expect(response.status).toBe(401);
  });

  test("accepts one bearer key and passes its owner to the handler", async () => {
    const plaintext = "csp_test_key";
    const expectedHash = hashApiKey(plaintext);
    let receivedHash: Uint8Array | undefined;
    const keyStore: ApiKeyStore = {
      async findOwner(keyHash) {
        receivedHash = keyHash;
        return Buffer.from(keyHash).equals(Buffer.from(expectedHash))
          ? "owner-a"
          : null;
      },
    };
    const app = createApiApp({ authMode: "api-key", keyStore });

    const accepted = await app.request("/v1", {
      headers: { Authorization: `Bearer ${plaintext}` },
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({
      status: "ok",
      owner_id: "owner-a",
    });
    expect(
      (
        await app.request("/v1/", {
          headers: { Authorization: `Bearer ${plaintext}` },
        })
      ).status,
    ).toBe(200);
    expect(receivedHash).toEqual(expectedHash);
    expect(new TextDecoder().decode(receivedHash)).not.toContain(plaintext);

    const rejected = await app.request("/v1", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(rejected.status).toBe(401);
  });

  test("trusts X-Owner-Id only in explicit local mode and warns", async () => {
    const { logger, sink } = loggerWithMemory();
    const app = createApiApp({ authMode: "none", logger });
    const response = await app.request("/v1", {
      headers: { "X-Owner-Id": "local-owner" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      owner_id: "local-owner",
    });
    expect(sink.records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "API authentication is disabled",
      }),
    );
  });
});

describe("API validation and errors", () => {
  test("rejects unknown request fields through the contracts schema", async () => {
    const app = createApiApp({
      authMode: "none",
      registerRoutes(router) {
        router.post("/echo", async (context) => {
          await parseJsonBody(context, postSessionMessageRequestSchema);
          return jsonWithSchema(context, healthResponseSchema, {
            status: "ok",
          });
        });
      },
    });
    const response = await app.request("/v1/echo", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Owner-Id": "local-owner",
      },
      body: JSON.stringify({ message: "hello", unexpected: true }),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("X-Request-Id")).toHaveLength(36);
    expect(
      apiErrorResponseSchema.safeParse(await response.json()).success,
    ).toBe(true);

    const oversized = await app.request("/v1/echo", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Owner-Id": "local-owner",
      },
      body: JSON.stringify({ message: "x".repeat(65 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    expect(
      apiErrorResponseSchema.parse(await oversized.json()).error.code,
    ).toBe("PAYLOAD_TOO_LARGE");
  });

  test("returns a stable 500 without exposing an error or stack", async () => {
    const app = createApiApp({
      authMode: "none",
      registerRoutes(router) {
        router.get("/explode", () => {
          throw new Error("sensitive implementation detail");
        });
      },
    });
    const response = await app.request("/v1/explode", {
      headers: { "X-Owner-Id": "local-owner" },
    });
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(apiErrorResponseSchema.safeParse(JSON.parse(text)).success).toBe(
      true,
    );
    expect(text).not.toContain("sensitive implementation detail");
    expect(text).not.toContain("app.test.ts");
  });

  test("validates responses before serializing them", async () => {
    const app = createApiApp({
      authMode: "none",
      registerRoutes(router) {
        router.get("/invalid-response", (context) =>
          jsonWithSchema(context, healthResponseSchema, {
            status: "wrong",
          } as never),
        );
      },
    });
    const response = await app.request("/v1/invalid-response", {
      headers: { "X-Owner-Id": "local-owner" },
    });
    expect(response.status).toBe(500);
    expect(
      apiErrorResponseSchema.safeParse(await response.json()).success,
    ).toBe(true);
  });
});
