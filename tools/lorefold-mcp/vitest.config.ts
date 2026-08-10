import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The suite must stay runnable with no Lorefold server anywhere in sight.
    // Anything that would need one belongs in LF-15, not here.
    environment: 'node',
  },
});
