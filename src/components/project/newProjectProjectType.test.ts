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
 * The New project dialog's project type tiles (issue #1102, proposal 16).
 *
 * The three tiles are one radio group in `PROJECT_TYPES` order: each shows its
 * type's label over its own meta line, and the arrow keys move the choice with
 * a wrap at both ends. Pinned here so the dialog only has to wire the tiles.
 *
 * Run with: npx tsx src/components/project/newProjectProjectType.test.ts
 */

import assert from 'node:assert/strict'
import { PROJECT_TYPES } from '../feature-tree/projectTypeChoice'
import { dialogsEn } from '../../i18n/locales/en/dialogs'
import type { ProjectType } from '../../types/project'
import { projectTypeKeyNav, projectTypeMetaKey } from './newProjectProjectType'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   \u2713 ${name}`)
  } catch (error: unknown) {
    failed += 1
    console.log(`   \u2717 ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

test('every type has its own meta line, and each line says what the type machines', () => {
  assert.deepEqual(
    PROJECT_TYPES.map(projectTypeMetaKey),
    [
      'dialogs.newProject.projectTypeMillingMeta',
      'dialogs.newProject.projectTypePlasmaMeta',
      'dialogs.newProject.projectTypeRotaryMeta',
    ],
    'the tiles show the milling, plasma and rotary meta in that order',
  )
  assert.equal(new Set(PROJECT_TYPES.map(projectTypeMetaKey)).size, 3, 'no two types share a meta line')

  // The mapping points at real, non-empty catalog entries in the reference pack.
  for (const type of PROJECT_TYPES) {
    const value = dialogsEn[projectTypeMetaKey(type)]
    assert.equal(typeof value, 'string', `${type}: the meta key resolves to a catalog value`)
    assert.ok(value.length > 0, `${type}: the meta line is not empty`)
  }
})

test('ArrowRight and ArrowDown move to the next type, wrapping at the end', () => {
  assert.equal(projectTypeKeyNav('milling', 'ArrowRight'), 'plasma', 'milling → plasma')
  assert.equal(projectTypeKeyNav('plasma', 'ArrowRight'), 'rotary', 'plasma → rotary')
  // The end wraps back to the first tile rather than stopping.
  assert.equal(projectTypeKeyNav('rotary', 'ArrowRight'), 'milling', 'rotary → milling (wrap)')

  assert.equal(projectTypeKeyNav('milling', 'ArrowDown'), 'plasma', 'down moves forward like right')
  assert.equal(projectTypeKeyNav('rotary', 'ArrowDown'), 'milling', 'down wraps too')
})

test('ArrowLeft and ArrowUp move to the previous type, wrapping at the start', () => {
  assert.equal(projectTypeKeyNav('plasma', 'ArrowLeft'), 'milling', 'plasma → milling')
  assert.equal(projectTypeKeyNav('rotary', 'ArrowLeft'), 'plasma', 'rotary → plasma')
  // The start wraps back to the last tile rather than stopping.
  assert.equal(projectTypeKeyNav('milling', 'ArrowLeft'), 'rotary', 'milling → rotary (wrap)')

  assert.equal(projectTypeKeyNav('plasma', 'ArrowUp'), 'milling', 'up moves back like left')
  assert.equal(projectTypeKeyNav('milling', 'ArrowUp'), 'rotary', 'up wraps too')
})

test('any other key keeps the current choice', () => {
  for (const key of ['Enter', ' ', 'Tab', 'Escape', 'a', 'Home', 'End', 'PageDown']) {
    for (const type of PROJECT_TYPES) {
      assert.equal(projectTypeKeyNav(type, key), type, `${key} leaves ${type} selected`)
    }
  }
})

test('walking forward three times visits every type and returns to the start', () => {
  let current: ProjectType = 'milling'
  const visited: ProjectType[] = [current]
  for (let step = 0; step < PROJECT_TYPES.length; step += 1) {
    current = projectTypeKeyNav(current, 'ArrowRight')
    visited.push(current)
  }
  assert.deepEqual(visited, ['milling', 'plasma', 'rotary', 'milling'], 'one full lap of the group')
})

console.log(`\nNew project type tiles: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  throw new Error(`${failed} new project type tile test(s) failed`)
}
