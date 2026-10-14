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

import assert from 'node:assert/strict'
import { BUILD_PHASES, SKIP_TESTS_FLAG, selectBuildPhases } from './build-phases'

function testFullBuildIsUnchanged(): void {
  assert.deepEqual(selectBuildPhases([]).map((phase) => phase.name), [
    'docs:check',
    'lint',
    'check:e2e-lanes',
    'check:colors',
    'check:portable-paths',
    'check:i18n',
    'sync-icons',
    'typecheck',
    'test',
    'vite build',
  ])
  assert.deepEqual(selectBuildPhases([]), BUILD_PHASES)
}

function testGatesOnlyIsFullListMinusTest(): void {
  assert.deepEqual(
    selectBuildPhases([SKIP_TESTS_FLAG]),
    BUILD_PHASES.filter((phase) => phase.name !== 'test'),
  )
  assert.equal(selectBuildPhases([SKIP_TESTS_FLAG]).length, BUILD_PHASES.length - 1)
}

testFullBuildIsUnchanged()
testGatesOnlyIsFullListMinusTest()

console.log('build-phases tests: OK')
