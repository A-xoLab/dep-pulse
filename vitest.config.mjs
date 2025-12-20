import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Point env loading away from root .env (permission-restricted in some envs)
  envDir: './src',
  test: {
    globals: true,
    environment: 'node',
    pool: 'threads',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'resources/webview/**/*.test.js'],
    setupFiles: ['./src/test-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      exclude: [
        'node_modules/',
        'out/',
        '**/*.test.ts',
        'src/performance/**',
        'src/**/index.ts',
        'src/ui/StatusBarManager.ts',
      ],
      thresholds: {
        lines: 50,
        functions: 55,
        branches: 40,
        statements: 50,
      },
    },
  },
});
