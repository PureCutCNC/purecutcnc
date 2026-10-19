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
import {
  createCommandRegistry,
  filterCommands,
  listCommands,
  type CommandSpec,
} from './commandRegistry'

function command(overrides: Partial<CommandSpec> & Pick<CommandSpec, 'id' | 'label'>): CommandSpec {
  return {
    group: 'file',
    effect: 'read',
    enabled: true,
    run: () => undefined,
    ...overrides,
  }
}

const commands: CommandSpec[] = [
  command({ id: 'file.undo', label: 'Undo', keywords: ['history', 'back'] }),
  command({ id: 'sketch.delete', label: 'Delete selection', group: 'sketch', effect: 'destructive' }),
  command({ id: 'view.zoom', label: 'Zoom to model', group: 'view', keywords: ['fit'] }),
]

assert.deepEqual(filterCommands(commands, '').map((entry) => entry.id), [
  'file.undo',
  'sketch.delete',
  'view.zoom',
])
assert.deepEqual(filterCommands(commands, 'BACK').map((entry) => entry.id), ['file.undo'])
assert.deepEqual(filterCommands(commands, 'sketch delete').map((entry) => entry.id), ['sketch.delete'])
assert.deepEqual(filterCommands(commands, 'fit model').map((entry) => entry.id), ['view.zoom'])
assert.deepEqual(filterCommands(commands, 'missing'), [])

const infos = listCommands(commands)
assert.equal(infos.length, 3)
assert.equal('run' in infos[0], false)
assert.deepEqual(infos[0].keywords, ['history', 'back'])
assert.equal(infos[0].shortcut, null)
assert.equal(infos[1].effect, 'destructive')
assert.equal(infos[2].group, 'view')

let ran = 0
const registry = createCommandRegistry([
  command({ id: 'file.save', label: 'Save', run: () => { ran += 1 } }),
  command({ id: 'file.undo', label: 'Undo', enabled: false }),
  command({ id: 'file.explode', label: 'Explode', run: () => { throw new Error('boom') } }),
])

assert.equal(registry.get('file.save')?.label, 'Save')
assert.equal(registry.get('missing'), undefined)
assert.equal(registry.list().length, 3)
assert.deepEqual(registry.search('save').map((entry) => entry.id), ['file.save'])

await registry.run('file.save')
assert.equal(ran, 1)
assert.deepEqual(await registry.run('missing'), { ok: false, reason: 'not-found' })
assert.deepEqual(await registry.run('file.undo'), { ok: false, reason: 'disabled' })

const failed = await registry.run('file.explode')
assert.equal(failed.ok, false)
assert.equal(failed.reason, 'error')
assert.ok(failed.error instanceof Error)

assert.throws(
  () => createCommandRegistry([
    command({ id: 'file.duplicate', label: 'First' }),
    command({ id: 'file.duplicate', label: 'Second' }),
  ]),
  /Duplicate command id: file\.duplicate/,
)

console.log('commandRegistry: ok')
