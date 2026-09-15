import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Tauri drives this dev server (see src-tauri/tauri.conf.json: devUrl).
export default defineConfig({
  plugins: [solid(), tailwindcss()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "safari15", outDir: "dist", emptyOutDir: true },
});
