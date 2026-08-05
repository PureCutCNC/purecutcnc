import { defineConfig } from '@playwright/test'

const isCI = Boolean(process.env.CI)
const requestedPort = Number(process.env.PURECUT_E2E_PORT)
const e2ePort = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 1420
const useIsolatedServer = process.env.PURECUT_E2E_ISOLATED === '1'

export default defineConfig({
  testDir: './e2e',
  forbidOnly: isCI,
  retries: 0,
  workers: isCI ? 2 : undefined,
  // fullyParallel runs tests within each file concurrently — great locally
  // but on CI's 2-vCPU runners the Vite dev server gets overwhelmed when
  // multiple pages load/reload simultaneously. Tests across files still
  // run in parallel via workers.
  fullyParallel: !isCI,
  timeout: 60000,
  reporter: isCI
    ? [['github'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : 'list',
  expect: { timeout: 10000 },
  use: {
    // Dev server is used (not preview) because the __pcTest seam is guarded
    // by import.meta.env.DEV and is tree-shaken from production builds.
    baseURL: `http://localhost:${e2ePort}`,
    headless: true,
    trace: isCI ? 'retain-on-failure' : 'off',
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: `npm run dev -- --port ${e2ePort} --strictPort`,
    url: `http://localhost:${e2ePort}`,
    reuseExistingServer: useIsolatedServer ? false : !isCI,
    timeout: 30000,
  },
})
