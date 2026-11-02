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
 * hands the raster exactly those triangles, in the same order. Four independent
 * checks:
 *
 *   - **the old structure as an oracle** (`referenceIndex`): the CSR index is
 *     rebuilt from the mesh -- arc, `reach` band, one bucket of padding either
 *     side, contiguous run -- without reading a single bit of `plan.bucketBits`,
 *     and every bucket's *membership* and every triangle's padded *bounds* must
 *     match it exactly. Without this the test only compares the new storage with
 *     itself: dropping the leading bucket of padding still produced a
 *     contiguous, fully-covered index and passed every other assertion;
 *   - the structural invariants of an arc index: `always` and the buckets are
 *     disjoint, every triangle is somewhere, and each triangle's bucket set is
 *     one contiguous circular run (a wrong word or bit index scatters it);
 *   - an anchor in geometry: a triangle that contains the bar's axis reaches the
 *     strip at every turn and must be in `always`, never in a bucket;
 *   - a differential on the gather: for every direction, the subset
 *     `runRotaryAngleJob` hands the raster equals `always + bucket(psi) +
 *     bucket(psi + pi)` -- taken from the CSR oracle, not from the bits, so the
 *     order and the membership both come from outside the new structure -- with
 *     the entry after it untouched.
 *
 * Mutations this catches (each verified by hand, see the slice's report): reading
 * bit `t` as `t & 30` (pairs collide, the union loses triangles), `word << 4`
 * instead of `<< 5` (same), dropping the wrap arm of the scatter (the buckets
 * past 255 empty out), reading the second bucket as `+ pi / 2` instead of
 * `+ pi` (the differential disagrees), and dropping the leading bucket of
 * padding or the trailing one (`paddedFirst = first` / `paddedLast = last`: the
 * oracle's membership and padded bounds disagree).
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

/**
 * The index the compact form replaced, rebuilt from the mesh alone.
 *
 * This is the **oracle** for `rotaryBucketIndex.test.ts`: membership and bounds
 * come from the mesh, the strip's `reach` and the rule the CSR index applied --
 * the arc of turn directions a triangle can reach, one bucket of slack either
 * side of it, and one contiguous run of listings per triangle -- and never from
 * `plan.bucketBits`. That independence is the whole point: an assertion whose
 * expected side is decoded from the bits proves only that the bits agree with
 * themselves, and the read-back of a rounding bug passes it.
 */
interface CsrReference {
  /** Triangle indices (not vertex offsets), ascending. */
  readonly always: number[]
  /** `buckets[k]`: the triangles listed in bucket `k`, ascending. */
  readonly buckets: number[][]
  /** The CSR offsets: bucket `k` holds entries `starts[k] .. starts[k + 1] - 1`. */
  readonly starts: Int32Array
  /** Per triangle: the padded bucket run it is listed in, or `null` for `always`. */
  readonly bounds: Array<{ first: number; last: number } | null>
}

/** Distance from the cross-section origin to the segment `a`-`b`. */
function segmentDistance(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const lengthSq = dx * dx + dy * dy
  let t = lengthSq > 0 ? -(ax * dx + ay * dy) / lengthSq : 0
  if (t < 0) t = 0
  else if (t > 1) t = 1
  const px = ax + dx * t
  const py = ay + dy * t
  return Math.sqrt(px * px + py * py)
}

/**
 * The pre-p-e `stripArc`, restated: the circular interval of turn directions
 * over which the triangle can reach a strip of half-width `reach`, or `null` when
 * it reaches the strip at every turn (it contains the axis, or the interval
 * covers the circle). Same arithmetic, including the `1e-9` radian of slack the
 * bucket padding used to absorb.
 */
function referenceArc(
  a0: number, b0: number,
  a1: number, b1: number,
  a2: number, b2: number,
  reach: number,
): { lo: number; length: number } | null {
  // Edge functions of the origin: three of one sign means the origin is inside
  // the triangle (barycentric coordinates of one sign), which reaches the strip
  // at every turn.
  const e0 = (a1 - a0) * -b0 - (b1 - b0) * -a0
  const e1 = (a2 - a1) * -b1 - (b2 - b1) * -a1
  const e2 = (a0 - a2) * -b2 - (b0 - b2) * -a2
  if (!((e0 < 0 || e1 < 0 || e2 < 0) && (e0 > 0 || e1 > 0 || e2 > 0))) return null
  const distance = Math.min(
    segmentDistance(a0, b0, a1, b1),
    segmentDistance(a1, b1, a2, b2),
    segmentDistance(a2, b2, a0, b0),
  )
  if (!(distance > reach)) return null
  const delta = Math.asin(Math.min(1, reach / distance)) + 1e-9
  const directions = [Math.atan2(b0, a0), Math.atan2(b1, a1), Math.atan2(b2, a2)].sort((x, y) => x - y)
  const g0 = directions[1] - directions[0]
  const g1 = directions[2] - directions[1]
  const g2 = directions[0] + TAU - directions[2]
  let maxGap = g0
  let lo = directions[1]
  if (g1 > maxGap) { maxGap = g1; lo = directions[2] }
  if (g2 > maxGap) { maxGap = g2; lo = directions[0] }
  if (maxGap < Math.PI) return null
  const length = TAU - maxGap + 2 * delta
  if (!(length < TAU)) return null
  return { lo: lo - delta, length }
}

/**
 * Build the CSR index for one mesh and strip reach, exactly as the old storage
 * held it: `always` for the triangles that reach every direction, and one
 * contiguous padded run of bucket listings for the rest.
 */
function referenceIndex(input: {
  positions: Float32Array
  index: Uint32Array
  triangles: number
  acrossOffset: number
  centre: number
  pivot: number
  reach: number
  bucketWidth: number
}): CsrReference {
  const { positions, index, triangles, acrossOffset, centre, pivot, reach, bucketWidth } = input
  const vertices = Math.floor(positions.length / 3)
  const across = new Float64Array(vertices)
  const up = new Float64Array(vertices)
  for (let v = 0; v < vertices; v++) {
    across[v] = positions[v * 3 + acrossOffset] - centre
    up[v] = positions[v * 3 + 2] - pivot
  }
  const always: number[] = []
  const bounds: Array<{ first: number; last: number } | null> = new Array(triangles).fill(null)
  const counts = new Int32Array(BUCKETS)
  for (let t = 0; t < triangles; t++) {
    const v0 = index[t * 3]
    const v1 = index[t * 3 + 1]
    const v2 = index[t * 3 + 2]
    const arc = referenceArc(across[v0], up[v0], across[v1], up[v1], across[v2], up[v2], reach)
    if (arc === null) {
      always.push(t)
      continue
    }
    const first = bucketOf(arc.lo, bucketWidth)
    const last = bucketOf(arc.lo + arc.length, bucketWidth)
    // One bucket of slack each side, and an arc that covers the whole circle in
    // the padded form is `always` rather than a run that starts and ends at the
    // same bucket.
    const paddedFirst = (first + BUCKETS - 1) % BUCKETS
    const paddedLast = (last + 1) % BUCKETS
    if (((paddedLast - paddedFirst + BUCKETS) % BUCKETS) + 1 >= BUCKETS) {
      always.push(t)
      continue
    }
    bounds[t] = { first: paddedFirst, last: paddedLast }
    for (let bucket = paddedFirst; ; bucket = (bucket + 1) % BUCKETS) {
      counts[bucket] += 1
      if (bucket === paddedLast) break
    }
  }
  const starts = new Int32Array(BUCKETS + 1)
  for (let bucket = 0; bucket < BUCKETS; bucket++) starts[bucket + 1] = starts[bucket] + counts[bucket]
  const entries = new Int32Array(starts[BUCKETS])
  const fill = Int32Array.from(starts.subarray(0, BUCKETS))
  for (let t = 0; t < triangles; t++) {
    const run = bounds[t]
    if (run === null) continue
    for (let bucket = run.first; ; bucket = (bucket + 1) % BUCKETS) {
      entries[fill[bucket]++] = t
      if (bucket === run.last) break
    }
  }
  const buckets: number[][] = []
  for (let bucket = 0; bucket < BUCKETS; bucket++) {
    buckets.push(Array.from(entries.subarray(starts[bucket], starts[bucket + 1])))
  }
  return { always, buckets, starts, bounds }
}

for (const axis of ['x', 'y'] as const) {
  const { prep, angles, triangles, positions, index, centre, pivot } = setUp(axis)
  const plan = prep.planFor(angles)
  const alwaysTriangles = plan.always.map((offset) => offset / 3)
  const alwaysSet = new Set(alwaysTriangles)

  // The oracle: the CSR index the compact storage replaced, rebuilt from the mesh
  // and the strip's reach. Its `reach` is the widest strip this operation reads,
  // which is the only input the sampler has that the mesh does not.
  const reach = prep.workspace.reach
  assert.ok(typeof reach === 'number' && Number.isFinite(reach) && reach > 0,
    `${axis}: the fixture must build a finite strip reach (got ${reach})`)
  const reference = referenceIndex({
    positions,
    index,
    triangles,
    acrossOffset: axis === 'x' ? 1 : 0,
    centre,
    pivot,
    reach,
    bucketWidth: plan.bucketWidth,
  })
  assert.ok(reference.always.length > 0 && reference.always.length < triangles,
    `${axis}: the fixture must put some triangles in always and some in buckets`)
  assert.deepEqual(Array.from(alwaysTriangles), reference.always,
    `${axis}: the \`always\` list is not the one the CSR index held`)
  console.log(`rotary bucket oracle (${axis}): ${triangles} triangles, ${reference.always.length} always,`
    + ` ${reference.starts[BUCKETS]} CSR listings, reach ${reach.toFixed(3)}`)

  // Anchored in geometry: the triangle around the axis is in `always` and in no
  // bucket, and every triangle is in `always` or in at least one bucket.
  assert.ok(alwaysSet.has(0), `${axis}: the triangle containing the axis must reach the strip at every turn`)
  const seen = new Uint8Array(triangles)
  for (const t of alwaysTriangles) seen[t] = 1
  const bucketSets: number[][] = []
  for (let bucket = 0; bucket < BUCKETS; bucket++) {
    const members = bucketMembers(plan, bucket)
    bucketSets.push(members)
    // The exact membership the CSR list held, in the same ascending order.
    assert.deepEqual(members, reference.buckets[bucket],
      `${axis}: bucket ${bucket} holds ${members.length} triangles, the CSR index held ${reference.buckets[bucket].length}`)
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
  // member list read through the wrong word or bit index shows up here -- and the
  // run's two ends are the padded bounds the CSR index gave the triangle, which is
  // what a dropped leading or trailing bucket of slack changes.
  for (let t = 0; t < triangles; t++) {
    const run = reference.bounds[t]
    const covered = bucketSets
      .map((members, bucket) => (members.includes(t) ? bucket : -1))
      .filter((bucket) => bucket >= 0)
    if (run === null) {
      assert.ok(alwaysSet.has(t), `${axis}: triangle ${t} is in buckets but the CSR index put it in always`)
      continue
    }
    assert.ok(!alwaysSet.has(t), `${axis}: triangle ${t} is in always but the CSR index listed it in buckets`)
    const expected: number[] = []
    for (let bucket = run.first; ; bucket = (bucket + 1) % BUCKETS) {
      expected.push(bucket)
      if (bucket === run.last) break
    }
    expected.sort((a, b) => a - b)
    assert.deepEqual(covered, expected,
      `${axis}: triangle ${t} is listed in [${covered.join(', ')}], the CSR index listed it in`
      + ` the padded run [${expected.join(', ')}] (${run.first}..${run.last})`)
    // Contiguity follows from the run, but a scatter that wraps wrongly can still
    // produce the right *set* in the wrong order -- the gather check below reads
    // the order, this one the run.
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
  // in ascending triangle order within each list, and nothing written past it. The
  // expected list comes from the CSR oracle, so both its membership and its order
  // are independent of the bits the gather reads.
  const subset = prep.workspace.subset!
  for (const angle of angles) {
    const t = (angle * Math.PI) / 180
    const first = bucketOf(Math.PI / 2 - t, plan.bucketWidth)
    const second = bucketOf(Math.PI / 2 - t + Math.PI, plan.bucketWidth)
    const expected = [
      ...reference.always.map((triangle) => triangle * 3),
      ...reference.buckets[first].map((triangle) => triangle * 3),
      ...reference.buckets[second].map((triangle) => triangle * 3),
    ]
    subset.fill(SENTINEL)
    runRotaryAngleJob(prep, plan, { index: 0, angle })
    for (let i = 0; i < expected.length; i++) {
      assert.equal(subset[i], expected[i], `${axis} at ${angle} deg: subset entry ${i} is not the ${first}/${second}-bucket list`)
    }
    assert.equal(subset[expected.length], SENTINEL,
      `${axis} at ${angle} deg: the gather wrote ${expected.length}+ entries; the raster would read triangles the buckets do not hold`)
  }
  console.log(`rotary bucket index (${axis}): ${triangles} triangles, always ${alwaysTriangles.length},`
    + ` membership and padded bounds match the CSR oracle, gather matches it at ${angles.length} angles`)
}

console.log('rotaryBucketIndex.test.ts: all assertions passed')
