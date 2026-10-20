import createClient, { type Client, type Middleware } from "openapi-fetch";
import {
  type ContractOptions,
  type ContractPolicy,
  contractPolicy,
  type OperationKey,
} from "./contract.ts";
import type { paths } from "./schema.gen.ts";

export type ApiClient = Client<paths>;

/**
 * There is deliberately no API key option: a key never belongs in a browser,
 * and a server-side caller sets `authorization` through `headers` or `fetch`.
 */
export interface ApiClientOptions extends ContractOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  /** Defaults to same-origin, the web console's login cookie. */
  readonly credentials?: "omit" | "same-origin" | "include";
  /** Sent with every request and every event stream. */
  readonly headers?: Readonly<Record<string, string>>;
}

export const CSRF_HEADER_NAME = "x-requested-with";
export const CSRF_HEADER_VALUE = "agent-platform-web";

// The server asks for it on cookie requests only and ignores it elsewhere, so
// any request that may carry a cookie sends it.
const csrfHeader: Middleware = {
  onRequest({ request }) {
    request.headers.set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
    return request;
  },
};

const policies = new WeakMap<ApiClient, ContractPolicy>();

/** The contract policy a client was made with; streams apply it too. */
export function policyOf(client: ApiClient): ContractPolicy {
  const policy = policies.get(client);
  // Falling back to "off" would turn a strict test client into an unchecked
  // one without a word.
  if (!policy) throw new TypeError("client was not made by createApiClient");
  return policy;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const credentials = options.credentials ?? "same-origin";
  const client = createClient<paths>({
    baseUrl: options.baseUrl ?? "",
    credentials,
    ...(options.headers ? { headers: { ...options.headers } } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  if (credentials !== "omit") client.use(csrfHeader);
  const policy = contractPolicy(options);
  policies.set(client, policy);
  if (policy.mode !== "off") client.use(contractCheck(policy));
  return client;
}

function contractCheck(policy: ContractPolicy): Middleware {
  return {
    async onResponse({ request, response, schemaPath }) {
      const operation = `${request.method} ${schemaPath}`;
      const validator =
        policy.validators.responses?.[operation as OperationKey];
      if (!validator || !response.ok || response.status === 204) return;
      const requestId = response.headers.get("x-request-id");
      // Parsed whatever the content type says, as openapi-fetch does: a
      // mislabelled body must not slip past the check.
      let body: unknown;
      try {
        body = JSON.parse(await response.clone().text());
      } catch {
        policy.report(
          { operation, issues: [{ path: "", message: "body is not JSON" }] },
          response.status,
          requestId,
        );
        return;
      }
      policy.check(operation, validator, body, response.status, requestId);
    },
  };
}
