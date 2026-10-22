import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const list = window.matchMedia(QUERY);
  // Safari < 14 only has the deprecated listener pair.
  if (list.addEventListener) {
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }
  list.addListener(onChange);
  return () => list.removeListener(onChange);
}

function getSnapshot(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(QUERY).matches;
}

// Server render assumes motion is allowed; the first client commit corrects it.
function getServerSnapshot(): boolean {
  return false;
}

/**
 * CSS already stops every animation under `prefers-reduced-motion` (tokens.css).
 * This hook is for the cases CSS cannot reach: dropping an animated element
 * entirely rather than freezing it mid-spin.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
