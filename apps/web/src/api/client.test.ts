import { describe, expect, test } from "bun:test";
import {
  authMeResponseSchema,
  DISPLAY_NAME_MAX as CONTRACT_DISPLAY_NAME_MAX,
  CSRF_HEADER_NAME as CONTRACT_HEADER_NAME,
  CSRF_HEADER_VALUE as CONTRACT_HEADER_VALUE,
  PASSWORD_MIN_LENGTH as CONTRACT_PASSWORD_MIN_LENGTH,
} from "@agent-platform/contracts";
import { DISPLAY_NAME_MAX, PASSWORD_MIN_LENGTH } from "../auth/limits.ts";
import { apiError, fakeApi, json, me } from "../test-support/fake-api.ts";
import {
  ApiError,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  createApiClient,
  unwrap,
} from "./client.ts";

describe("API client", () => {
  test("the copied constants are the contract's", () => {
    expect(CSRF_HEADER_NAME).toBe(CONTRACT_HEADER_NAME);
    expect(CSRF_HEADER_VALUE).toBe(CONTRACT_HEADER_VALUE);
    expect(PASSWORD_MIN_LENGTH).toBe(CONTRACT_PASSWORD_MIN_LENGTH);
    expect(DISPLAY_NAME_MAX).toBe(CONTRACT_DISPLAY_NAME_MAX);
  });

  test("the test principal is one the server could send", () => {
    expect(authMeResponseSchema.safeParse(me()).success).toBe(true);
    expect(authMeResponseSchema.safeParse(me(["sessions:read"])).success).toBe(
      true,
    );
  });

  test("every request carries the CSRF header", async () => {
    const api = fakeApi({
      "GET /v1/auth/me": () => json(200, me()),
      "POST /v1/auth/logout": () => new Response(null, { status: 204 }),
    });
    const client = createApiClient({
      baseUrl: "https://console.test",
      fetch: api.fetch,
    });
    await unwrap(client.GET("/v1/auth/me"));
    await unwrap(client.POST("/v1/auth/logout"));
    expect(
      api.calls.map((call) => call.headers.get("x-requested-with")),
    ).toEqual(["agent-platform-web", "agent-platform-web"]);
  });

  test("a failure becomes an ApiError with the server's code and words", async () => {
    const api = fakeApi({
      "GET /v1/auth/me": () =>
        apiError(
          403,
          "FORBIDDEN",
          "This credential does not hold sessions:read",
        ),
    });
    const client = createApiClient({
      baseUrl: "https://console.test",
      fetch: api.fetch,
    });
    const error = await unwrap(client.GET("/v1/auth/me")).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: "This credential does not hold sessions:read",
      requestId: "req-1",
    });
  });

  test("an unreachable server is a NETWORK_ERROR, not a crash", async () => {
    const client = createApiClient({
      baseUrl: "https://console.test",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    const error = await unwrap(client.GET("/v1/auth/me")).catch((e) => e);
    expect(error).toMatchObject({ status: 0, code: "NETWORK_ERROR" });
  });
});
