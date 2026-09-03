import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60000,
  use: {
    baseURL: process.env.WEB_BASE ?? "http://127.0.0.1:3100",
  },
  reporter: "line",
});
