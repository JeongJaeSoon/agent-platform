import { useEffect, useRef, useState } from "react";

/**
 * Whether the element has come within `margin` of the viewport, and stays
 * true once it has, so what it read is not dropped when it scrolls away.
 * Without IntersectionObserver every element counts as seen.
 */
export function useSeen<T extends Element>(margin = "200px") {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  useEffect(() => {
    const element = ref.current;
    if (seen || !element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
      },
      { rootMargin: margin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [seen, margin]);
  return [ref, seen] as const;
}
