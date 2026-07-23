// Pulls the @testing-library/jest-dom matcher augmentations into the TS program so
// `svelte-check` (which type-checks src/**) sees `.toBeInTheDocument()` etc. on vitest's
// `expect`. Runtime registration happens in ../vitest.setup.ts.
import "@testing-library/jest-dom/vitest";
