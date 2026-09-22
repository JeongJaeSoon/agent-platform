import { afterAll, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import type { UserEvent } from "@testing-library/user-event";

/*
 * Two constraints shape this helper.
 *
 * 1. `bun test` runs the whole repo in one process, and happy-dom's registrator
 *    replaces fetch/Request/Response/setTimeout as well as the DOM. Leaving it
 *    installed would hand the API and worker suites a fake network, so each
 *    file registers on the way in and gives the globals back on the way out.
 *    The module is cached across files, hence the explicit `registered` latch.
 *
 * 2. Libraries decide at *import* time whether a DOM exists — Radix's
 *    `useLayoutEffect` degrades to a no-op (its portals then never mount) and
 *    Testing Library captures `document` into its defaults. So anything that
 *    reaches for the DOM while loading must be imported *after* `setupDom()`,
 *    which is why it hands back Testing Library itself. Plain components have
 *    no such rule and are imported normally.
 */
let registered = false;

export interface DomOptions {
  /** Viewport width; the responsive snapshots use 360 / 768 / 1440. */
  readonly width?: number;
  readonly height?: number;
}

export type TestingLibrary = typeof import("@testing-library/react");

export async function setupDom({
  width = 1440,
  height = 900,
}: DomOptions = {}): Promise<TestingLibrary> {
  if (!registered) {
    GlobalRegistrator.register({ url: "https://ui.test/", width, height });
    registered = true;
  }
  setViewport({ width, height });

  const testingLibrary = await import("@testing-library/react");

  afterEach(() => {
    testingLibrary.cleanup();
  });

  afterAll(async () => {
    if (!registered) return;
    registered = false;
    await GlobalRegistrator.unregister();
  });

  return testingLibrary;
}

interface HappyDomWindow {
  readonly happyDOM: {
    setViewport(viewport: { width: number; height: number }): void;
  };
}

export function setViewport({ width, height }: Required<DomOptions>): void {
  (window as unknown as HappyDomWindow).happyDOM.setViewport({ width, height });
}

/**
 * user-event resolves its default document when the module first loads, which
 * may be a window this file has since torn down. Naming the live one keeps the
 * session pointed at the DOM the test is actually looking at.
 */
export async function setupUser(): Promise<UserEvent> {
  const { default: userEvent } = await import("@testing-library/user-event");
  return userEvent.setup({ document });
}

/**
 * happy-dom answers `matchMedia` from its own viewport, which has no opinion on
 * `prefers-reduced-motion`. Tests state the preference outright.
 */
export function stubPrefersReducedMotion(reduce: boolean): () => void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query.includes("prefers-reduced-motion: reduce") ? reduce : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}
