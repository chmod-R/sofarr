import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Small home servers can be busy (e.g. importing media) while tests run;
    // the first test in each file also pays for module loading.
    testTimeout: 20_000,
  },
});
