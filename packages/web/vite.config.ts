import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const gatewayPort = process.env.AKKO_PORT ?? "8787";

export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: `http://localhost:${gatewayPort}`, changeOrigin: true },
      "/ws": { target: `ws://localhost:${gatewayPort}`, ws: true },
    },
  },
});