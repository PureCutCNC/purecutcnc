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

/**
 * Unit tests for the React-free snap settings reducers.
 * Run with: npx tsx src/app/useSnapSettings.test.ts
 */

import type { SnapSettings } from '../sketch/snapping'
import { toggleSnapEnabled, toggleSnapMode } from './useSnapSettings'

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function makeSettings(overrides: Partial<SnapSettings> = {}): SnapSettings {
  return {
    enabled: true,
    modes: ['grid', 'point'],
    pixelRadius: 14,
    ...overrides,
  }
}

function testToggleSnapEnabled() {
  console.log('Testing snap enabled toggle...')

  assert(toggleSnapEnabled(makeSettings({ enabled: true })).enabled === false, 'enabled true flips false')
  assert(toggleSnapEnabled(makeSettings({ enabled: false })).enabled === true, 'enabled false flips true')

  console.log('snap enabled toggle: PASSED')
}

function testToggleSnapMode() {
  console.log('Testing snap mode toggle...')

  const added = toggleSnapMode(makeSettings({ modes: ['grid'] }), 'center')
  assert(added.modes.join(',') === 'grid,center', 'missing mode is appended')

  const removed = toggleSnapMode(makeSettings({ modes: ['grid', 'center', 'point'] }), 'center')
  assert(removed.modes.join(',') === 'grid,point', 'existing mode is removed')

  console.log('snap mode toggle: PASSED')
}

try {
  testToggleSnapEnabled()
  testToggleSnapMode()
  console.log('\nAll useSnapSettings tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
