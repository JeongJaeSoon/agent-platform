import type { Decorator, Preview } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  AgentPlatformProvider,
  LOCALES,
  type Locale,
  type RenderLink,
} from "@werft-ai/react";
import { type ReactNode, useMemo, useState } from "react";
import { type FakeRoutes, fakeClient } from "./fake-client.ts";

import "./preview.css";

// tokens.css keys dark off `data-theme` on <html>; set it explicitly either
// way so a dark OS does not turn the light stories dark.
const withTheme: Decorator = (Story, { globals }) => {
  document.documentElement.dataset.theme =
    globals.theme === "dark" ? "dark" : "light";
  return <Story />;
};

const renderLink: RenderLink = ({ to, id, ...anchor }) => (
  <a href={`#${to}/${id}`} {...anchor} />
);

function Platform({
  locale,
  routes,
  children,
}: {
  readonly locale: Locale;
  readonly routes: FakeRoutes | undefined;
  readonly children: ReactNode;
}) {
  // One cache per story, so one story's answers never show in the next.
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  const client = useMemo(() => fakeClient(routes), [routes]);
  return (
    <QueryClientProvider client={queryClient}>
      <AgentPlatformProvider
        client={client}
        locale={locale}
        renderLink={renderLink}
      >
        {children}
      </AgentPlatformProvider>
    </QueryClientProvider>
  );
}

/** A story names its requests in `parameters.api`; see fake-client.ts. */
const withPlatform: Decorator = (Story, { globals, parameters }) => {
  const locale: Locale = LOCALES.includes(globals.locale)
    ? globals.locale
    : "ko";
  document.documentElement.lang = locale;
  return (
    <Platform locale={locale} routes={parameters.api as FakeRoutes | undefined}>
      <Story />
    </Platform>
  );
};

const preview: Preview = {
  decorators: [withTheme, withPlatform],
  globalTypes: {
    locale: {
      description: "Language",
      toolbar: {
        title: "Language",
        icon: "globe",
        items: [
          { value: "ko", title: "한국어" },
          { value: "ja", title: "日本語" },
          { value: "en", title: "English" },
        ],
        dynamicTitle: true,
      },
    },
    theme: {
      description: "Colour theme",
      toolbar: {
        title: "Theme",
        icon: "mirror",
        items: [
          { value: "light", title: "Light" },
          { value: "dark", title: "Dark" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: "light", locale: "ko" },
  parameters: {
    layout: "padded",
    // `error` fails the story's test on any axe violation, so CI's a11y
    // check is the story run itself.
    a11y: { test: "error" },
    viewport: {
      options: {
        mobile390: {
          name: "Mobile 390",
          styles: { width: "390px", height: "844px" },
          type: "mobile",
        },
        narrow360: {
          name: "Narrowest 360",
          styles: { width: "360px", height: "780px" },
          type: "mobile",
        },
        tablet768: {
          name: "Tablet 768",
          styles: { width: "768px", height: "1024px" },
          type: "tablet",
        },
        desktop1440: {
          name: "Desktop 1440",
          styles: { width: "1440px", height: "900px" },
          type: "desktop",
        },
      },
    },
  },
};

export default preview;
