import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  forbidOnly: false,
  retries: 0,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 10000 },
  use: {
    // Dev server is used (not preview) because the __pcTest seam is guarded
    // by import.meta.env.DEV and is tree-shaken from production builds.
    baseURL: 'http://localhost:1420',
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: 'npm run dev -- --port 1420 --strictPort',
    url: 'http://localhost:1420',
    reuseExistingServer: true,
    timeout: 30000,
  },
})
