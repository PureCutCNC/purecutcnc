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

import type { MachineDefinition } from '../../engine/gcode/types'
import { useProjectStore } from '../projectStore'
import {
  slugFromName,
  allocateMachineId,
} from './machineDefsSlice'

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

/** Minimal valid machine definition. */
function makeDef(id: string, name?: string, builtin = false): MachineDefinition {
  return {
    id,
    name: name ?? id,
    description: `Description for ${name ?? id}`,
    builtin,
    fileExtension: 'nc',
    coordinateSystem: { xAxis: 'X' as const, yAxis: 'Y' as const, zAxis: 'Z' as const },
    numberFormat: { decimalPlaces: { mm: 3, inch: 4 }, trailingZeros: false, leadingZero: false },
    units: { mmCommand: 'G21', inchCommand: 'G20' },
    program: {
      header: ['G90'],
      operationHeader: [],
      footer: ['M30'],
      commentPrefix: '(',
      commentSuffix: ')',
      lineNumbers: false,
      lineNumberIncrement: 1,
    },
    workCoordinates: { selectCommand: 'G54' },
    motion: {
      rapidCommand: 'G00',
      linearCommand: 'G01',
      cwArcCommand: 'G02',
      ccwArcCommand: 'G03',
      arcFormat: 'ij' as const,
      modalMotion: true,
    },
    feedSpeed: {
      feedCommand: 'F',
      rpmCommand: 'S',
      spindleOnCW: 'M03',
      spindleOnCCW: 'M04',
      spindleOff: 'M05',
      inlineWithMotion: false,
      modalFeedSpeed: true,
    },
    toolChange: {
      commands: ['T[TOOL]', 'M06'],
      stopSpindleFirst: true,
      pauseAfterChange: false,
      pauseCommand: 'M00',
    },
    cannedCycles: null,
    coolant: {
      floodOnCommand: 'M8',
      mistOnCommand: 'M7',
      coolantOffCommand: 'M9',
    },
    stop: { programEndCommand: 'M30' },
  } as MachineDefinition
}

function makeMockProject(defs: MachineDefinition[], selectedMachineId?: string | null) {
  return {
    version: '1.0',
    meta: {
      name: 'test',
      units: 'mm' as const,
      created: '2026-01-01T00:00:00Z',
      modified: '2026-01-01T00:00:00Z',
      showFeatureInfo: false,
      showDimensions: false,
      copyMode: 'reference' as const,
      maxTravelZ: 10,
      operationClearanceZ: 5,
      clampClearanceXY: 1,
      clampClearanceZ: 1,
      machineDefinitions: defs,
      selectedMachineId: selectedMachineId ?? (defs.length > 0 ? defs[0].id : null),
    },
    grid: { extent: 200, majorSpacing: 20, minorSpacing: 5, snapIncrement: 0.1, visible: true },
    stock: { x: 0, y: 0, w: 200, h: 200, thickness: 10, material: '', color: '#cccccc', visible: true, sourceFeatureId: null, sourceFeature: null },
    origin: { name: 'Origin', x: 0, y: 0, z: 10, visible: true },
    backdrop: null,
    dimensions: {},
    annotations: [],
    modelAssets: {},
    featureDefinitions: {},
    features: [],
    featureFolders: [],
    featureTree: [],
    global_constraints: [],
    tools: [],
    operations: [],
    tabs: [],
    clamps: [],
    ai_history: [],
  } as any
}

// ── slugFromName / allocateMachineId ───────────────────────────

{
  assert(slugFromName('GRBL Machine') === 'grbl-machine', 'slugFromName: spaces become hyphens')
  assert(slugFromName('  Test--Foo  ') === 'test-foo', 'slugFromName: trim + collapse')
  assert(slugFromName('Máquina #1') === 'm-quina-1', 'slugFromName: non-alphanumeric removed')
  assert(slugFromName('') === '', 'slugFromName: empty')
}

