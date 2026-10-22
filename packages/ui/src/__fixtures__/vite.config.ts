import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The gallery needs Tailwind for the shadcn primitives, which bun's own HTML
// bundler does not run; apps/web builds the same way.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
});
