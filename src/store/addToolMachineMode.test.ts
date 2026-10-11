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
 * Issue #960 slice A: `addTool` follows the selected machine's kind. A plasma
 * project gets the example torch, a router project (and a project with no
 * machine) gets exactly the previous default tool.
 *
 * Run with: npx tsx src/store/addToolMachineMode.test.ts
 */

import assert from 'node:assert/strict'
import { useProjectStore } from './projectStore'
import { BUNDLED_DEFINITIONS } from '../engine/gcode/definitions'
import type { MachineDefinition } from '../engine/gcode/types'
import { defaultTool, newProject, type Project, type ProjectMeta } from '../types/project'
import { defaultPlasmaTool } from '../toolPolicy'

function bundled(id: string): MachineDefinition {
  const definition = BUNDLED_DEFINITIONS.find((candidate) => candidate.id === id)
  assert(definition !== undefined, `expected the bundled ${id} definition`)
  return definition
}

const ROUTER = bundled('generic')
const QTPLASMAC = bundled('qtplasmac')

function withMachine(base: Project, definition: MachineDefinition | null): Project {
  return {
    ...base,
    meta: {
      ...base.meta,
      machineDefinitions: definition ? [definition] : [],
      selectedMachineId: definition?.id ?? null,
    },
  }
}

function seed(project: Project): void {
  useProjectStore.setState({ project, history: { past: [], future: [], transactionStart: null } })
}

function onlyTool(): Project['tools'][number] {
  const tools = useProjectStore.getState().project.tools
  assert(tools.length === 1, `expected exactly one tool, got ${tools.length}`)
  return tools[0]
}

function testPlasmaCreatesExampleTorch(units: ProjectMeta['units']): void {
  const base = newProject('t', units)
  seed(withMachine(base, QTPLASMAC))

  const id = useProjectStore.getState().addTool()
  const created = onlyTool()
  const { id: createdId, name, ...fields } = created

  assert(createdId === id, 'the created tool carries the id addTool returned')
  assert(name === 'Plasma torch', `expected the torch name, got ${name}`)
  assert(created.type === 'plasma', 'the created tool is a torch')
  assert.deepEqual(fields, defaultPlasmaTool(units), `torch fields equal defaultPlasmaTool in ${units}`)
}

function testSecondTorchGetsUniqueName(): void {
  const base = newProject('t', 'mm')
  seed(withMachine(base, QTPLASMAC))

  const firstId = useProjectStore.getState().addTool()
  const secondId = useProjectStore.getState().addTool()
  const tools = useProjectStore.getState().project.tools

  assert(tools.length === 2, `expected two tools, got ${tools.length}`)
  assert(firstId !== secondId, 'each torch gets its own id')
  assert(tools[0].name === 'Plasma torch', `expected the first name to stay plain, got ${tools[0].name}`)
  assert(tools[1].name === 'Plasma torch 2', `expected a numbered unique name, got ${tools[1].name}`)
  const names = tools.map((tool) => tool.name)
  assert(names.length === new Set(names).size, 'a second torch gets a name unique among the project tools')
}

function testRouterUnchanged(): void {
  const base = newProject('t', 'mm')
  seed(withMachine(base, ROUTER))

  const id = useProjectStore.getState().addTool()
  const created = onlyTool()

  assert.deepEqual(created, { ...defaultTool('mm', 1), id })
}

function testNoMachineUnchanged(): void {
  seed(newProject('t', 'mm'))

  const id = useProjectStore.getState().addTool()
  const created = onlyTool()

  assert.deepEqual(created, { ...defaultTool('mm', 1), id })
}

testPlasmaCreatesExampleTorch('mm')
testPlasmaCreatesExampleTorch('inch')
testSecondTorchGetsUniqueName()
testRouterUnchanged()
testNoMachineUnchanged()

console.log('addToolMachineMode tests passed')
