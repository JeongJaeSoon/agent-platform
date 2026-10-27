import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { setupDom } from "@werft-ai/ui/test-support/dom";

const { render, act } = await setupDom();
const { useFollowEnd } = await import("./follow-end.ts");

function List({
  scope = "a",
  latest,
}: {
  readonly scope?: string;
  readonly latest: string;
}) {
  const follow = useFollowEnd(scope, latest);
  return (
    <>
      <div ref={follow.ref} data-testid="list">
        <div />
      </div>
      {follow.behind ? (
        <button type="button" onClick={follow.toEnd}>
          new
        </button>
      ) : null}
    </>
  );
}

// Happy DOM lays nothing out and never fires a ResizeObserver: the list's
// heights are set by hand, the scroll position is a plain number, and the
// test calls the observer the way a browser would after a layout.
let resize = () => {};
let frames: (() => void)[] = [];
const real = {
  ResizeObserver: globalThis.ResizeObserver,
  requestAnimationFrame: globalThis.requestAnimationFrame,
};
beforeEach(() => {
  frames = [];
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) {
      resize = callback;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  globalThis.requestAnimationFrame = (callback) => {
    frames.push(() => callback(0));
    return frames.length;
  };
});
afterEach(() => {
  globalThis.ResizeObserver = real.ResizeObserver;
  globalThis.requestAnimationFrame = real.requestAnimationFrame;
});

function sized(element: HTMLElement, client: number) {
  let height = 0;
  let top = 0;
  let clientHeight = client;
  Object.defineProperty(element, "clientHeight", {
    get: () => clientHeight,
  });
  Object.defineProperty(element, "scrollHeight", { get: () => height });
  Object.defineProperty(element, "scrollTop", {
    get: () => top,
    set: (value: number) => {
      top = Math.max(0, Math.min(value, height - clientHeight));
    },
  });
  return {
    grow: (to: number) => {
      height = to;
    },
    get top() {
      return top;
    },
    // A layout change the browser makes: the scroll clamps, the observer
    // runs, and the clamp's scroll event arrives before the next frame.
    reflow(to: { height?: number; client?: number }) {
      height = to.height ?? height;
      clientHeight = to.client ?? clientHeight;
      top = Math.min(top, height - clientHeight);
      act(() => resize());
    },
    scrollTo(value: number, input?: string) {
      this.move(value, input);
      this.land();
    },
    // The reader's scroll, its event not dispatched yet.
    move(value: number, input?: string) {
      if (input) element.dispatchEvent(new Event(input));
      element.scrollTop = value;
    },
    land() {
      element.dispatchEvent(new Event("scroll"));
    },
    frame() {
      for (const run of frames.splice(0)) run();
    },
  };
}

