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
 * Edits of a Bottom feature's Z range, as stock-space writes (issue #945).
 *
 * Mutations these assertions were checked against:
 * - a Line's far side never written (the original code) → "a Line moved from
 *   Top is put on the bottom face" fails;
 * - a Line's far side always written → "a Line drawn on Bottom keeps its
 *   stored far side" fails;
 * - both sides written for a pocket → "only the edited side is written" fails;
 * - an inside-out entry swapped instead of refused → "is refused" fails.
 *
 * Run with: npx tsx src/components/feature-tree/faceZRangeEdit.test.ts
 */

import { flippedZRange } from '../../store/helpers/activeFace'
import { planFaceZEdit } from './faceZRangeEdit'
import type { FaceZRow } from './faceZRangeEdit'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const stock = { thickness: 0.75 }

function row(featureId: string, span: { z_top: number; z_bottom: number }, surfaceOnly: boolean): FaceZRow {
  return { featureId, span, z: flippedZRange(span, stock), surfaceOnly }
}

/** The span a feature holds after the writes, with the store's own rule applied. */
function applied(target: FaceZRow, writes: ReturnType<typeof planFaceZEdit>): { z_top: number; z_bottom: number } {
  const patch = writes?.find((write) => write.featureId === target.featureId)?.patch ?? {}
  return { z_top: patch.z_top ?? target.span.z_top, z_bottom: patch.z_bottom ?? target.span.z_bottom }
}

// The review's case: a Top Line (surface at 0.5, down to 0) moved to Bottom.
// It reads Z top 0.75 there; setting it to 0.1 must leave a Line 0.1 above the
// table as the stock sits flipped — the stock span 0.65 → 0.75.
{
  const movedLine = row('line', { z_top: 0.5, z_bottom: 0 }, true)
  assert(movedLine.z.top === 0.75, 'fixture: the moved Line reads on the bottom face')
  const writes = planFaceZEdit([movedLine], { top: 0.1 }, stock)
  const span = applied(movedLine, writes)
  assert(
    span.z_bottom === 0.65 && span.z_top === 0.75,
    `a Line moved from Top is put on the bottom face: got [${span.z_bottom}, ${span.z_top}]`,
  )
  assert(span.z_top >= span.z_bottom, 'and its stored span is the right way up')
}

// A Line drawn on Bottom already ends at the far face: only its surface is written.
{
  const line = row('line', { z_top: 0.75, z_bottom: 0.25 }, true)
  const writes = planFaceZEdit([line], { top: 0.3 }, stock)
  assert(writes !== null && writes.length === 1, 'the Line is written')
  assert(writes[0].patch.z_bottom === 0.45 && writes[0].patch.z_top === undefined, 'a Line drawn on Bottom keeps its stored far side')
}

// A pocket: each handle writes its own side, and the other keeps its value.
{
  const pocket = row('pocket', { z_top: 0.25, z_bottom: 0 }, false)
  assert(pocket.z.top === 0.75 && pocket.z.bottom === 0.5, 'fixture: a 0.25 pocket from the bottom reads 0.75 → 0.5')
  const deeper = planFaceZEdit([pocket], { bottom: 0.4 }, stock)
  assert(
    deeper !== null && deeper[0].patch.z_top === 0.35 && deeper[0].patch.z_bottom === undefined,
    'only the edited side is written (bottom handle)',
  )
  const floating = planFaceZEdit([pocket], { top: 0.65 }, stock)
  assert(
    floating !== null && floating[0].patch.z_bottom === 0.1 && floating[0].patch.z_top === undefined,
    'only the edited side is written (top handle)',
  )
  assert(planFaceZEdit([pocket], { top: 0.4 }, stock) === null, 'a top below the bottom is refused')
  assert(planFaceZEdit([pocket], { bottom: 0.8 }, stock) === null, 'a bottom above the top is refused')
}

// A pocket and a Line together: the bottom handle belongs to the pocket alone.
{
  const pocket = row('pocket', { z_top: 0.25, z_bottom: 0 }, false)
  const line = row('line', { z_top: 0.75, z_bottom: 0 }, true)
  const writes = planFaceZEdit([pocket, line], { bottom: 0.4 }, stock)
  assert(writes !== null && writes.length === 1 && writes[0].featureId === 'pocket', 'the bottom handle leaves a Line alone')
}

console.log('faceZRangeEdit tests passed')
