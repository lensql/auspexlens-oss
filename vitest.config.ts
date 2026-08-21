import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Live suites talk to the Oracle compatibility container and are skipped
    // when it is not reachable. Two test counts are therefore both true; the
    // one that counts as the gate is the Mac Lab run with the container up.
    // See docs/STATUS.md.
    environment: 'node',
    testTimeout: 30_000,
  },
});
