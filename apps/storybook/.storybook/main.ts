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

const config: StorybookConfig = {
  framework: "@storybook/react-vite",
  stories: ["../src/**/*.stories.tsx"],
  addons: ["@storybook/addon-a11y", "@storybook/addon-vitest"],
  core: { disableTelemetry: true },
  viteFinal: (vite) =>
    mergeConfig(vite, {
      plugins: [tailwindcss()],
      resolve: { dedupe: DEDUPE },
    }),
};

export default config;
