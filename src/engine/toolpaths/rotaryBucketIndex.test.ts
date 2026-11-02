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
 * The compact strip index (#1115 slice p-e): the bucket membership a CSR list
 * used to hold, stored as one bit per (bucket, triangle).
 *
 * Only the storage moved -- the arc a triangle scatters over and the two buckets
 * an angle reads are the same rule -- so the test has to prove that the *bits*
 * put every triangle in exactly the buckets the old list did, and that the gather
 * hands the raster exactly those triangles, in the same order. Three independent
 * checks:
 *
 *   - the structural invariants of an arc index: `always` and the buckets are
 *     disjoint, every triangle is somewhere, and each triangle's bucket set is
 *     one contiguous circular run (a wrong word or bit index scatters it);
 *   - an anchor in geometry: a triangle that contains the bar's axis reaches the
 *     strip at every turn and must be in `always`, never in a bucket;
 *   - a differential on the gather: for every direction, the subset
 *     `runRotaryAngleJob` hands the raster equals `always + bucket(psi) +
 *     bucket(psi + pi)`, decoded from the stored bits, with the entry after it
 *     untouched -- the same list, in the same order, as the CSR copy produced.
 *
 * Mutations this catches (each verified by hand, see the slice's report): reading
 * bit `t` as `t & 30` (pairs collide, the union loses triangles), `word << 4`
 * instead of `<< 5` (same), dropping the wrap arm of the scatter (the buckets
 * past 255 empty out), and reading the second bucket as `+ pi / 2` instead of
 * `+ pi` (the differential disagrees).
 */

import assert from 'node:assert/strict'

import { roundStock } from '../../types/project'
import { barCentre, barPivotZ } from '../../types/barStock'
import { createRotarySamplingPrep, runRotaryAngleJob } from './rotarySampling'
import type { RotarySamplingPrep } from './rotarySampling'
import type { NormalizedTool } from './types'

const tool: NormalizedTool = {
  id: 'ball', name: 'ball', sourceUnits: 'mm', units: 'mm', type: 'ball_endmill',
  diameter: 3, radius: 1.5, vBitAngle: null, flutes: 2, material: 'carbide',
  defaultRpm: 0, defaultFeed: 0, defaultPlungeFeed: 0, defaultStepdown: 1,
  defaultStepover: 0.5, maxCutDepth: 0,
}

const BUCKETS = 256
const TAU = Math.PI * 2
const SENTINEL = 0xffffffff

/** The bucket a direction falls in; the sampler's own rule, restated. */
function bucketOf(angle: number, width: number): number {
  let value = angle % TAU
  if (value < 0) value += TAU
  return Math.floor(value / width) % BUCKETS
}

/**
 * A mesh with triangles at every distance from the bar's axis: one that contains
 * the axis (it must land in `always`), broad ones whose arcs wrap past 360, small
 * ones far out (narrow arcs), and one on the axis itself.
 */
function buildMesh(axis: 'x' | 'y'): { positions: Float32Array; index: Uint32Array; stock: ReturnType<typeof roundStock> } {
  const stock = roundStock(20, 40, axis, { x: -3, y: 7 })
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const coordinates: number[] = []
  const indices: number[] = []
  const add = (along: number, across: number, up: number): void => {
    coordinates.push(...(axis === 'x' ? [along, centre + across, pivot + up] : [centre + across, along, pivot + up]))
    indices.push(indices.length)
  }
  // Contains the bar's axis in its cross-section: reaches the strip at every turn.
  add(4, -1, -1)
  add(6, 1, -1)
  add(5, 0, 1)
  // Broad triangles whose arcs run past 360 degrees and wrap the bucket list.
  for (let t = 0; t < 40; t++) {
    const along = t * 0.4
    add(along, -6, 0)
    add(along + 0.9, 6, 0)
    add(along + 0.3, 0, 0.4)
  }
  // A triangle whose cross-section cone straddles the A0 seam: its buckets are
  // the high ones and the low ones, which is what a scatter that forgets the
  // wrap arm loses.
  const seam = 6
  add(9, Math.cos(-0.2) * seam, Math.sin(-0.2) * seam)
  add(10, seam, 0)
  add(11, Math.cos(0.2) * seam, Math.sin(0.2) * seam)
  // Small triangles far from the axis, with narrow arcs in every direction.
  for (let t = 0; t < 240; t++) {
    const along = (t % 60) * 0.25
    const distance = 4 + (t % 7)
    const direction = (t / 240) * TAU
    const across = Math.cos(direction) * distance
    const up = Math.sin(direction) * distance
    add(along, across - 0.1, up - 0.1)
    add(along + 0.05, across + 0.1, up - 0.1)
    add(along + 0.02, across, up + 0.1)
  }
  return { positions: new Float32Array(coordinates), index: new Uint32Array(indices), stock }
}

/** Every triangle a bucket holds, ascending. */
function bucketMembers(plan: { bucketBits: Uint32Array; bucketWords: number }, bucket: number): number[] {
  const members: number[] = []
  if (plan.bucketWords === 0) return members
  const base = bucket * plan.bucketWords
  for (let word = 0; word < plan.bucketWords; word++) {
    let bits = plan.bucketBits[base + word]
    while (bits !== 0) {
      const lowest = bits & -bits
      members.push((word << 5) + 31 - Math.clz32(lowest))
      bits ^= lowest
    }
  }
  return members
}

function setUp(axis: 'x' | 'y'): {
  prep: RotarySamplingPrep
  angles: number[]
  triangles: number
  positions: Float32Array
  index: Uint32Array
  centre: number
  pivot: number
} {
  const { positions, index, stock } = buildMesh(axis)
  const prep = createRotarySamplingPrep({ positions, index }, stock, tool, {
    along: [0, 2, 4, 6, 8, 10, 12, 14],
    requestedCellSize: 0.35,
    conservativeCellBounds: true,
  })
  const angles = Array.from({ length: 61 }, (_, k) => k * 6)
  return {
    prep, angles, triangles: Math.floor(index.length / 3),
    positions, index, centre: barCentre(stock), pivot: barPivotZ(stock),
  }
}

/**
 * The directions a triangle's own cross-section **subtends** from the bar's axis,
 * as one circular interval -- `[lo, length]`, `length` in radians (issue: the
 * sampler's arc is this cone plus the `reach` band, so every bucket strictly
 * inside the cone must be a member whatever the reach is). Independent of the
 * sampler: vertices' `atan2`, the complement of their largest gap.
 */
function subtendedCone(angles: readonly number[]): { lo: number; length: number } | null {
  const sorted = [...angles].sort((a, b) => a - b)
  let maxGap = sorted[0] + TAU - sorted[sorted.length - 1]
  let lo = sorted[0]
  for (let k = 0; k + 1 < sorted.length; k++) {
    const gap = sorted[k + 1] - sorted[k]
    if (gap > maxGap) {
      maxGap = gap
      lo = sorted[k + 1]
    }
  }
  if (maxGap < Math.PI) return null
  return { lo, length: TAU - maxGap }
}

for (const axis of ['x', 'y'] as const) {
  const { prep, angles, triangles, positions, index, centre, pivot } = setUp(axis)
  const plan = prep.planFor(angles)
  const alwaysTriangles = plan.always.map((offset) => offset / 3)
  const alwaysSet = new Set(alwaysTriangles)

  // Anchored in geometry: the triangle around the axis is in `always` and in no
  // bucket, and every triangle is in `always` or in at least one bucket.
  assert.ok(alwaysSet.has(0), `${axis}: the triangle containing the axis must reach the strip at every turn`)
  const seen = new Uint8Array(triangles)
  for (const t of alwaysTriangles) seen[t] = 1
  const bucketSets: number[][] = []
  for (let bucket = 0; bucket < BUCKETS; bucket++) {
    const members = bucketMembers(plan, bucket)
    bucketSets.push(members)
    for (const t of members) {
      assert.ok(t >= 0 && t < triangles, `${axis}: bucket ${bucket} names triangle ${t} of ${triangles}`)
      assert.ok(!alwaysSet.has(t), `${axis}: triangle ${t} is in always and in bucket ${bucket}`)
      seen[t]++
    }
  }
  for (let t = 0; t < triangles; t++) {
    assert.ok(seen[t] > 0, `${axis}: triangle ${t} is in no bucket and not always: the index drops it from every angle`)
  }
  // An arc index scatters each triangle over one contiguous circular run, so a
  // member list read through the wrong word or bit index shows up here.
  for (let t = 0; t < triangles; t++) {
    if (alwaysSet.has(t)) continue
    const runs = bucketSets.filter((members) => members.includes(t)).length
    const covered = bucketSets
      .map((members, bucket) => (members.includes(t) ? bucket : -1))
      .filter((bucket) => bucket >= 0)
    assert.equal(covered.length, runs)
    let breaks = 0
    for (let k = 0; k < covered.length; k++) {
      const next = covered[(k + 1) % covered.length]
      const gap = (next - covered[k] + BUCKETS) % BUCKETS
      if (gap !== 1) breaks++
    }
    assert.equal(breaks, 1, `${axis}: triangle ${t} is listed in a non-contiguous set of buckets (${covered.length} of them)`)
  }

  // Every bucket strictly inside a triangle's own subtended cone must hold it.
  // The sampler's arc is that cone widened by the strip's reach, so this is a
  // reach-free lower bound -- and the only check that can see a scatter dropping
  // the wrapping part of an arc, since the remainder is still contiguous.
  const acrossOffset = axis === 'x' ? 1 : 0
  let coneChecks = 0
  for (let t = 0; t < triangles; t++) {
    if (alwaysSet.has(t)) continue
    const corners: number[] = []
    for (let j = 0; j < 3; j++) {
      const vertex = index[t * 3 + j] * 3
      const across = positions[vertex + acrossOffset] - centre
      const up = positions[vertex + 2] - pivot
      corners.push(Math.atan2(up, across))
    }
    const cone = subtendedCone(corners)
    if (cone === null) continue
    for (let bucket = 0; bucket < BUCKETS; bucket++) {
      const direction = (bucket + 0.5) * plan.bucketWidth
      const offset = ((direction - cone.lo) % TAU + TAU) % TAU
      // Only buckets clear of the cone's own boundary: on it, the two atan2
      // computations may round to opposite sides, and the bucket after it is the
      // arbitrary one.
      if (offset < 0.02 * plan.bucketWidth || offset > cone.length - 0.02 * plan.bucketWidth) continue
      coneChecks++
      assert.ok(bucketSets[bucket].includes(t),
        `${axis}: triangle ${t} subtends bucket ${bucket} but is not listed there (arc scatter lost it)`)
    }
  }
  assert.ok(coneChecks > 0, `${axis}: the fixture must exercise the cone lower bound`)

  // The gather: for every direction, exactly `always + bucket(psi) + bucket(psi + pi)`,
  // in ascending triangle order within each list, and nothing written past it.
  const subset = prep.workspace.subset!
  for (const angle of angles) {
    const t = (angle * Math.PI) / 180
    const first = bucketOf(Math.PI / 2 - t, plan.bucketWidth)
    const second = bucketOf(Math.PI / 2 - t + Math.PI, plan.bucketWidth)
    const expected = [
      ...alwaysTriangles.map((triangle) => triangle * 3),
      ...bucketSets[first].map((triangle) => triangle * 3),
      ...bucketSets[second].map((triangle) => triangle * 3),
    ]
    subset.fill(SENTINEL)
    runRotaryAngleJob(prep, plan, { index: 0, angle })
    for (let i = 0; i < expected.length; i++) {
      assert.equal(subset[i], expected[i], `${axis} at ${angle} deg: subset entry ${i} is not the ${first}/${second}-bucket list`)
    }
    assert.equal(subset[expected.length], SENTINEL,
      `${axis} at ${angle} deg: the gather wrote ${expected.length}+ entries; the raster would read triangles the buckets do not hold`)
  }
  console.log(`rotary bucket index (${axis}): ${triangles} triangles, always ${alwaysTriangles.length}, gather matches the stored bits at ${angles.length} angles`)
}

console.log('rotaryBucketIndex.test.ts: all assertions passed')
