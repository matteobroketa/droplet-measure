const {defineConfig} = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  testMatch: '**/*.e2e.spec.cjs',
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium'
  },
  webServer: {
    command: 'node tests/static-server.cjs',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI
  }
});