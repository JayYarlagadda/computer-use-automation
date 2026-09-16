import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Browser launch and frameset loads are slow relative to unit tests; the
    // alternative to generous timeouts here is flaky failures that teach
    // everyone to re-run the suite instead of reading it.
    testTimeout: 60_000,
    // Live Groq discovery (tests/live-discovery.test.ts) can take ~90s.
    hookTimeout: 180_000,
    // Each browser-backed file owns a browser and a target app, so running
    // files in parallel multiplies both. Sequential is fast enough.
    fileParallelism: false,
  },
});
