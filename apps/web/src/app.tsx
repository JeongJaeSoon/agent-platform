import { QueryClientProvider } from "@tanstack/react-query";
import { type RouterHistory, RouterProvider } from "@tanstack/react-router";
import { useState } from "react";
import { I18nProvider, type Locale } from "./i18n/i18n.tsx";
import { createAppRouter } from "./router.tsx";
import {
  createServices,
  type Services,
  ServicesProvider,
} from "./services.tsx";

export interface AppProps {
  readonly services?: Services;
  readonly history?: RouterHistory;
  readonly locale?: Locale;
}

export function App({ services: given, history, locale }: AppProps) {
  const [services] = useState(() => given ?? createServices());
  const [router] = useState(() => {
    const created = createAppRouter(services, history);
    services.onUnauthorized = () => {
      const { pathname, href } = created.state.location;
      if (pathname === "/login" || pathname === "/bootstrap") return;
      services.queryClient.clear();
      void created.navigate({ to: "/login", search: { redirect: href } });
    };
    return created;
  });
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
