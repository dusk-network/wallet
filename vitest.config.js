import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run tests in node environment (no browser DOM needed for these utils)
    environment: "node",
    // In English unless a test says otherwise, whatever the machine's language.
    env: { LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8", LANGUAGE: "en" },
    setupFiles: ["./src/shared/fixtures/language.js"],
    // Include test files
    include: ["src/**/*.test.js", "scripts/**/*.test.js"],
    // Enable globals like describe, it, expect without imports (optional)
    globals: false,
  },
});
