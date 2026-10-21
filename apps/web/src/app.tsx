import { AgentPlatformProvider, type RenderLink } from "@agent-platform/react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  Link,
  type RouterHistory,
  RouterProvider,
} from "@tanstack/react-router";
import { type ReactNode, useCallback, useState } from "react";
import { I18nProvider, type Locale, useI18n } from "./i18n/i18n.tsx";
import { createAppRouter } from "./router.tsx";
import { createServices, type Services } from "./services.tsx";

export interface AppProps {
  readonly services?: Services;
  readonly history?: RouterHistory;
  readonly locale?: Locale;
}

const renderLink: RenderLink = ({ id, children }) => (
  <Link to="/sessions/$id" params={{ id }}>
    {children}
  </Link>
);

function Platform({
  services,
  children,
}: {
  readonly services: Services;
  readonly children: ReactNode;
}) {
  const { locale } = useI18n();
  // Read at call time: App sets services.onUnauthorized once its router exists.
  const onUnauthorized = useCallback(
    () => services.onUnauthorized(),
    [services],
  );
  return (
    <AgentPlatformProvider
      client={services.client}
      locale={locale}
      renderLink={renderLink}
      onUnauthorized={onUnauthorized}
      {...(services.eventRetry ? { eventRetry: services.eventRetry } : {})}
    >
      {children}
    </AgentPlatformProvider>
  );
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
        <Platform services={services}>
          <RouterProvider router={router} />
        </Platform>
      </QueryClientProvider>
    </I18nProvider>
  );
}
