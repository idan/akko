import type { StorybookConfig } from "@storybook/svelte-vite";
import { fileURLToPath } from "node:url";

/**
 * Storybook 10 for the Svelte 5 + bits-ui components (design in isolation).
 *
 * Shares the app's Vite/Svelte pipeline via @storybook/svelte-vite, so runes, bits-ui,
 * and vitePreprocess all work exactly as they do in the real app. Stories live next to
 * the components as `*.stories.svelte` (native Svelte CSF via @storybook/addon-svelte-csf).
 *
 * Jazz is mocked (jazz-tools/svelte + @akko/schema) so JazzMessageList/ChatView render
 * without a live Jazz runtime; the same aliases apply to the addon-vitest browser tests.
 */
const config: StorybookConfig = {
  stories: ["../src/**/*.mdx", "../src/**/*.stories.@(js|ts|svelte)"],
  addons: ["@storybook/addon-svelte-csf", "@storybook/addon-docs", "@storybook/addon-a11y", "@storybook/addon-vitest"],
  framework: {
    name: "@storybook/svelte-vite",
    options: {},
  },
  async viteFinal(cfg) {
    const { mergeConfig } = await import("vite");
    return mergeConfig(cfg, {
      resolve: {
        alias: {
          "jazz-tools/svelte": fileURLToPath(new URL("./mocks/jazz-svelte.ts", import.meta.url)),
          "@akko/schema": fileURLToPath(new URL("./mocks/schema.ts", import.meta.url)),
        },
      },
    });
  },
};

export default config;
