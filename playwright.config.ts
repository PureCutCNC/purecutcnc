import { defineConfig } from '@playwright/test'

const isCI = Boolean(process.env.CI)

export default defineConfig({
  testDir: './e2e',
  forbidOnly: isCI,
  retries: 0,
  workers: 1,
  timeout: 60000,
  reporter: isCI
    ? [['github'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : 'list',
  expect: { timeout: 10000 },
  use: {
    // Dev server is used (not preview) because the __pcTest seam is guarded
    // by import.meta.env.DEV and is tree-shaken from production builds.
    baseURL: 'http://localhost:1420',
    headless: true,
    trace: isCI ? 'retain-on-failure' : 'off',
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: 'npm run dev -- --port 1420 --strictPort',
    url: 'http://localhost:1420',
    reuseExistingServer: !isCI,
    timeout: 30000,
  },
})
