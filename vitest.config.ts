import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./tests/setup.ts'],
    // Integration tests share one real Postgres/Redis and truncate tables
    // between tests — running files in parallel would race on that shared
    // state, so files run sequentially. Tests within a file still run in
    // the order they're declared, same as Jest's default.
    fileParallelism: false,
    testTimeout: 15000,
    // Generous — this dev machine has seen slow first-connection cold
    // starts under load. CI runners should be much faster.
    hookTimeout: 60000,
  },
})
