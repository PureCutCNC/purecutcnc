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
 * The clip-candidate scratch's *allocation*, not its use (#1115 slice p-e,
 * review round 2).
 *
 * `rotaryAnglePool.test.ts` already measures what the gather submits and what
 * the charge covers, but neither number sees how much memory the raster really
 * reserves. The original allocator rounded a first allocation up to 4096
 * entries and doubled a growing one, so a list of one candidate reserved
 * 16,384 bytes against the 8-byte bound the pool charges -- and every other
 * test stayed green, because the extra capacity changes no map value.
 *
 * So this file reads the array itself through
 * `rotaryCandidateScratchCapacityBytes` and pins the policy the charge assumes:
 *
 * - **the minimum allocation** is the submitted count, not a page or a
 *   doubling floor (a one-candidate list holds 4 bytes, against an 8-byte
 *   duplicate-inclusive bound where the old allocator reserved 16,384);
 * - **growth is exact** rather than doubling: a list one entry longer than the
 *   resident capacity grows by that one entry, never to twice the capacity,
 *   which is the state where a budget's arithmetic stops being a measurement;
 * - **reuse does not shrink**, so a smaller later list reads the array already
 *   there and the resident capacity is the largest submitted list the worker
 *   has seen -- which the charge covers per mesh.
 *
 * It has to be the first raster call in its process to see the minimum case
 * (`it is empty` below fails loudly if that ever stops being true), and every
 * file here is its own process under `scripts/run-tests.ts`.
 *
 * Mutations this file exists to catch: restoring the 4096-entry minimum, adding
 * doubling back to growth, and growing a resident list that is already large
 * enough. Any of them fails the exact-capacity assertion for the call it
 * changes; the `<= rotaryCandidateScratchBytes` assertions additionally pin the
 * bound the pool's `candidates` charge is computed from.
 *
 * Run with: npx tsx src/engine/toolpaths/rotaryScratchAllocation.test.ts
 */

import assert from 'node:assert/strict'

import {
  buildRotaryHeightMap,
  rotaryCandidateScratchBytes,
  rotaryCandidateScratchCapacityBytes,
} from './rotaryRaster'
import type { RotaryRasterFrame } from './rotaryRaster'

const CELL_SIZE = 0.1
const BBOX = { minX: 0, maxX: 1, minY: 0, maxY: 1 }
const ENTRY = Int32Array.BYTES_PER_ELEMENT

/**
 * A frame whose triangles are all clip candidates, so a call of any size really
 * collects them.
 *
 * Every triangle sits at axial coordinates 0.11-0.13. With cell centres at
 * 0.05, 0.15 the axis range is empty (first > last), which is the cheap
 * "covers no centre" test the centre pass makes *before* projecting anything;
 * the triangle is non-degenerate in the projection, so the clip pass afterwards
 * is ordinary work rather than a division by zero. The across/up corners stay
 * inside the 1 x 1 map.
 */
function scratchFrame(triangles: number): RotaryRasterFrame {
  const section = new Float64Array(triangles * 6)
  const along = new Float32Array(triangles * 3)
  for (let t = 0; t < triangles; t++) {
    const s = t * 6
    const l = t * 3
    section[s] = 0.4
    section[s + 1] = 0.4
    section[s + 2] = 0.6
    section[s + 3] = 0.4
    section[s + 4] = 0.5
    section[s + 5] = 0.6
    along[l] = 0.11
    along[l + 1] = 0.12
    along[l + 2] = 0.13
  }
  return { axis: 'x', centre: 0, pivot: 0, cos: 1, sin: 0, geometry: { section, along } }
}

/** Rasterise `triangles` all-candidate triangles and return the scratch's capacity afterwards. */
function raster(triangles: number): number {
  buildRotaryHeightMap(scratchFrame(triangles), BBOX, CELL_SIZE)
  return rotaryCandidateScratchCapacityBytes()
}

/**
 * The exact-capacity assertion. `submitted` is the list length the call hands
 * the kernel, which is what it allocates; `meshTriangles` is the same list's
 * mesh, whose duplicate-inclusive bound the pool charges.
 */
function assertCapacity(
  label: string,
  bytes: number,
  submitted: number,
  meshTriangles: number,
): void {
  assert.equal(bytes, submitted * ENTRY,
    `${label}: the scratch must hold exactly the ${submitted} submitted`
    + ` ${submitted === 1 ? 'entry' : 'entries'} (${submitted * ENTRY} bytes),`
    + ` not a rounded or doubled capacity (got ${bytes})`)
  assert.ok(bytes <= rotaryCandidateScratchBytes(meshTriangles),
    `${label}: the ${bytes} allocated bytes must fit the ${rotaryCandidateScratchBytes(meshTriangles)}-byte`
    + ' bound the pool\'s candidates charge is computed from')
}

// ── the minimum allocation: the submitted count, nothing rounded up ────────
{
  // The scratch is module state and this is the file's first raster call, so the
  // call below takes the branch where no array exists yet. If that ever stops
  // being true the test is measuring a different branch and must say so.
  assert.equal(rotaryCandidateScratchCapacityBytes(), 0,
    'this file must run before any other raster call in its process, or the minimum branch is untested')

  const one = raster(1)
  assertCapacity('one candidate', one, 1, 1)
  // The budget's bound for this mesh is 2 entries = 8 bytes. The original
  // allocator reserved 4096 entries (16,384 bytes) here: the review's probe.
  assert.equal(rotaryCandidateScratchBytes(1), 8, 'the one-triangle bound is 8 bytes')
  console.log(`scratch minimum: 1 submitted candidate allocates ${one} bytes`
    + ` (the pre-fix 4096-entry minimum was ${4096 * ENTRY}, bound ${rotaryCandidateScratchBytes(1)})`)
}

// ── growth is exact, not doubling ─────────────────────────────────────────
{
  // A much larger list must be allocated at its own size. 5000 is far above
  // twice the one-entry capacity the call above left, so a doubling allocator
  // also lands on 5000 entries here -- which isolates the growth case in the
  // next call from the minimum case above.
  const grown = raster(5000)
  assertCapacity('growth to a much larger list', grown, 5000, 5000)

  // One entry beyond the resident capacity. Doubling would reserve 10,000
  // entries -- 40,000 bytes -- for a 5001-entry list; exact allocation reserves
  // 20,004. This is the state where a worker would hold more than the charge.
  const next = raster(5001)
  assertCapacity('growth by one entry', next, 5001, 5001)
  assert.ok(next < 2 * grown,
    `growing 5000 -> 5001 entries must not double the list (${next} bytes against ${2 * grown})`)

  // A smaller list reuses what is resident: the capacity is the largest
  // submitted count seen, which is what the per-mesh charge has to cover.
  const reused = raster(3)
  assert.equal(reused, next,
    `a 3-entry list must reuse the ${next}-byte array rather than shrink it (got ${reused})`)
  assert.ok(reused <= rotaryCandidateScratchBytes(5001),
    'the resident capacity stays within the bound of the largest list submitted')
  console.log(`scratch growth: 5000 -> 5001 entries allocate ${next} bytes exactly`
    + ` (doubling would be ${2 * grown}; reuse after a 3-entry list keeps ${reused})`)
}

console.log('rotary scratch allocation: minimum, exact growth and reuse pinned')
