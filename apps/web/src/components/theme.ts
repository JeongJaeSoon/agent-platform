import { useSyncExternalStore } from "react";

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_STORAGE_KEY = "ap.theme";

function isTheme(value: unknown): value is Theme {
  return THEMES.includes(value as Theme);
}

export function storedTheme(): Theme {
  try {
    const stored = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
    if (isTheme(stored)) return stored;
  } catch {
    // Storage can be blocked; the system preference still applies.
  }
  return "system";
}

const listeners = new Set<() => void>();

export function applyTheme(theme: Theme) {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  for (const listener of listeners) listener();
}

// The page itself holds the theme, so blocked storage cannot make two
// controls disagree about what is showing.
function shownTheme(): Theme {
  const shown = globalThis.document?.documentElement.dataset.theme;
  return isTheme(shown) ? shown : "system";
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The theme on screen now; every control showing it follows a change. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, shownTheme, () => "system");
}

export function chooseTheme(theme: Theme) {
  applyTheme(theme);
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage can be blocked; the choice then lasts for this page only.
  }
}
