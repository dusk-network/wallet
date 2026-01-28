import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run tests in node environment (no browser DOM needed for these utils)
    environment: "node",
    // Include test files
    include: ["src/**/*.test.js"],
    // Enable globals like describe, it, expect without imports (optional)
    globals: false,
    // Coverage configuration
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.js"],
      exclude: [
        "src/**/*.test.js",
        "src/background.js",
        "src/contentScript.js",
        "src/inpage.js",
        "src/notification.js",
        "src/offscreen.js",
        "src/popup.js",
      ],
    },
  },
});