{
  const existing = new Set(['grbl', 'grbl-2', 'grbl-3'])
  assert(allocateMachineId('grbl', existing) === 'grbl-4', 'allocateMachineId: skips occupied slugs')
  assert(allocateMachineId('unique', existing) === 'unique', 'allocateMachineId: returns base for unique')
  assert(allocateMachineId('', existing) === 'custom-machine', 'allocateMachineId: fallback for empty')
}

{
  const existing = new Set<string>()
  assert(allocateMachineId('GRBL', existing) === 'grbl', 'allocateMachineId: lowercases')
}

// ── updateMachineDefinition ─────────────────────────────────────

{
  // Set up store with two custom definitions.
  const defA = makeDef('alpha', 'Alpha')
  const defB = makeDef('beta', 'Beta')
  const project = makeMockProject([defA, defB], 'alpha')
  useProjectStore.setState({ project, history: { past: [], future: [], transactionStart: null } } as any)

  // Update name in place.
  const state = useProjectStore.getState()
  state.updateMachineDefinition('alpha', { ...defA, name: 'Alpha Revised' })

  const updated = useProjectStore.getState().project
  const defs = updated.meta.machineDefinitions
  assert(defs.length === 2, 'updateMachineDefinition: count unchanged')
  assert(defs[0].id === 'alpha', 'updateMachineDefinition: first entry still alpha (order preserved)')
  assert(defs[0].name === 'Alpha Revised', 'updateMachineDefinition: name updated')
  assert(defs[1].id === 'beta', 'updateMachineDefinition: second entry unchanged')
}

{
  // Rejects invalid definition (patch with bad motion.arcFormat)
  const defA = makeDef('alpha', 'Alpha')
  const project = makeMockProject([defA], 'alpha')
  useProjectStore.setState({ project, history: { past: [], future: [], transactionStart: null } } as any)

  const badDef = { ...defA, motion: { ...defA.motion, arcFormat: 'INVALID' } } as any
  const state = useProjectStore.getState()
  // Should throw from Zod validation; the state should remain unchanged.
  let threw = false
  try {
    state.updateMachineDefinition('alpha', badDef)
  } catch {
    threw = true
  }
  assert(threw, 'updateMachineDefinition: throws on invalid definition')
  // Store unchanged
  const current = useProjectStore.getState().project.meta.machineDefinitions
  assert(current[0].motion.arcFormat === 'ij', 'updateMachineDefinition: unchanged after failed validation')
}

{
  // No-op on builtin definitions.
  const defA = makeDef('builtin-alpha', 'Builtin Alpha', true)
  const project = makeMockProject([defA], 'builtin-alpha')
  useProjectStore.setState({ project, history: { past: [], future: [], transactionStart: null } } as any)

  const state = useProjectStore.getState()
  state.updateMachineDefinition('builtin-alpha', { ...defA, name: 'Renamed Builtin' })

  const updated = useProjectStore.getState().project.meta.machineDefinitions
  assert(updated[0].name === 'Builtin Alpha', 'updateMachineDefinition: builtin definition unchanged (no-op)')
}

{
  // No-op on non-existent id.
  const defA = makeDef('alpha', 'Alpha')
  const project = makeMockProject([defA], 'alpha')
  useProjectStore.setState({ project, history: { past: [], future: [], transactionStart: null } } as any)

  const state = useProjectStore.getState()
  state.updateMachineDefinition('nonexistent', defA)
  // Should not have changed
  const current = useProjectStore.getState().project.meta.machineDefinitions
  assert(current.length === 1, 'updateMachineDefinition: no-op on non-existent id')
}

{
  // Id change in patch is ignored (id locked).
  const defA = makeDef('alpha', 'Alpha')
  const project = makeMockProject([defA], 'alpha')
  useProjectStore.setState({ project, history: { past: [], future: [], transactionStart: null } } as any)

  const state = useProjectStore.getState()
  state.updateMachineDefinition('alpha', { ...defA, id: 'hijacked' })

  const updated = useProjectStore.getState().project.meta.machineDefinitions
  assert(updated[0].id === 'alpha', 'updateMachineDefinition: id locked — patch id ignored')
}

