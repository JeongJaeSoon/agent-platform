import { Werft } from "../client.ts";

export const BASE = "https://werft.test";
export const KEY = "test-key";

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function apiError(
  status: number,
  code: string,
  extra: { retryable?: boolean; details?: unknown } = {},
  headers: Record<string, string> = {},
): Response {
  return json(
    status,
    {
      error: {
        code,
        message: `${code} from the test server`,
        request_id: "req_1",
        retryable: extra.retryable ?? false,
        ...(extra.details === undefined ? {} : { details: extra.details }),
      },
    },
    headers,
  );
}

export interface Seen {
  url: string;
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
  signal: AbortSignal;
}

type Route = (request: Seen, url: URL) => Response | Promise<Response>;

/** A fetch that answers from `route` and records every request. */
export function fakeApi(route: Route) {
  const seen: Seen[] = [];
  const fetch = (async (input: Request) => {
    const url = new URL(input.url);
    const text = await input.text();
    const request: Seen = {
      url: input.url,
      method: input.method,
      path: url.pathname,
      headers: input.headers,
      body: text ? JSON.parse(text) : undefined,
      signal: input.signal,
    };
    seen.push(request);
    return route(request, url);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
}

export function werft(
  fetch: typeof globalThis.fetch,
  options: ConstructorParameters<typeof Werft>[0] = {},
): Werft {
  return new Werft({ apiKey: KEY, baseUrl: BASE, fetch, ...options });
}
