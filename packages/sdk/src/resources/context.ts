import type { ApiClient } from "@werft-ai/client";
import type { RetryPolicy } from "../core/request.ts";

export interface Context {
  api: ApiClient;
  policy: RetryPolicy;
}
