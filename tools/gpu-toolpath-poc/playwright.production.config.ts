/**
 * Copyright 2026 Franja (Frank) Povazanj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import base from '../../playwright.config'

const root = fileURLToPath(new URL('../..', import.meta.url))
const port = Number(process.env.PURECUT_E2E_PORT ?? 16844)
export default defineConfig({
  ...base,
  testDir: fileURLToPath(new URL('../../e2e', import.meta.url)),
  testMatch: 'toolpathVisibility.smoke.spec.ts',
  grep: /production renderer/,
  workers: 1,
  projects: [{ name: 'production' }],
  use: { ...base.use, baseURL: 'http://127.0.0.1:' + port },
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port ' + port + ' --strictPort',
    cwd: root,
    url: 'http://127.0.0.1:' + port,
    reuseExistingServer: false,
    timeout: 30000,
  },
})
