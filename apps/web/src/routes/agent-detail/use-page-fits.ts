import { useLayoutEffect, useState } from "react";

/**
 * Whether the whole page fits the window without scrolling, measured while
 * the element `id` is shown. While it is hidden (another tab is open) the
 * answer is kept, so coming back draws the same layout as before. Hiding a
 * section list once it fits only widens the page and shortens it, so the
 * answer does not flip back and forth.
 */
export function usePageFits(id: string): boolean {
  const [fits, setFits] = useState(false);
  useLayoutEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const element = document.getElementById(id);
      if (!element || element.getClientRects().length === 0) return;
      const root = document.documentElement;
      setFits(root.scrollHeight <= root.clientHeight);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const resized = new ResizeObserver(schedule);
    resized.observe(document.body);
    window.addEventListener("resize", schedule);
    measure();
    return () => {
      resized.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [id]);
  return fits;
}
