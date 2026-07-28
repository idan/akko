import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

const gatewayPort = process.env.AKKO_PORT ?? "8787";

export default defineConfig({
  plugins: [tailwindcss(), svelte()],
  // Load .env from the repo root so a single root-level .env serves both the backend
  // (Bun auto-loads it) and the frontend's VITE_* vars. See .env.example.
  envDir: "../..",
  server: {
    port: 5173,
    proxy: {
      "/api": { target: `http://localhost:${gatewayPort}`, changeOrigin: true },
      "/ws": { target: `ws://localhost:${gatewayPort}`, ws: true },
    },
  },
});