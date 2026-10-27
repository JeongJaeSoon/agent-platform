import { describe, expect, test } from "bun:test";

import { setupDom } from "@werft-ai/ui/test-support/dom";

const { render, act } = await setupDom();
const { useFollowEnd } = await import("./follow-end.ts");

function List({ count }: { readonly count: number }) {
  const follow = useFollowEnd(count);
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

// Happy DOM lays nothing out: the list's heights are set by hand, and the
// scroll position is a plain number the hook and the test both write.
function sized(list: HTMLElement, client: number) {
  let height = 0;
  let top = 0;
  Object.defineProperty(list, "clientHeight", { value: client });
  Object.defineProperty(list, "scrollHeight", { get: () => height });
  Object.defineProperty(list, "scrollTop", {
    get: () => top,
    set: (value: number) => {
      top = Math.max(0, Math.min(value, height - client));
    },
  });
  return {
    grow: (to: number) => {
      height = to;
    },
    get top() {
      return top;
    },
    scrollTo(value: number) {
      list.scrollTop = value;
      list.dispatchEvent(new Event("scroll"));
    },
  };
}

describe("useFollowEnd", () => {
  test("a list read at its end follows what arrives", () => {
    const { getByTestId, rerender, queryByRole } = render(<List count={0} />);
    const list = sized(getByTestId("list"), 400);
    list.grow(1000);
    rerender(<List count={5} />);
    expect(list.top).toBe(600);
    list.grow(1300);
    rerender(<List count={6} />);
    expect(list.top).toBe(900);
    expect(queryByRole("button")).toBe(null);
  });

  test("a reader scrolled back stays put and is offered the way down", () => {
    const { getByTestId, rerender, getByRole, queryByRole } = render(
      <List count={0} />,
    );
    const list = sized(getByTestId("list"), 400);
    list.grow(1000);
    rerender(<List count={5} />);
    act(() => list.scrollTo(200));
    list.grow(1300);
    rerender(<List count={6} />);
    expect(list.top).toBe(200);

    act(() => getByRole("button", { name: "new" }).click());
    expect(list.top).toBe(900);
    expect(queryByRole("button")).toBe(null);
  });

  test("scrolling back down to the end puts the offer away and follows again", () => {
    const { getByTestId, rerender, queryByRole } = render(<List count={0} />);
    const list = sized(getByTestId("list"), 400);
    list.grow(1000);
    rerender(<List count={5} />);
    act(() => list.scrollTo(100));
    list.grow(1300);
    rerender(<List count={6} />);
    expect(queryByRole("button")).not.toBe(null);

    act(() => list.scrollTo(890));
    expect(queryByRole("button")).toBe(null);
    list.grow(1600);
    rerender(<List count={7} />);
    expect(list.top).toBe(1200);
  });
});
