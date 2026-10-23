import type { StorybookConfig } from "@storybook/react-vite";
import tailwindcss from "@tailwindcss/vite";
import { mergeConfig } from "vite";

// The same list as apps/web/vite.config.ts: a second React copy breaks hooks
// at runtime with nothing in the build to say so.
const DEDUPE = [
  "react",
  "react-dom",
  "@tanstack/react-query",
  "@tanstack/query-core",
];

// Storybook answers 403 "Invalid host" to a Host header it does not know, so a
// tailnet preview names its hostnames here, comma-separated. Unset keeps the
// default.
const ALLOWED_HOSTS =
  process.env.STORYBOOK_ALLOWED_HOSTS?.split(",").filter(Boolean);

const config: StorybookConfig = {
  framework: "@storybook/react-vite",
  stories: ["../src/**/*.mdx", "../src/**/*.stories.tsx"],
  addons: [
    "@storybook/addon-a11y",
    "@storybook/addon-docs",
    "@storybook/addon-vitest",
  ],
  core: {
    disableTelemetry: true,
    ...(ALLOWED_HOSTS ? { allowedHosts: ALLOWED_HOSTS } : {}),
  },
  viteFinal: (vite) =>
    mergeConfig(vite, {
      plugins: [tailwindcss()],
      resolve: { dedupe: DEDUPE },
    }),
};

export default config;
