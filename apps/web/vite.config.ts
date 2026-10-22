import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const apiTarget = process.env.VITE_API_TARGET ?? "http://127.0.0.1:3000";

/**
 * build.license lists only the JS packages in the bundle; the self-hosted
 * fonts are CSS assets, so their OFL texts ship beside it under licenses/.
 */
function fontLicenses(): Plugin {
  const fonts = new URL("../../packages/ui/src/fonts/", import.meta.url);
  return {
    name: "font-licenses",
    apply: "build",
    generateBundle() {
      for (const font of ["geist", "pretendard"]) {
        this.emitFile({
          type: "asset",
          fileName: `licenses/${font}-LICENSE.txt`,
          source: readFileSync(new URL(`${font}/LICENSE.txt`, fonts)),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), fontLicenses()],
  // packages/ui resolves through a workspace symlink; without this a second
  // React or query-core copy breaks hooks and the query cache at runtime.
  // apps/storybook/.storybook/main.ts keeps the same list.
  resolve: {
    dedupe: [
      "react",
      "react-dom",
      "@tanstack/react-query",
      "@tanstack/query-core",
    ],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    license: { fileName: "THIRD_PARTY_NOTICES.md" },
  },
  server: {
    proxy: { "/v1": { target: apiTarget, changeOrigin: false } },
  },
});
