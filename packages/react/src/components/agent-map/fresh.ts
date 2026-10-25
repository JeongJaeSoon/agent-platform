import { useReducedMotion } from "@werft-ai/ui";
import { type RefObject, useLayoutEffect } from "react";

// The production CSP (style-src 'self') refuses an injected <style>, so the
// arrival motion runs through Web Animations instead of a keyframes rule.
const ARRIVAL: Keyframe[] = [
  { opacity: 0, transform: "translateY(-6px)" },
  { opacity: 1, transform: "none" },
];

/** A new card or row slides in once; nothing else on the board moves. */
export function useArrival(
  ref: RefObject<HTMLElement | null>,
  fresh: boolean | undefined,
): void {
  const reduced = useReducedMotion();
  useLayoutEffect(() => {
    if (!fresh || reduced) return;
    ref.current?.animate?.(ARRIVAL, {
      duration: 400,
      easing: "cubic-bezier(.22,.61,.36,1)",
      fill: "both",
    });
  }, [fresh, reduced, ref]);
}

/** The dashed mark a just-changed card or row keeps until the next update. */
export const FRESH_CLASS =
  "data-[fresh]:outline-2 data-[fresh]:outline-offset-2 data-[fresh]:outline-dashed data-[fresh]:outline-(--ap-tone-progress-fg)";
