import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: "/tmp/qq-codex-bridge-vite",
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      reporter: ["text", "html"]
    }
  }
});
