import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiTarget = process.env.VITE_API_TARGET ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: { "/v1": { target: apiTarget, changeOrigin: false } },
  },
});
