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

export function applyTheme(theme: Theme) {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
}

export function chooseTheme(theme: Theme) {
  applyTheme(theme);
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage can be blocked; the choice then lasts for this page only.
  }
}
