import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  // On CI, a test that hangs fails by name at its timeout, and a run that
  // hangs stops by itself after 3 minutes, inside the job's 10 (the whole run
  // takes under one), saying so.
  globalTimeout: process.env.CI ? 3 * 60_000 : 0,
  use: {
    baseURL: "http://127.0.0.1:5173",
    headless: true,
  },
  webServer: {
    command: "npm run dev:tauri",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVER === "1",
    timeout: 120_000,
  },
});
