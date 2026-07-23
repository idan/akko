import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";

const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Two vitest projects (doc 15):
 *
 * - **unit** — fast jsdom tests for components + the runes store. Files use the
 *   `.vitest.ts` suffix so the root `bun test` (which matches `*.test.ts`) ignores them.
 *   Run with `bun --filter '@akko/web' test`.
 *
 * - **storybook** — runs every story's `play` function as a real browser test via
 *   `@storybook/addon-vitest` (Playwright/chromium). Shares the Storybook Vite config
 *   (incl. the Jazz mocks in .storybook/main.ts). Run with `... test:storybook`.
 *
 * The projects are self-contained (no `extends`); each declares the svelte plugin so
 * `.svelte`/`.stories.svelte` files compile in both. addon-vitest (10.3+) auto-applies
 * the Storybook preview annotations (.storybook/preview.ts), so no extra setup file.
 */
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [svelte()],
        resolve: { conditions: ["browser"] },
        test: {
          name: "unit",
          globals: true,
          environment: "jsdom",
          include: ["src/**/*.vitest.ts"],
          setupFiles: ["./vitest.setup.ts"],
          css: true,
        },
      },
      {
        plugins: [svelte(), storybookTest({ configDir: path.join(dirname, ".storybook") })],
        test: {
          name: "storybook",
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({}),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
