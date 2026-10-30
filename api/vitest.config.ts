import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    // Database tests share one PostgreSQL and some rows are global (the Setting row), so test
    // files must not run at the same time.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary", "json-summary", "html"],
    },
  },
});