// ── duplicateMachineDefinition ──────────────────────────────────

{
  // Duplicate a custom definition.
  const defA = makeDef('alpha', 'Alpha')
  const project = makeMockProject([defA], 'alpha')
  useProjectStore.setState({ project, history: { past: [], future: [], transactionStart: null } } as any)

  const state = useProjectStore.getState()
  state.duplicateMachineDefinition('alpha')

  const updated = useProjectStore.getState().project
  const defs = updated.meta.machineDefinitions
  assert(defs.length === 2, 'duplicateMachineDefinition: adds one definition')
  assert(defs[1].builtin === false, 'duplicateMachineDefinition: copy is not builtin')
  assert(defs[1].name === 'Alpha (copy)', 'duplicateMachineDefinition: name suffixed')
  assert(defs[1].id !== 'alpha', 'duplicateMachineDefinition: copy has new id')
  assert(updated.meta.selectedMachineId === defs[1].id, 'duplicateMachineDefinition: copy is selected')
}

{
  // Duplicate a bundled definition (should also work).
  const defA = makeDef('bundled', 'GRBL', true)
  const project = makeMockProject([defA], 'bundled')
  useProjectStore.setState({ project, history: { past: [], future: [], transactionStart: null } } as any)

  const state = useProjectStore.getState()
  state.duplicateMachineDefinition('bundled')

  const updated = useProjectStore.getState().project
  const defs = updated.meta.machineDefinitions
  assert(defs.length === 2, 'duplicateMachineDefinition: bundled duplicated')
  assert(defs[1].builtin === false, 'duplicateMachineDefinition: bundled copy not builtin')
  // Bundled definitions get no suffix (they're exact clones by default; suffix for clarity)
  assert(defs[1].name === 'GRBL (copy)', 'duplicateMachineDefinition: bundled copy has (copy)')
  assert(updated.meta.selectedMachineId === defs[1].id, 'duplicateMachineDefinition: bundled copy selected')
}

{
  // Duplicate twice yields distinct ids.
  const defA = makeDef('alpha', 'Alpha')
  const project = makeMockProject([defA], 'alpha')
  useProjectStore.setState({ project, history: { past: [], future: [], transactionStart: null } } as any)

  const state = useProjectStore.getState()
  state.duplicateMachineDefinition('alpha')
  state.duplicateMachineDefinition('alpha')

  const updated = useProjectStore.getState().project
  const defs = updated.meta.machineDefinitions
  assert(defs.length === 3, 'duplicateMachineDefinition: two copies added')
  assert(defs[1].id !== defs[2].id, 'duplicateMachineDefinition: copies have distinct ids')
  assert(defs[1].name === 'Alpha (copy)', 'duplicateMachineDefinition: first copy name')
  // Second copy gets unique id via allocateMachineId
}

{
  // No-op on non-existent id.
  const defA = makeDef('alpha', 'Alpha')
  const project = makeMockProject([defA], 'alpha')
  useProjectStore.setState({ project, history: { past: [], future: [], transactionStart: null } } as any)

  const state = useProjectStore.getState()
  state.duplicateMachineDefinition('nonexistent')

  const defs = useProjectStore.getState().project.meta.machineDefinitions
  assert(defs.length === 1, 'duplicateMachineDefinition: no-op on non-existent id')
}

{
  // History is pushed on duplicate.
  const defA = makeDef('alpha', 'Alpha')
  const project = makeMockProject([defA], 'alpha')
  useProjectStore.setState({ project, history: { past: [], future: [], transactionStart: null } } as any)

  const state = useProjectStore.getState()
  const pastLenBefore = state.history.past.length
  state.duplicateMachineDefinition('alpha')

  const after = useProjectStore.getState()
  assert(after.history.past.length > pastLenBefore, 'duplicateMachineDefinition: history pushed')
  assert(after.history.future.length === 0, 'duplicateMachineDefinition: future cleared')
}

console.log('machineDefsSlice.test.ts — all assertions passed')
