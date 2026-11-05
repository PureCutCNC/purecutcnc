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
 * #1103 slice ca-h, part 1: a Thread's depth passes go forward (#1152).
 *
 * A Thread canned shape is cut by a Follow line on an Around feature: each
 * depth pass is the same helix line, and wrapping it gives every pass the
 * line's own start angle. Before this slice the lifted return between passes
 * therefore unwound A by the whole thread's turns — six full revolutions on
 * this fixture, three times over. `forwardWrappedToolpath` retargets only the
 * lifted return: it goes to the smallest whole-turn equivalent at or ahead of
 * the A the previous pass ended at, and the whole pass inherits the offset. A
 * whole turn is the same physical orientation, so the thread's phase and every
 * cut are unchanged.
 *
 * What is checked here, from the real store actions and the real generator:
 *
 *  - every commanded A in the operation is non-decreasing (the old behaviour's
 *    first return drops A from 2250 to 112.86);
 *  - each pass starts at an angle congruent to the original start's modulo 360;
 *  - every cut point lies on the **thread's own helix line**, measured in the
 *    unrolled sheet, up to whole circumferences — an independent phase
 *    reference, so a pass that dropped into a shifted groove would fail;
 *  - every cut keeps its pass's intended depth below the Turn surface (the
 *    analytic swept-depth bound: no pass cuts deeper than `carveDepth`, and the
 *    three passes are exactly the stepdown apart), so a shifted pass that
 *    gouged its flank cannot pass.
 *
 * Mutation proved caught by hand (see the slice report): restoring the plain
 * start angle in `forwardWrappedToolpath` — i.e. not shifting the return at all
 * — makes the monotonic-A assertion fail on the second pass's return rapid
 * (2250 -> 112.86).
 *
 * Run with: npx tsx src/engine/toolpaths/rotaryThreadPasses.test.ts
 */

import assert from 'node:assert/strict'
import {
  defaultTool,
  newProject,
  roundStock,
  type Operation,
  type Project,
  type Tool,
} from '../../types/project'
import { useProjectStore } from '../../store/projectStore'
import { switchWorkspaceFace } from '../../store/workspaceFace'
import { planRotarySolid } from '../../store/helpers/rotarySolids'
import type { SelectionState } from '../../store/types'
import { aroundFrameForOperation, unwrapPoint } from '../aroundFrame'
import { computeOperationToolpath } from './generateOperation'
import { buildRotaryPatternLines } from '../rotaryPatterns'
import { normalizeThreadCannedParams } from '../../cannedShapes/generators/thread'

const store = () => useProjectStore.getState()
const EMPTY_SELECTION: SelectionState = {
  mode: 'feature',
  selectedFeatureId: null,
  selectedFeatureIds: [],
  selectedTabIds: [],
  selectedClampIds: [],
  selectedNode: null,
  hoveredFeatureId: null,
  sketchEditTool: null,
  activeControl: null,
  groupFolderId: null,
}

const BAR_DIAMETER = 1
const BAR_LENGTH = 4
const BAR_ORIGIN = { x: 2, y: 2 }
const TURN = { start: 1.5, length: 1.5, diameter: 0.75 }
const THREAD = { start: 1.5, length: 1.25, pitch: 0.2, starts: 1, depth: 0.122 }
const CARVE_DEPTH = 0.06
const STEPDOWN = 0.02

function vBit(): Tool {
  return { ...defaultTool('inch', 1), id: 'vbit', name: 'vbit', type: 'v_bit', diameter: 0.125, maxCutDepth: 0.5 }
}

function setUpProject(): Project {
  const project = newProject('thread passes', 'inch')
  project.meta.projectType = 'rotary'
  project.meta.maxTravelZ = 3
  project.stock = roundStock(BAR_DIAMETER, BAR_LENGTH, 'x', BAR_ORIGIN)
  project.tools = [vBit()]
  return project
}

/** The project the way a user authors it: a Turn, a Thread, and a Follow line. */
function buildThreadProject(): { project: Project; operation: Operation; threadFeatureId: string } {
  store().loadProject(setUpProject())
  assert.equal(switchWorkspaceFace('around'), true, 'the Around face is available on a round bar')
  const planned = planRotarySolid(store().project, EMPTY_SELECTION, { kind: 'turn', ...TURN })
  assert.ok(planned.ok, `the Turn must be created (${planned.ok ? '' : planned.reason})`)
  store().loadProject(planned.project)
  assert.equal(switchWorkspaceFace('around'), true, 'the Around face is available after a write')

  const created = store().addRotaryPattern({ kind: 'thread', ...THREAD })
  assert.ok(created.ok, `the Thread must be created (${created.ok ? '' : created.reason})`)
  const operationId = store().addOperation('follow_line', 'rough', { source: 'features', featureIds: [created.featureId] })
  assert.ok(operationId, 'the Follow line operation must be accepted')
  // A rough Follow line steps down; a finish cuts in one pass.
  store().updateOperation(operationId, { toolRef: 'vbit', carveDepth: CARVE_DEPTH, stepdown: STEPDOWN })
  const project = store().project
  const operation = project.operations.find((row) => row.id === operationId)
  assert.ok(operation, 'the operation is in the project')
  return { project, operation, threadFeatureId: created.featureId }
}

