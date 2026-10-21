import { setupDom } from "@agent-platform/ui/test-support/dom";
import type { fakeApi as FakeApi } from "./fake-api.ts";

export type Routes = Parameters<typeof FakeApi>[0];

/** The route the shell's waiting badge asks, for a test to answer itself. */
export const WAITING_SESSIONS = "GET /v1/sessions?status=needs_input";

/**
 * The whole app at a path against a fake API. Call once per test file, at
 * the top level: the DOM has to exist before the router and Testing Library
 * load, so they are imported here, after setupDom.
 */
export async function appHarness() {
  const testing = await setupDom();
  const { createMemoryHistory } = await import("@tanstack/react-router");
  const { App } = await import("../app.tsx");
  const { createServices } = await import("../services.tsx");
  const { fakeApi, json } = await import("./fake-api.ts");
  const { contractValidators } = await import("./contract-validators.ts");

  function renderAt(path: string, routes: Routes, locale: "ko" | "en" = "ko") {
    // The shell's waiting badge reads on every signed-in screen; a test that
    // is not about it gets nothing waiting instead of its own list's answers.
    const api = fakeApi({
      [WAITING_SESSIONS]: () => json(200, { items: [], next_cursor: null }),
      ...routes,
    });
    const left: string[] = [];
    const services = createServices({
      baseUrl: "https://console.test",
      fetch: api.fetch,
      validate: "strict",
      validators: contractValidators,
      eventRetry: { initialMs: 1, maxMs: 4 },
      leave: (url) => left.push(url),
    });
    const history = createMemoryHistory({ initialEntries: [path] });
    const { container } = testing.render(
      <App services={services} history={history} locale={locale} />,
    );
    return { api, history, services, container, left };
  }

  // Testing Library's own `screen` is bound to the document that existed when
  // it was first imported, which in a multi-file run is an earlier file's.
  // These queries look the body up on every call instead.
  const screen = new Proxy(testing.screen, {
    get: (_target, key) => Reflect.get(testing.within(document.body), key),
  });
  return { ...testing, screen, renderAt };
}
