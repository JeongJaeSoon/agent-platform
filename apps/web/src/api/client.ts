import {
  type ApiClient,
  type ApiClientOptions,
  createApiClient as createContractClient,
} from "@werft-ai/client";
import { contractValidators, warnOncePerIssue } from "@werft-ai/core/schemas";

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
