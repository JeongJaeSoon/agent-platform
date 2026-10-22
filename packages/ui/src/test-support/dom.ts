import { afterAll, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import type { UserEvent } from "@testing-library/user-event";

/*
 * Three constraints shape this helper.
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

/*
 * 3. The registrator also swaps in the window's timers, and the window dies
 *    with `unregister`. React's scheduler and other libraries keep the timers
 *    they found when they first loaded, so a second DOM file in the same run
 *    rendered once and then never ran an effect or an update again. The
 *    runtime's own timers outlive every window, so they go back on the global,
 *    but tracked: whatever a file left pending (Radix schedules a focus event
 *    on unmount) is cancelled when its window closes instead of firing into
 *    the next file's DOM.
 */
const runtime = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  setImmediate: globalThis.setImmediate,
  clearImmediate: globalThis.clearImmediate,
  queueMicrotask: globalThis.queueMicrotask,
};
type Pending = ReturnType<typeof setTimeout> | ReturnType<typeof setImmediate>;
const pendingTimeouts = new Set<Pending>();
const pendingImmediates = new Set<Pending>();

const trackedTimers = {
  setTimeout: ((
    callback: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    const id = runtime.setTimeout(() => {
      pendingTimeouts.delete(id);
      callback(...args);
    }, ms);
    pendingTimeouts.add(id);
    return id;
  }) as typeof setTimeout,
  clearTimeout: ((id?: Parameters<typeof clearTimeout>[0]) => {
    pendingTimeouts.delete(id as Pending);
    runtime.clearTimeout(id);
  }) as typeof clearTimeout,
  setInterval: ((
    callback: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    const id = runtime.setInterval(callback, ms, ...args);
    pendingTimeouts.add(id);
    return id;
  }) as typeof setInterval,
  clearInterval: ((id?: Parameters<typeof clearInterval>[0]) => {
    pendingTimeouts.delete(id as Pending);
    runtime.clearInterval(id);
  }) as typeof clearInterval,
  setImmediate: ((
    callback: (...args: unknown[]) => void,
    ...args: unknown[]
  ) => {
    const id = runtime.setImmediate(() => {
      pendingImmediates.delete(id);
      callback(...args);
    });
    pendingImmediates.add(id);
    return id;
  }) as typeof setImmediate,
  clearImmediate: ((id?: Parameters<typeof clearImmediate>[0]) => {
    pendingImmediates.delete(id as Pending);
    runtime.clearImmediate(id);
  }) as typeof clearImmediate,
  queueMicrotask: runtime.queueMicrotask,
};

/*
 * React's scheduler posts its work loop as an immediate and counts the loop as
 * running until it fires. Cancelling it left that mark set, and the next file
 * never rendered an update made outside act() again; firing it after
 * unregister reaches for a window that is gone. So it runs out here, while the
 * window lives, and only a loop that will not settle is cancelled.
 */
async function drainImmediates() {
  for (let round = 0; round < 50 && pendingImmediates.size > 0; round++)
    await new Promise((resolve) => runtime.setImmediate(resolve));
}

function cancelPendingTimers() {
  for (const id of pendingTimeouts) runtime.clearTimeout(id as never);
  for (const id of pendingImmediates) runtime.clearImmediate(id as never);
  pendingTimeouts.clear();
  pendingImmediates.clear();
}

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
    Object.assign(globalThis, trackedTimers);
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
    await drainImmediates();
    cancelPendingTimers();
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
