import { type ApiClient, createApiClient } from "@werft-ai/client";

type Handler = (request: Request) => Response | Promise<Response>;

/** What a story's screen asks for, by "METHOD /path". */
export type FakeRoutes = Readonly<Record<string, Handler>>;

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function apiError(status: number, code: string, message: string) {
  return json(status, {
    error: {
      code,
      message,
      retryable: false,
      request_id: "storybook",
      details: null,
    },
  });
}

/**
 * A client whose requests never leave the page: each is answered from the
 * story's routes, and anything the story did not name is a 404.
 */
export function fakeClient(routes: FakeRoutes = {}): ApiClient {
  const fetch = async (request: Request): Promise<Response> => {
    const key = `${request.method} ${new URL(request.url).pathname}`;
    const handler = routes[key];
    return handler
      ? handler(request)
      : apiError(404, "NOT_FOUND", `no fake for ${key}`);
  };
  return createApiClient({
    baseUrl: "https://storybook.invalid",
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
}