describe("useFollowEnd", () => {
  test("a list read at its end follows what arrives", () => {
    const { getByTestId, rerender, queryByRole } = render(<List latest="" />);
    const list = sized(getByTestId("list"), 400);
    list.grow(1000);
    rerender(<List latest="e5" />);
    expect(list.top).toBe(600);
    list.grow(1300);
    rerender(<List latest="e6" />);
    expect(list.top).toBe(900);
    expect(queryByRole("button")).toBe(null);
  });

  test("a reader scrolled back stays put and is offered the way down", () => {
    const { getByTestId, rerender, getByRole, queryByRole } = render(
      <List latest="" />,
    );
    const list = sized(getByTestId("list"), 400);
    list.grow(1000);
    rerender(<List latest="e5" />);
    act(() => list.scrollTo(200, "wheel"));
    list.grow(1300);
    rerender(<List latest="e6" />);
    expect(list.top).toBe(200);

    act(() => getByRole("button", { name: "new" }).click());
    expect(list.top).toBe(900);
    expect(queryByRole("button")).toBe(null);
  });

  test("an arrival is told by the newest item, not by how many there are", () => {
    const { getByTestId, rerender, queryByRole } = render(<List latest="" />);
    const list = sized(getByTestId("list"), 400);
    list.grow(1000);
    rerender(<List latest="e200" />);
    act(() => list.scrollTo(100, "wheel"));
    // The window is full: one in, one out, the same height and count.
    rerender(<List latest="e201" />);
    expect(list.top).toBe(100);
    expect(queryByRole("button")).not.toBe(null);
  });

  test("scrolling back down to the end puts the offer away and follows again", () => {
    const { getByTestId, rerender, queryByRole } = render(<List latest="" />);
    const list = sized(getByTestId("list"), 400);
    list.grow(1000);
    rerender(<List latest="e5" />);
    act(() => list.scrollTo(100, "wheel"));
    list.grow(1300);
    rerender(<List latest="e6" />);
    expect(queryByRole("button")).not.toBe(null);

    act(() => list.scrollTo(890, "wheel"));
    expect(queryByRole("button")).toBe(null);
    list.grow(1600);
    rerender(<List latest="e7" />);
    expect(list.top).toBe(1200);
  });

  test("a resize does not count as the reader leaving the end", () => {
    const { getByTestId, rerender } = render(<List latest="" />);
    const list = sized(getByTestId("list"), 400);
    list.grow(1000);
    rerender(<List latest="e5" />);
    expect(list.top).toBe(600);
    // Wider: the text takes fewer lines, the scroll clamps, and a taller
    // window opens a gap before the clamp's event lands.
    list.reflow({ height: 900 });
    list.reflow({ client: 300 });
    act(() => list.scrollTo(500));
    expect(list.top).toBe(600);
    list.grow(1100);
    rerender(<List latest="e6" />);
    expect(list.top).toBe(800);
  });

  test("the reader scrolling up while lines stream in is not pulled back", () => {
    const { getByTestId, rerender } = render(<List latest="" />);
    const list = sized(getByTestId("list"), 400);
    list.grow(1000);
    rerender(<List latest="e5" />);
    list.reflow({ height: 1050 });
    act(() => list.scrollTo(300, "wheel"));
    expect(list.top).toBe(300);
    list.reflow({ height: 1100 });
    rerender(<List latest="e6" />);
    expect(list.top).toBe(300);
  });

  test("a line arriving before the reader's scroll event lands does not undo it", () => {
    const { getByTestId, rerender, queryByRole } = render(<List latest="" />);
    const list = sized(getByTestId("list"), 400);
    list.grow(1000);
    rerender(<List latest="e5" />);
    list.move(300, "wheel");
    list.grow(1300);
    rerender(<List latest="e6" />);
    expect(list.top).toBe(300);
    act(() => list.land());
    expect(list.top).toBe(300);
    expect(queryByRole("button")).not.toBe(null);
  });

  test("a nudge within the slack still follows when a line lands first", () => {
    const { getByTestId, rerender, queryByRole } = render(<List latest="" />);
    const list = sized(getByTestId("list"), 400);
    list.grow(1000);
    rerender(<List latest="e5" />);
    list.move(590, "wheel");
    list.grow(1300);
    rerender(<List latest="e6" />);
    expect(list.top).toBe(900);
    expect(queryByRole("button")).toBe(null);
  });

  test("a scroll a frame after the resize is the reader's again", () => {
    const { getByTestId, rerender, queryByRole } = render(<List latest="" />);
    const list = sized(getByTestId("list"), 400);
    list.grow(1000);
    rerender(<List latest="e5" />);
    list.reflow({ height: 1100 });
    expect(list.top).toBe(700);
    list.frame();
    // Without input: a programmatic or assistive scroll moves it up too.
    act(() => list.scrollTo(200));
    rerender(<List latest="e6" />);
    expect(list.top).toBe(200);
    expect(queryByRole("button")).not.toBe(null);
  });

  test("another session starts at its end, whatever the last one was doing", () => {
    const { getByTestId, rerender, queryByRole } = render(
      <List scope="a" latest="" />,
    );
    const list = sized(getByTestId("list"), 400);
    list.grow(1000);
    rerender(<List scope="a" latest="e5" />);
    act(() => list.scrollTo(100, "wheel"));
    rerender(<List scope="a" latest="e6" />);
    expect(queryByRole("button")).not.toBe(null);

    list.grow(2000);
    rerender(<List scope="b" latest="f9" />);
    expect(list.top).toBe(1600);
    expect(queryByRole("button")).toBe(null);
  });

  test("a scroll still in flight from the last session does not hold the next one up", () => {
    const { getByTestId, rerender, queryByRole } = render(
      <List scope="a" latest="" />,
    );
    const list = sized(getByTestId("list"), 400);
    list.grow(1000);
    rerender(<List scope="a" latest="e5" />);
    list.move(300, "wheel");
    list.grow(1300);
    rerender(<List scope="b" latest="f1" />);
    expect(list.top).toBe(900);
    act(() => list.land());
    expect(queryByRole("button")).toBe(null);
  });
});
