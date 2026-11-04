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
 * #1103 slice ca-e, review P1: the helix reuses the ring grid's height maps.
 *
 * The around grid samples the same physical angles the continuous helix will
 * ask for -- the helix's phase grid is the ring grid's angle grid, and its
 * first refinement round is the ring refinement's midpoint grid. The map for a
 * physical angle depends only on the angle (the mesh, tool and cell size are
 * fixed for the operation), so a row at that angle only needs its own along
 * reads. Before this change the helix rasterised a second full map set, which
 * is what made generation 2.0-3.0x the baseline on round-bar around work.
 *
 * The cache is opt-in through the prep (`angleMaps`), writes are copy-only, and
 * the base grid never reads one back, so every existing row and the ring
 * output stay exactly what they were; block 3 is that byte-identity control.
 *
 * Mutations these blocks catch:
 *  - making the helix's row prep `write` instead of `read-write`: block 1's
 *    `reusedRows` becomes 0;
 *  - reading the cache in the base prep: block 2's `reused` is no longer 0;
 *  - dropping the per-map size gate: block 4's big-cell map is stored and
 *    reused;
 *  - returning a cropped map with the uncropped origin or size: block 1's
 *    points no longer equal the independent grid's;
 *  - charging raster work for a reused row: block 1's workspace reclaims almost
 *    all of the control's raster work, and this asserts the difference.
 */

import assert from 'node:assert/strict'
import { barPivotZ } from '../../types/barStock'
import { roundStock } from '../../types/project'
import type { BarStock } from '../../types/project'
import { buildContinuousHelix } from './rotaryContinuous'
import type { ContinuousHelix } from './rotaryContinuous'
import { createRotarySamplingPrep, refineAroundSampling, sampleAnglesWithPrep } from './rotarySampling'
import type { RotaryModelMesh, RotarySamplingPrep, RotarySamplingWorkspace } from './rotarySampling'
import type { NormalizedTool } from './types'

const TOOL: NormalizedTool = {
  id: 't1', name: 't1', sourceUnits: 'mm', units: 'mm', type: 'ball_endmill',
  diameter: 2, radius: 1, vBitAngle: null, flutes: 2, material: 'carbide',
  defaultRpm: 0, defaultFeed: 0, defaultPlungeFeed: 0, defaultStepdown: 0,
  defaultStepover: 0, maxCutDepth: 0,
}

