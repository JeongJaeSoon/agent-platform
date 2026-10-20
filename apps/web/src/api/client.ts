// Kept so imports from this path keep working; the client lives in
// @agent-platform/client.
export {
  type ApiClient,
  type ApiClientOptions,
  ApiError,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  createApiClient,
  isApiError,
  unwrap,
} from "@agent-platform/client";
