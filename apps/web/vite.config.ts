import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the API runs on its own port; the built app is served by the
// control host itself, so production needs no proxy and no CORS.
const apiTarget = process.env.VITE_API_TARGET ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: { "/v1": { target: apiTarget, changeOrigin: false } },
  },
});