/** A turned cylinder of `radius` from `from` to `to`, 64 facets. */
function lathe(stock: BarStock, radius: number, from: number, to: number): RotaryModelMesh {
  const centre = stock.thickness / 2
  const pivot = barPivotZ(stock)
  const positions: number[] = []
  const index: number[] = []
  for (const along of [from, to]) {
    for (let j = 0; j < 64; j++) {
      const t = 2 * Math.PI * j / 64
      positions.push(along, centre + radius * Math.cos(t), pivot + radius * Math.sin(t))
    }
  }
  for (let j = 0; j < 64; j++) {
    const next = (j + 1) % 64
    index.push(j, next, 64 + next, j, 64 + next, 64 + j)
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

const STOCK = roundStock(20, 40, 'x')
const MESH = lathe(STOCK, 6, 12, 28)
const BAND = { start: 12, end: 28 }
const STEPOVER = 2
const SAMPLE_SPACING = 1
const CELL = 0.1

/** The ring grid's angle list, built the way `aroundGrid` builds it. */
function ringAngles(sampleSpacing: number): number[] {
  const radius = STOCK.thickness / 2
  const tolerance = 0.005
  const cap = Math.sqrt(8 * radius * tolerance)
  const step = Math.min(sampleSpacing, cap)
  const intervals = Math.ceil((2 * Math.PI * radius) / Math.max(step, 1e-9))
  return Array.from({ length: intervals + 1 }, (_, k) => 360 * k / intervals)
}

function prepFor(
  workspace: RotarySamplingWorkspace,
  mode: 'off' | 'write' | 'read-write',
  along: readonly number[],
  requestedCellSize = CELL,
): RotarySamplingPrep {
  return createRotarySamplingPrep(MESH, STOCK, TOOL, {
    along,
    requestedCellSize,
    conservativeCellBounds: true,
    angleMaps: mode,
    workspace,
  })
}

/**
 * The generator's own first pass: the ring grid, then its refinement rounds.
 * Both write their maps to the shared workspace, exactly as `rotaryTargets`
 * leaves it before the emission loop builds a helix.
 */
function sampleRingGrid(prep: RotarySamplingPrep, angles: readonly number[]): void {
  const sampled = sampleAnglesWithPrep(prep, angles, [])
  assert.ok(sampled.valid, 'the ring grid samples')
  const refined = refineAroundSampling({
    prep,
    stock: STOCK,
    tool: TOOL,
    warnings: [],
    angles: sampled.anglesDeg,
    tips: sampled.tipRadius,
  })
  assert.ok(refined !== null, 'the ring refinement samples')
}

function helixFor(prep: RotarySamplingPrep): ContinuousHelix | null {
  return buildContinuousHelix({
    prep,
    tool: TOOL,
    band: BAND,
    stepover: STEPOVER,
    sampleSpacing: SAMPLE_SPACING,
    stockToLeave: 0,
    warnings: [],
  })
}

function assertHelixNear(a: ContinuousHelix, b: ContinuousHelix, label: string): void {
  assert.equal(a.points.length, b.points.length, `${label}: same point count`)
  for (let i = 0; i < a.points.length; i++) {
    for (const axis of ['x', 'y', 'z', 'a'] as const) {
      const left = a.points[i][axis] ?? 0
      const right = b.points[i][axis] ?? 0
      const scale = Math.max(1, Math.abs(left), Math.abs(right))
      assert.ok(Math.abs(left - right) <= 1e-9 * scale,
        `${label}: point ${i} ${axis} ${left} versus ${right}`)
    }
  }
}

// ── block 1: a helix reads the ring grid's maps ────────────────────────────
// The ring grid samples the operation's angles first, exactly as the generator
// does. The helix that follows must be served from those maps: every one of its
// rows is a read, not a raster.
{
  const workspace = {}
  const along = Array.from({ length: 9 }, (_, i) => BAND.start + (BAND.end - BAND.start) * i / 8)
  const base = prepFor(workspace, 'write', along)
  sampleRingGrid(base, ringAngles(SAMPLE_SPACING))

  const cached = helixFor(base)
  assert.ok(cached !== null, 'the band is helix-applicable')
  assert.ok(cached.rows > 100, `the helix has rows to account for (${cached.rows})`)
  assert.ok(cached.reusedRows >= cached.rows - 1,
    `every helix row is read from the ring grid's maps (${cached.reusedRows} of ${cached.rows})`)

  // The independent control: a fresh workspace builds every map itself.
  const uncached = helixFor(prepFor({}, 'off', along))
  assert.ok(uncached !== null, 'the control band is helix-applicable')
  assert.equal(uncached.reusedRows, 0, 'the control workspace reuses nothing')
  assertHelixNear(cached, uncached, 'cached versus independent sampling')
  // #1103 ca-e correction round 2: a reused row costs no raster work. The work
  // figure is what the attempt's budget is charged in, so a row that only reads
  // its map must add 0 -- otherwise a reuse would not buy the time it exists for.
  assert.ok(uncached.rasterWork > 0,
    `the control reports the raster work it spent (${uncached.rasterWork})`)
  assert.ok(cached.rasterWork * 10 < uncached.rasterWork,
    `reuse removes almost all of the control's raster work `
    + `(${cached.rasterWork} versus ${uncached.rasterWork})`)
  console.log(`  helix map reuse: ${cached.reusedRows}/${cached.rows} rows reused, `
    + `${cached.rasterWork} versus ${uncached.rasterWork} triangle raster passes, path identical`)
}

// ── block 2: the base grid never reads the cache back ──────────────────────
// The ring grid must stay a write-only client: A0 and A360 are the same key,
// and a read there would replace one of its two rows with the other, which is
// exactly the byte-identity contract ca-e holds for paths it does not change.
// The write pass is what the generator installs, so this asserts the delivered
// configuration, not an unused option.
{
  const workspace = {}
  const along = Array.from({ length: 9 }, (_, i) => BAND.start + (BAND.end - BAND.start) * i / 8)
  const angles = ringAngles(SAMPLE_SPACING)
  const write = prepFor(workspace, 'write', along)
  const sampled = sampleAnglesWithPrep(write, angles, [])
  assert.ok(sampled.valid, 'the write-mode grid samples')
  assert.equal(sampled.reused, 0, 'the base grid reads no cached map')
  // The rows it wrote are there for the helix: the next prep at the same angles
  // hits them, proving the write pass is what the reuse depends on.
  const reread = sampleAnglesWithPrep(prepFor(workspace, 'read-write', along), angles, [])
  assert.ok(reread.reused >= angles.length - 1,
    `a read-write batch hits the written maps (${reread.reused} of ${angles.length})`)
  console.log(`  base grid write-only: ${sampled.tipRadius.length} rows written, ${reread.reused} reused`)
}

// ── block 3: the base grid's rows are unchanged by the cache ───────────────
// Byte identity is the ca-e contract for paths this slice does not change: the
// ring samples on a write-mode workspace must equal the ones on a plain one.
{
  const along = Array.from({ length: 9 }, (_, i) => BAND.start + (BAND.end - BAND.start) * i / 8)
  const angles = ringAngles(SAMPLE_SPACING)
  const plain = sampleAnglesWithPrep(prepFor({}, 'off', along), angles, [])
  const writing = sampleAnglesWithPrep(prepFor({}, 'write', along), angles, [])
  assert.equal(writing.reused, 0, 'write mode never reads')
  assert.deepEqual(writing.anglesDeg, plain.anglesDeg, 'the same angles')
  assert.equal(writing.tipRadius.length, plain.tipRadius.length, 'the same row count')
  for (let k = 0; k < plain.tipRadius.length; k++) {
    assert.deepEqual(Array.from(writing.tipRadius[k]), Array.from(plain.tipRadius[k]),
      `row ${k} is bit-identical with the cache writing`)
  }
  console.log(`  base rows: ${plain.tipRadius.length} rows bit-identical with the cache on`)
}

// ── block 4: a map too large to keep is not cached ─────────────────────────
// The cache copies the window the sampler reads. A fine cell makes that copy
// cost about what a rebuild does, so the gate refuses it and the helix keeps
// building its own maps rather than trading memory for nothing.
{
  const workspace = {}
  const along = Array.from({ length: 9 }, (_, i) => BAND.start + (BAND.end - BAND.start) * i / 8)
  const fine = 0.02
  const fineAngles = ringAngles(SAMPLE_SPACING)
  const base = prepFor(workspace, 'write', along, fine)
  sampleAnglesWithPrep(base, fineAngles, [])
  const helix = helixFor(base)
  assert.ok(helix !== null, 'the fine-cell band is helix-applicable')
  assert.equal(helix.reusedRows, 0, 'an oversized map is neither stored nor reused')
  console.log('  oversized map: not cached')
}

console.log('engine/toolpaths/rotaryHelixMapReuse.test.ts: all assertions passed')
