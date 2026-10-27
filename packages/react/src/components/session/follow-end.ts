import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

// Closer than this to the end still counts as reading the latest line.
const SLACK_PX = 32;
// A touch flick keeps scrolling this long after the finger lifts.
const INPUT_MS = 1000;
const INPUTS = ["wheel", "touchmove", "keydown", "pointerdown"] as const;

/**
 * Keeps a scrolling list at its end while the reader is there, the way a
 * chat does. `latest` names the newest item: when it changes with the
 * reader scrolled back, the view stays put and `behind` turns true instead.
 * Any other change of height (a fold opened, the window resized) keeps the
 * end in view only if it was in view. A new `scope` (another session in
 * the same list) starts over at the end.
 */
export function useFollowEnd(scope: string, latest: string) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [behind, setBehind] = useState(false);
  const [scrollable, setScrollable] = useState(false);
  const atEnd = useRef(true);
  const seen = useRef({ scope, latest });
  // Where the list last stood, so a scroll can tell up from down.
  const lastTop = useRef(0);

  const pin = useCallback((list: HTMLElement) => {
    list.scrollTop = list.scrollHeight;
    lastTop.current = list.scrollTop;
  }, []);

  const toEnd = useCallback(() => {
    if (!element) return;
    pin(element);
    atEnd.current = true;
    setBehind(false);
  }, [element, pin]);

  useEffect(() => {
    if (!element) return;
    lastTop.current = element.scrollTop;
    let resized = false;
    let inputAt = Number.NEGATIVE_INFINITY;
    let held = false;
    const onInput = (event: Event) => {
      inputAt = event.timeStamp;
      if (event.type === "pointerdown") held = true;
    };
    const onRelease = () => {
      held = false;
    };
    const onScroll = (event: Event) => {
      const gap =
        element.scrollHeight - element.scrollTop - element.clientHeight;
      const moved = held || event.timeStamp - inputAt < INPUT_MS;
      if (gap <= SLACK_PX) {
        atEnd.current = true;
        setBehind(false);
      } else if (resized && !moved) {
        // A resize clamps the scroll, and its event lands a frame late,
        // after the next resize may have opened a gap the reader never made.
        if (atEnd.current) pin(element);
      } else if (element.scrollTop < lastTop.current) {
        atEnd.current = false;
      }
      resized = false;
      lastTop.current = element.scrollTop;
    };
    // A drag of the scrollbar may end outside the list.
    const page = element.ownerDocument;
    for (const type of INPUTS)
      element.addEventListener(type, onInput, { passive: true });
    page.addEventListener("pointerup", onRelease);
    page.addEventListener("pointercancel", onRelease);
    element.addEventListener("scroll", onScroll, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => {
            resized = true;
            // The next frame dispatches scroll events before its animation
            // frames, so the flag covers exactly the clamp's own event.
            requestAnimationFrame(() => {
              resized = false;
            });
            setScrollable(element.scrollHeight > element.clientHeight);
            if (atEnd.current) pin(element);
          });
    observer?.observe(element);
    for (const child of element.children) observer?.observe(child);
    return () => {
      for (const type of INPUTS) element.removeEventListener(type, onInput);
      page.removeEventListener("pointerup", onRelease);
      page.removeEventListener("pointercancel", onRelease);
      element.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [element, pin]);

  // Before paint, so a line that arrives at the end never shows the jump.
  useLayoutEffect(() => {
    const before = seen.current;
    seen.current = { scope, latest };
    if (scope !== before.scope) {
      atEnd.current = true;
      setBehind(false);
    }
    if (!element) return;
    if (atEnd.current) pin(element);
    else if (latest !== before.latest) setBehind(true);
  }, [scope, latest, element, pin]);

  return { ref: setElement, element, behind, scrollable, toEnd };
}
