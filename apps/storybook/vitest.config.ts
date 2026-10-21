import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// Every story renders once in a real Chrome and fails on an axe violation
// (preview.tsx `a11y.test`). `channel: "chrome"` uses the installed Chrome —
// ubuntu runners ship one — instead of downloading Playwright's build.
export default defineConfig({
  plugins: [storybookTest({ configDir: `${import.meta.dirname}/.storybook` })],
  test: {
    name: "storybook",
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ launchOptions: { channel: "chrome" } }),
      instances: [{ browser: "chromium" }],
    },
  },
});
