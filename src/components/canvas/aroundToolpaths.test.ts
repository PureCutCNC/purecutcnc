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
 * Which face's toolpaths the Sketch draws (issue #395 slice D2): a flat face
 * and the sheet share no plane, and an Around operation's wrapped path comes
 * back on the sheet.
 *
 * Mutations checked one at a time against these assertions:
 * - the face filter removed → "a Top toolpath is not drawn on Around" and "an
 *   Around toolpath is not drawn on Top" fail;
 * - the unwrap removed → "an Around path is drawn on the sheet" fails;
 * - the display cache removed → "the unwrapped result is the same object
 *   between frames" fails.
 *
 * Run with: npx tsx src/components/canvas/aroundToolpaths.test.ts
 */

import { aroundFrame, wrapToolpath } from '../../engine/aroundFrame'
import { DEFAULT_SETUP_ID, newProject, roundStock } from '../../types/project'
import type { MachiningSetup, Project } from '../../types/project'
import type { ToolpathResult } from '../../engine/toolpaths/types'
import { toolpathForActiveFace } from './aroundToolpaths'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

function near(actual: number, expected: number, message: string): void {
  assert(Math.abs(actual - expected) <= 1e-9, `${message}: ${actual} != ${expected}`)
}

const STOCK = roundStock(40, 200, 'x', { x: 10, y: 30 })
const AROUND_SETUP: MachiningSetup = {
  id: 'setup-around',
  name: 'Around',
  kind: 'around',
  orientation: { axis: 'x', angleDeg: 0 },
  indexing: 'manual',
  registration: [],
  notes: '',
  operationIds: [],
}
const BOTTOM_SETUP: MachiningSetup = {
  id: 'setup-bottom',
  name: 'Bottom',
  orientation: { axis: 'x', angleDeg: 180 },
  indexing: 'manual',
  registration: [],
  notes: '',
  operationIds: [],
}

function project(activeSetupId: string): Project {
  const base = newProject()
  return {
    ...base,
    stock: STOCK,
    setups: [...base.setups, AROUND_SETUP, BOTTOM_SETUP],
    activeSetupId,
    operations: [
      { id: 'op-top' } as Project['operations'][number],
      { id: 'op-around', setupId: 'setup-around' } as Project['operations'][number],
    ],
  }
}

/** A flat two-move path the around frame can wrap. */
function flatToolpath(): ToolpathResult {
  return {
    operationId: 'op-around',
    moves: [
      { kind: 'cut', from: { x: 20, y: 40, z: 10 }, to: { x: 60, y: 40, z: 10 } },
      { kind: 'cut', from: { x: 60, y: 40, z: 10 }, to: { x: 60, y: 90, z: 5 } },
    ],
    warnings: [],
    bounds: null,
  }
}

const frame = aroundFrame(STOCK)

// ── Around draws the unwrapped path ──────────────────────────

{
  const wrapped = wrapToolpath(flatToolpath(), frame)
  assert(wrapped.moves[0].from.y === frame.centre, 'the stored path is wrapped onto the centreline')
  assert(wrapped.moves[0].from.a !== undefined, 'the stored path carries its rotary angle')

  const drawn = toolpathForActiveFace(project('setup-around'), wrapped)
  assert(drawn !== null, 'an Around operation is drawn on Around')
  near(drawn!.moves[0].from.y, 40, 'the path comes back at its sheet across coordinate')
  near(drawn!.moves[0].from.z, 10, 'the path comes back at its sheet height')
  assert(drawn!.moves[0].from.a === undefined, 'a drawn path carries no rotary angle')
  const last = drawn!.moves[drawn!.moves.length - 1]
  near(last.to.y, 90, 'the last move ends at its sheet across coordinate')
  near(last.to.z, 5, 'the last move ends at its sheet height')

  assert(toolpathForActiveFace(project('setup-around'), wrapped) === drawn, 'the unwrapped result is the same object between frames')
}

// ── No cross-face drawing ────────────────────────────────────

{
  const wrapped = wrapToolpath(flatToolpath(), frame)
  assert(toolpathForActiveFace(project(DEFAULT_SETUP_ID), wrapped) === null, 'an Around toolpath is not drawn on Top')
  assert(toolpathForActiveFace(project('setup-bottom'), wrapped) === null, 'an Around toolpath is not drawn on Bottom')

  const topPath: ToolpathResult = { ...flatToolpath(), operationId: 'op-top' }
  assert(toolpathForActiveFace(project('setup-around'), topPath) === null, 'a Top toolpath is not drawn on Around')
  const drawnTop = toolpathForActiveFace(project(DEFAULT_SETUP_ID), topPath)
  assert(drawnTop === topPath, 'a Top toolpath is drawn as it is on Top')
  // Top and Bottom keep drawing each other's paths, muted (issue #947); only
  // the sheet is filtered out of a flat view.
  assert(toolpathForActiveFace(project('setup-bottom'), topPath) === topPath, 'a Top toolpath is still drawn on Bottom, as before')
}

// ── A path with no operation is left alone ───────────────────

{
  const orphan: ToolpathResult = { ...flatToolpath(), operationId: 'gone' }
  assert(toolpathForActiveFace(project('setup-around'), orphan) === orphan, 'a path whose operation is gone is left to the caller')
}

console.log('aroundToolpaths: all assertions passed')
