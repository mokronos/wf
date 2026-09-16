import { resolve } from "node:path"
import { defineConfig } from "vitest/config"

const source = (...segments: ReadonlyArray<string>) => resolve(import.meta.dirname, ...segments)

export default defineConfig({
  resolve: {
    alias: {
      "@mokronos/observability": source("packages/observability/src/index.ts"),
      "@mokronos/wfkit/optional": source("packages/wf/src/optional.ts"),
      "@mokronos/wfkit/authoring": source("packages/wf/src/authoring.ts"),
      "@mokronos/wfkit/schemas": source("packages/wf/src/schemas.ts"),
      "@mokronos/wfkit/testing": source("packages/wf/src/testing/index.ts"),
      "@mokronos/wfkit": source("packages/wf/src/index.ts")
    }
  },
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "apps/cli/test/**/*.test.ts",
      "examples/*/**/*.test.ts"
    ],
    // The engine binds bun:sqlite and several suites drive the compiled CLI, so
    // the suite runs under Bun rather than Node.
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
