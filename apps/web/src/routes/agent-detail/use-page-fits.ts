import { useCallback, useState } from "react";

/**
 * Whether the whole page fits the window without scrolling, measured when
 * the watched element mounts, changes size or the window resizes. While the
 * element is hidden (another tab is open) the answer is kept, so coming back
 * draws the same layout as before. Hiding a section list once it fits only
 * widens the page and shortens it, so the answer does not flip back and forth.
 */
export function usePageFits(): readonly [
  boolean,
  (element: HTMLElement | null) => (() => void) | undefined,
] {
  const [fits, setFits] = useState(false);
  const watch = useCallback((element: HTMLElement | null) => {
    if (!element) return undefined;
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (element.getClientRects().length === 0) return;
      const root = document.documentElement;
      setFits(root.scrollHeight <= root.clientHeight);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const resized = new ResizeObserver(schedule);
    resized.observe(element);
    window.addEventListener("resize", schedule);
    // Before the first paint, so a page that fits never shows the list.
    measure();
    return () => {
      resized.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return [fits, watch] as const;
}
