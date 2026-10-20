import type { RetryTiming } from "@agent-platform/client";
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext } from "react";
import {
  type ApiClient,
  type ApiClientOptions,
  createApiClient,
  isApiError,
} from "./api/client.ts";

export interface Services {
  readonly client: ApiClient;
  readonly queryClient: QueryClient;
  /** Reconnect timing of session event streams; tests shorten it. */
  readonly eventRetry?: RetryTiming;
  /** Set by the app once its router exists; a 401 anywhere calls it. */
  onUnauthorized: () => void;
  /** Leaves the app for another site (an identity provider's consent page). */
  readonly leave: (url: string) => void;
}

/**
 * A 401 from any query, or from any mutation not marked `meta.public` (login
 * and bootstrap answer 401 for a wrong password or token), means the session
 * is gone: cached data would keep showing the old identity otherwise.
 */
export function createServices(
  options: ApiClientOptions & {
    readonly leave?: (url: string) => void;
    readonly eventRetry?: RetryTiming;
  } = {},
): Services {
  const services: Services = {
    // A production answer outside the contract is logged, not thrown: the
    // screen keeps the value as it came.
    client: createApiClient({
      validate: import.meta.env.DEV ? "strict" : "warn",
      ...options,
    }),
    ...(options.eventRetry ? { eventRetry: options.eventRetry } : {}),
    queryClient: new QueryClient({
      queryCache: new QueryCache({
        onError: (error) => {
          if (isApiError(error, "UNAUTHORIZED")) services.onUnauthorized();
        },
      }),
      mutationCache: new MutationCache({
        onError: (error, _variables, _context, mutation) => {
          if (
            mutation.meta?.public !== true &&
            isApiError(error, "UNAUTHORIZED")
          )
            services.onUnauthorized();
        },
      }),
    }),
    onUnauthorized: () => {},
    leave: options.leave ?? ((url) => window.location.assign(url)),
  };
  return services;
}

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider({
  services,
  children,
}: {
  readonly services: Services;
  readonly children: ReactNode;
}) {
  return <ServicesContext value={services}>{children}</ServicesContext>;
}

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (!services) throw new Error("useServices outside ServicesProvider");
  return services;
}
