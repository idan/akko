import type { Preview } from "@storybook/svelte-vite";
// Load the app's global styles so components render with real theming (dark panel, etc).
import "../src/app.css";

const preview: Preview = {
  parameters: {
    layout: "centered",
    backgrounds: {
      // The app is dark-only; default stories to the app background.
      options: {
        app: { name: "app", value: "#0f1115" },
        panel: { name: "panel", value: "#151922" },
      },
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    a11y: {
      // 'todo' shows a11y violations without failing the build; flip to 'error' to gate.
      test: "todo",
    },
  },
  initialGlobals: {
    backgrounds: { value: "app" },
  },
};

export default preview;
