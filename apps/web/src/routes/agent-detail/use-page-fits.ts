import { useLayoutEffect, useState } from "react";

/**
 * Whether the whole page fits the window without scrolling. Hiding a section
 * list once it fits only widens the page and shortens it, so the answer does
 * not flip back and forth.
 */
export function usePageFits(): boolean {
  const [fits, setFits] = useState(false);
  useLayoutEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
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
  }, []);
  return fits;
}
