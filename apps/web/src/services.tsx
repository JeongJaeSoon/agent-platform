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
  /** Set by the app once its router exists; a 401 anywhere calls it. */
  onUnauthorized: () => void;
}

/**
 * A 401 from any query, or from any mutation not marked `meta.public` (login
 * and bootstrap answer 401 for a wrong password or token), means the session
 * is gone: cached data would keep showing the old identity otherwise.
 */
export function createServices(options: ApiClientOptions = {}): Services {
  const services: Services = {
    client: createApiClient(options),
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
