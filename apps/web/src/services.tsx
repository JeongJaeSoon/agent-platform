import type { QueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext } from "react";
import type { ApiClient } from "./api/client.ts";

/** What every screen reaches the server through; tests pass their own. */
export interface Services {
  readonly client: ApiClient;
  readonly queryClient: QueryClient;
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
