import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/svelte";

// Unmount any components rendered in the previous test.
afterEach(() => cleanup());
