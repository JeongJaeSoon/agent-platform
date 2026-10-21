import {
  type ApiClient,
  type ApiClientOptions,
  createApiClient as createContractClient,
} from "@agent-platform/client";
import {
  contractValidators,
  warnOncePerIssue,
} from "@agent-platform/core/schemas";

// Kept so imports from this path keep working; the client lives in
// @agent-platform/client.
export {
  type ApiClient,
  type ApiClientOptions,
  ApiError,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  isApiError,
  unwrap,
} from "@agent-platform/client";

/**
 * A client that holds every answer to the published contract. The mode stays
 * the caller's: off unless `validate` says otherwise.
 */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  return createContractClient({
    validators: contractValidators,
    onContractMismatch: warnOncePerIssue(),
    ...options,
  });
}
