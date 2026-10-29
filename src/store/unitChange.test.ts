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
 *
 * Run with: npx tsx src/store/unitChange.test.ts
 */

import { newProject } from '../types/project'
import type { Project } from '../types/project'
import { useProjectStore } from './projectStore'
import type { ProjectStore } from './types'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(left: number, right: number, epsilon = 1e-9): boolean {
  return Math.abs(left - right) <= epsilon
}

function makeProject(): Project {
  const project = newProject('Unit change store test', 'mm')
  return {
    ...project,
    meta: {
      ...project.meta,
      modified: '2000-01-01T00:00:00.000Z',
      maxTravelZ: 254,
    },
    stock: { ...project.stock, thickness: 25.4 },
  }
}

function resetStore(project = makeProject()): void {
  useProjectStore.setState({
    project,
    history: { past: [], future: [], transactionStart: null },
  } as unknown as Partial<ProjectStore>)
}

function serializedWithoutUnitMetadata(project: Project): string {
  const { units: _units, modified: _modified, ...metadata } = project.meta
  return JSON.stringify({ ...project, meta: metadata })
}

// Convert mode preserves physical size and creates one undoable mutation.
{
  const original = makeProject()
  resetStore(original)
  useProjectStore.getState().setUnits('inch', 'convert')

  let state = useProjectStore.getState()
  assert(state.project.meta.units === 'inch', 'convert mode changes units')
  assert(approx(state.project.stock.thickness, 1), 'convert mode scales project values')
  assert(approx(state.project.meta.maxTravelZ, 10), 'convert mode scales metadata values')
  assert(state.project.meta.modified !== original.meta.modified, 'convert mode updates modified timestamp')
  assert(state.history.past.length === 1, 'convert mode creates one history entry')
  assert(state.history.future.length === 0, 'convert mode clears future history')

  state.undo()
  state = useProjectStore.getState()
  assert(state.project.meta.units === 'mm', 'undo restores original units')
  assert(approx(state.project.stock.thickness, 25.4), 'undo restores original values')

  state.redo()
  state = useProjectStore.getState()
  assert(state.project.meta.units === 'inch', 'redo restores converted units')
  assert(approx(state.project.stock.thickness, 1), 'redo restores converted values')
  console.log('convert mode history PASS')
}

// Reinterpret mode changes only unit metadata (plus the required modified timestamp).
{
  const original = makeProject()
  resetStore(original)
  useProjectStore.getState().setUnits('inch', 'reinterpret')

  const state = useProjectStore.getState()
  assert(state.project.meta.units === 'inch', 'reinterpret mode changes units')
  assert(state.project.stock.thickness === 25.4, 'reinterpret mode keeps numeric values')
  assert(
    serializedWithoutUnitMetadata(state.project) === serializedWithoutUnitMetadata(original),
    'reinterpret mode leaves all non-unit project values unchanged',
  )
  assert(state.history.past.length === 1, 'reinterpret mode creates one history entry')
  console.log('reinterpret mode PASS')
}

// Selecting the current units is a no-op in either mode.
{
  resetStore()
  const before = useProjectStore.getState().project
  useProjectStore.getState().setUnits('mm', 'convert')
  useProjectStore.getState().setUnits('mm', 'reinterpret')
  const state = useProjectStore.getState()
  assert(state.project === before, 'same-unit calls keep the project reference')
  assert(state.history.past.length === 0, 'same-unit calls do not create history')
  console.log('same-unit no-op PASS')
}

console.log('\nall unitChange.test.ts assertions passed')
