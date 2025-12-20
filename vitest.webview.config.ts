import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Avoid loading root .env during webview tests (permission-restricted)
  envDir: './resources',
  test: {
    include: ['resources/webview/**/*.test.js'],
    environment: 'jsdom',
  },
});
