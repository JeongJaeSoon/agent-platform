import { useCallback, useEffect, useRef, useState } from "react";

const RELEASE = ["wheel", "touchmove", "keydown", "pointerdown"] as const;

/**
 * The last of `ids` whose top has scrolled past the top of the viewport, or
 * the last one once the page bottom is reached, since a short final section
 * may never get that high. While the sections are hidden (another tab is
 * open) the answer is kept, not measured. A section picked from the list
 * stays current until the reader scrolls on their own: the jump may stop at
 * the page bottom, short of the section's top.
 */
export function useCurrentSection(
  ids: readonly string[],
): readonly [string | undefined, (id: string) => void] {
  const [current, setCurrent] = useState(ids[0]);
  const picked = useRef(false);
  const pick = useCallback((id: string) => {
    picked.current = true;
    setCurrent(id);
  }, []);
  const key = ids.join(" ");
  useEffect(() => {
    const names = key.split(" ");
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (picked.current) return;
      const shown = names.flatMap((id) => {
        const element = document.getElementById(id);
        return element && element.getClientRects().length > 0
          ? [{ id, top: element.getBoundingClientRect().top }]
          : [];
      });
      if (shown.length === 0) return;
      const root = document.documentElement;
      if (
        window.scrollY > 0 &&
        window.scrollY + root.clientHeight >= root.scrollHeight - 2
      )
        return setCurrent(shown.at(-1)?.id);
      const line = Math.min(96, root.clientHeight / 3);
      const passed = shown.filter((section) => section.top <= line);
      setCurrent((passed.at(-1) ?? shown[0])?.id);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const release = () => {
      picked.current = false;
    };
    // Showing the tab again resizes the page without scrolling it.
    const resized = new ResizeObserver(schedule);
    resized.observe(document.body);
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    for (const type of RELEASE)
      window.addEventListener(type, release, { passive: true });
    measure();
    return () => {
      resized.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      for (const type of RELEASE) window.removeEventListener(type, release);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [key]);
  return [current, pick] as const;
}
