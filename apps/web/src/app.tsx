import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RouterHistory, RouterProvider } from "@tanstack/react-router";
import { useState } from "react";
import { createApiClient } from "./api/client.ts";
import { I18nProvider, type Locale } from "./i18n/i18n.tsx";
import { createAppRouter } from "./router.tsx";
import { type Services, ServicesProvider } from "./services.tsx";

export function createServices(): Services {
  return { client: createApiClient(), queryClient: new QueryClient() };
}

export interface AppProps {
  readonly services?: Services;
  readonly history?: RouterHistory;
  readonly locale?: Locale;
}

export function App({ services: given, history, locale }: AppProps) {
  const [services] = useState(() => given ?? createServices());
  const [router] = useState(() => createAppRouter(services, history));
  return (
    <I18nProvider {...(locale ? { locale } : {})}>
      <QueryClientProvider client={services.queryClient}>
        <ServicesProvider services={services}>
          <RouterProvider router={router} />
        </ServicesProvider>
      </QueryClientProvider>
    </I18nProvider>
  );
}
