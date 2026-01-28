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
      reporter: ["text", "text-summary", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: [
        // Only measure coverage for pure utility modules (testable without mocks)
        "src/shared/amount.js",
        "src/shared/bytes.js",
        "src/shared/chain.js",
        "src/shared/constants.js",
        "src/shared/duskUri.js",
        "src/shared/explorer.js",
        "src/shared/network.js",
        "src/shared/networkPresets.js",
        "src/shared/txDefaults.js",
        "src/shared/addressBook.js",
        "src/ui/lib/strings.js",
      ],
      exclude: [
        "src/**/*.test.js",
      ],
      // Coverage thresholds for tested modules
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
});