const { project, operation, threadFeatureId } = buildThreadProject()
const envelope = computeOperationToolpath(project, operation)
assert.ok(envelope, 'the wrapped Follow line generates')
const result = envelope.result
const moves = result.moves

// ── 1. A never rewinds, and each pass starts at the same phase ──

{
  assert.ok(moves.length > 0, 'the operation emits motion')
  for (let index = 1; index < moves.length; index++) {
    const previous = moves[index - 1]
    const move = moves[index]
    assert.ok(move.from.a !== undefined && move.to.a !== undefined, `move ${index} carries A`)
    assert.ok(move.to.a! >= move.from.a! - 1e-9,
      `move ${index} (${move.kind}) never turns the bar backward: ${move.from.a} -> ${move.to.a}`)
    assert.ok(move.from.a! >= previous.to.a! - 1e-9 || move.kind === 'rapid',
      `move ${index} continues from where the last one ended`)
  }

  const cuts = moves.filter((move) => move.kind === 'cut')
  assert.equal(cuts.length, 3, `a 0.06 in carve at a 0.02 in stepdown is three passes, got ${cuts.length}`)
  const starts = cuts.map((move) => move.from.a!)
  for (const start of starts) {
    const turns = (start - starts[0]) / 360
    assert.ok(Math.abs(turns - Math.round(turns)) < 1e-9,
      `every pass starts at the original angle modulo 360 (${starts[0]} vs ${start})`)
  }
  for (let pass = 1; pass < cuts.length; pass++) {
    assert.ok(cuts[pass].from.a! >= cuts[pass - 1].to.a! - 1e-9,
      `pass ${pass + 1} starts at or ahead of where pass ${pass} ended`)
  }
  console.log(`   three passes at A ${starts.map((value) => value.toFixed(2)).join(', ')}; `
    + `the bar never rewinds`)
}

// ── 2. Every cut lies on the thread's own helix, up to whole turns ──

{
  const frame = aroundFrameForOperation(project, operation)
  assert.ok(frame, 'the operation is in an Around setup')
  const feature = project.features.find((row) => row.id === threadFeatureId)
  assert.ok(feature, 'the Thread feature is in the project')
  const definition = project.featureDefinitions[feature.definitionId]
  const params = normalizeThreadCannedParams(definition.canned!.params)
  assert.ok(params, 'the Thread parameters normalize')
  const built = buildRotaryPatternLines(params.frame, {
    kind: 'thread',
    start: params.start,
    length: params.length,
    pitch: params.pitch,
    starts: params.starts,
    hand: params.hand,
    depth: params.depth,
  })
  assert.ok(built.ok, 'the Thread line builds')
  const line = built.lines[0]
  const circumference = frame!.circumference
  const slope = (line.acrossEnd - line.acrossStart) / (line.alongEnd - line.alongStart)

  const pivot = BAR_DIAMETER / 2
  const cutRadii: number[] = []
  let checked = 0
  for (const move of moves) {
    if (move.kind !== 'cut' && move.kind !== 'lead_in' && move.kind !== 'lead_out') continue
    for (const point of [move.from, move.to]) {
      const flat = unwrapPoint(point, frame!)
      const along = frame!.axis === 'x' ? flat.x : flat.y
      const across = frame!.axis === 'x' ? flat.y : flat.x
      // The thread line, continued by whole circumferences: only whole turns
      // were added, so a phase shift of anything but an integer circumference
      // means the pass dropped into a different groove.
      const onLine = line.acrossStart + slope * (along - line.alongStart)
      const offset = (across - onLine) / circumference
      assert.ok(Math.abs(offset - Math.round(offset)) < 1e-6,
        `a cut point sits ${offset.toFixed(6)} circumferences off the thread's helix`)
      checked += 1
      cutRadii.push(point.z - pivot)
    }
  }
  assert.ok(checked >= 6, `the phase reference checks every cut point (${checked})`)

  // The analytic swept-depth bound: no cut goes below the intended thread
  // depth, and the three passes sit exactly one stepdown apart. A pass that
  // gouged its flank (or drifted axially onto a neighbouring groove) would cut
  // outside this set.
  const depths = [...new Set(cutRadii.map((radius) => Number(radius.toFixed(9))))].sort((a, b) => b - a)
  assert.equal(depths.length, 3, `three distinct pass depths, got ${JSON.stringify(depths)}`)
  for (let pass = 0; pass < depths.length; pass++) {
    assert.ok(Math.abs(depths[pass] - (TURN.diameter / 2 - STEPDOWN * (pass + 1))) < 1e-6,
      `pass ${pass + 1} cuts exactly its stepdown below the Turn surface: ${depths[pass]}`)
  }
  assert.ok(depths[depths.length - 1] >= TURN.diameter / 2 - CARVE_DEPTH - 1e-6,
    'and no pass cuts deeper than the operation carve depth')
  console.log(`   every cut point lies on the thread helix; radii ${depths.map((value) => value.toFixed(4)).join(', ')}`)
}

console.log('rotary thread pass tests passed')
