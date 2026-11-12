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
 * #1185 slice R3: the around refinement bisects a segment only on the rings
 * that need it.
 *
 * A segment of the angle grid fails where some ring's chord dips too far below
 * the model, usually on one to five rings of dozens. The refinement used to
 * sample the midpoint for every ring, insert it for every ring, and test both
 * halves for every ring again. Now a ring that had its midpoint compared with
 * its chord and passed keeps that chord: the inserted row gives it the chord's
 * own midpoint, and it is neither sampled nor tested inside that segment again.
 * Only the rings still being refined are sampled -- an exact row at those
 * positions alone, a height-map row over the stretch of the bar they read.
 *
 * Mutations these blocks catch (each was applied and seen to fail): settling a
 * ring that failed, one that passed only on the sharp-corner bound, or one with
 * no model at an end; giving a settled ring the sampled value, or an end's
 * value, instead of its chord's midpoint; handing the halves every ring; a row
 * in part between rows under the cap, or with no lifts given; a stretch one
 * reach too short; a row in part stored or handed back as the angle's map; the
 * exact read's stretch without the cutter radius; a row in part keeping its
 * stretch's own rise, or sampled on a reduced map; the async driver dropping
 * the positions; and testing a settled ring again.
 *
 * Block 1 is the row itself: a row sampled at a few positions holds exactly the
 * values the whole row holds there. Block 2 is the guarantee, checked from a log
 * of every job the refinement ran: every chord a ring ends up with had its
 * midpoint sampled for that ring and passed the comparison (or sweeps an arc
 * within the floor), its settled points lie on that chord, and every point it
 * was refined at is the whole row's value. Block 3 is when a height-map row may
 * be sampled in part at all.
 */

import assert from 'node:assert/strict'
import { barCentre, barPivotZ } from '../../types/barStock'
import { roundStock } from '../../types/project'
import type { BarStock } from '../../types/project'
import {
  AROUND_ANGLE_TOLERANCE_MM,
  createRotarySamplingPrep,
  refineAroundSamplingAsync,
  runRotaryAngleJob,
  sampleAnglesWithPrep,
  serialRotaryBatches,
} from './rotarySampling'
import type { RotaryAngleJob, RotaryAngleSample, RotaryModelMesh, RotarySamplingPrep, RotarySamplingWorkspace } from './rotarySampling'
import type { NormalizedTool } from './types'

const FLOOR = AROUND_ANGLE_TOLERANCE_MM
const CELL = 0.2

function toolOf(type: 'ball_endmill' | 'flat_endmill', radius: number): NormalizedTool {
  return {
    id: 't1', name: 't1', sourceUnits: 'mm', units: 'mm', type,
    diameter: radius * 2, radius, vBitAngle: null, flutes: 2, material: 'carbide',
    defaultRpm: 0, defaultFeed: 0, defaultPlungeFeed: 0, defaultStepdown: 0,
    defaultStepover: 0, maxCutDepth: 0,
  }
}

/**
 * A lumpy, twisted tube from 12 to 30 whose section changes along the bar, with
 * a tongue over part of the turn from 9 to 12: a ring over the tongue has the
 * model under the cutter at some angles and nothing at others.
 *
 * `ridges` puts a ridge on every other ring of facets -- everywhere, on the far
 * half of the bar only, or nowhere. A ridge is steep enough to take a strip's
 * cell rise to its cap, which is what lets a height-map row be sampled in part.
 */
function body(stock: BarStock, ridges: 'all' | 'far half' | 'none'): RotaryModelMesh {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const sides = 72
  const rings = 43
  const positions: number[] = []
  const index: number[] = []
  for (let r = 0; r < rings; r++) {
    const along = 9 + 21 * r / (rings - 1)
    const u = Math.max(0, (along - 12) / 18)
    const ridged = ridges === 'all' || (ridges === 'far half' && along > 21)
    for (let j = 0; j < sides; j++) {
      const t = 2 * Math.PI * j / sides
      const radius = 6 + 1.2 * Math.cos(3 * t + 5 * u) * (0.3 + u) + 0.5 * Math.sin(9 * t) * (1 - u)
        + (ridged ? 0.5 * Math.cos(Math.PI * r) : 0)
      const across = centre + radius * Math.cos(t)
      const up = pivot + radius * Math.sin(t)
      if (stock.axis === 'x') positions.push(along, across, up)
      else positions.push(across, along, up)
    }
  }
  for (let r = 0; r + 1 < rings; r++) {
    const along = 9 + 21 * (r + 0.5) / (rings - 1)
    for (let j = 0; j < sides; j++) {
      // The tongue: from 9 to 12 only the facets between 0 and 2 radians exist.
      if (along < 12 && 2 * Math.PI * (j + 0.5) / sides > 2) continue
      const next = (j + 1) % sides
      const a = r * sides + j
      const b = r * sides + next
      const c = (r + 1) * sides + next
      const d = (r + 1) * sides + j
      index.push(a, b, c, a, c, d)
    }
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

const ALONG = Array.from({ length: 21 }, (_, i) => 10 + 19 * i / 20)

function prepFor(
  mesh: RotaryModelMesh, stock: BarStock, tool: NormalizedTool, exact: boolean,
  extra: { workspace?: RotarySamplingWorkspace; angleMaps?: 'write'; emitAngleMaps?: boolean; cell?: number } = {},
): RotarySamplingPrep {
  return createRotarySamplingPrep(mesh, stock, tool, {
    along: ALONG, requestedCellSize: extra.cell ?? CELL, conservativeCellBounds: true,
    ...(exact ? { exactTipRows: true } : {}),
    ...(extra.workspace !== undefined ? { workspace: extra.workspace } : {}),
    ...(extra.angleMaps !== undefined ? { angleMaps: extra.angleMaps } : {}),
    ...(extra.emitAngleMaps === true ? { emitAngleMaps: true } : {}),
  })
}

/** One job run directly, its lift applied the way assembly applies it. */
function runJob(prep: RotarySamplingPrep, angle: number, columns?: readonly number[]): { row: Float32Array; lift: number; sample: RotaryAngleSample } {
  const sample = runRotaryAngleJob(prep, prep.planFor([angle]), { index: 0, angle, ...(columns !== undefined ? { columns } : {}) })
  const row = Float32Array.from(sample.row)
  for (let i = 0; i < row.length; i++) if (Number.isFinite(row[i])) row[i] += sample.lift
  return { row, lift: sample.lift, sample }
}

const TOOLS = [toolOf('ball_endmill', 1.5), toolOf('flat_endmill', 1)]
const toolName = (tool: NormalizedTool): string => (tool.type === 'ball_endmill' ? '1.5 mm ball' : '1 mm flat')

// ── block 1: a row sampled at a few positions is the whole row there ────────
{
  const picks: number[][] = [[0], [20], [7], [3, 4, 5], [1, 9, 18], [0, 10, 20], ALONG.map((_, i) => i)]
  for (const axis of ['x', 'y'] as const) {
    const stock = roundStock(24, 40, axis)
    for (const tool of TOOLS) {
      // Exact rows: the same value, bit for bit, on any model.
      {
        const prep = prepFor(body(stock, 'none'), stock, tool, true)
        for (const angle of [0, 37.5, 123, 271.25]) {
          const whole = runJob(prep, angle)
          for (const columns of picks) {
            const part = runJob(prep, angle, columns)
            for (let i = 0; i < ALONG.length; i++) {
              if (columns.includes(i)) {
                assert.ok(Object.is(part.row[i], whole.row[i]),
                  `exact, ${axis} bar, ${toolName(tool)}, A${angle}, positions ${columns}: position ${i} reads ${part.row[i]}, the whole row ${whole.row[i]}`)
              } else {
                assert.ok(Number.isNaN(part.row[i]), `exact, A${angle}: position ${i} was not asked for and says nothing`)
              }
            }
          }
        }
      }
      // Height-map rows, where the whole row is at the cap. The ridges are on
      // the far half of the bar only, so a stretch on the near half has a cell
      // rise of its own well under the cap: the row must take the cap, not the
      // stretch's rise, to be the whole row's.
      {
        const prep = prepFor(body(stock, 'far half'), stock, tool, false)
        let belowCap = 0
        for (const angle of [0, 37.5, 123, 271.25]) {
          const whole = runJob(prep, angle)
          assert.equal(whole.lift, CELL, `map, ${axis} bar, ${toolName(tool)}, A${angle}: the whole row is at the cap`)
          for (const columns of picks) {
            const part = runJob(prep, angle, columns)
            assert.equal(part.lift, CELL, `map, A${angle}, positions ${columns}: a row sampled in part takes the cap`)
            for (let i = 0; i < ALONG.length; i++) {
              if (columns.includes(i)) {
                assert.ok(Object.is(part.row[i], whole.row[i]),
                  `map, ${axis} bar, ${toolName(tool)}, A${angle}, positions ${columns}: position ${i} reads ${part.row[i]}, the whole row ${whole.row[i]}`)
              } else {
                assert.ok(Number.isNaN(part.row[i]), `map, A${angle}: position ${i} was not asked for and says nothing`)
              }
            }
          }
          // The control: the near half alone does not reach the cap.
          const nearOnly = createRotarySamplingPrep(body(stock, 'none'), stock, tool, {
            along: ALONG, requestedCellSize: CELL, conservativeCellBounds: true,
          })
          if (runJob(nearOnly, angle).lift < CELL) belowCap++
        }
        assert.ok(belowCap > 0, `map, ${axis} bar, ${toolName(tool)}: without the ridges the strip's rise is under the cap at ${belowCap} of 4 angles`)
      }
      // A row sampled in part is not the angle's map: it is neither stored nor handed back.
      {
        const workspace: RotarySamplingWorkspace = {}
        const prep = prepFor(body(stock, 'all'), stock, tool, false, { workspace, angleMaps: 'write', emitAngleMaps: true })
        const part = runJob(prep, 45, [3, 4])
        assert.equal(part.sample.map, undefined, 'a row sampled in part hands no map back')
        assert.equal(workspace.angleMaps?.maps.size ?? 0, 0, 'a row sampled in part stores no map')
        const whole = runJob(prep, 45)
        assert.ok(whole.sample.map !== undefined, 'the whole row hands its map back')
        assert.equal(workspace.angleMaps?.maps.size, 1, 'the whole row stores its map')
        // And once the angle's map is stored, a row in part read from it is the whole row's.
        const reader = createRotarySamplingPrep(prep.mesh, stock, tool, {
          along: ALONG, requestedCellSize: CELL, conservativeCellBounds: true, angleMaps: 'read-write', workspace,
        })
        const fromCache = runJob(reader, 45, [3, 4])
        assert.equal(fromCache.sample.reused, true, 'a stored map serves a row in part')
        assert.ok(Object.is(fromCache.row[3], whole.row[3]) && Object.is(fromCache.row[4], whole.row[4]), 'the row in part read from the stored map is the whole row there')
      }
      // A map whose cell had to be enlarged keeps the whole row: its cap is not
      // the requested cell. On a body with no ridges the strip's rise is under
      // that larger cell, so a row that took the cap anyway would show.
      {
        const prep = prepFor(body(stock, 'none'), stock, tool, false, { cell: 0.004 })
        const whole = runJob(prep, 45)
        const part = runJob(prep, 45, [3, 4])
        assert.ok(whole.lift > 0.004, 'the map was reduced to a larger cell')
        assert.equal(part.lift, whole.lift, 'a reduced map keeps the strip\'s own lift for a row in part')
        assert.ok(Object.is(part.row[3], whole.row[3]) && Object.is(part.row[4], whole.row[4]), 'and reads the whole row\'s values')
      }
    }
  }
  console.log('  rows in part: exact and height-map rows hold the whole row\'s values at the positions asked for')
}

// ── block 2: every chord a ring ends up with was tested for that ring ───────
const BASE = Array.from({ length: 91 }, (_, k) => 4 * k)

interface Refinement {
  readonly angles: number[]
  readonly tips: Float32Array[]
  /** Every job the refinement ran, in order. */
  readonly jobs: RotaryAngleJob[]
  /** The value each job returned, by angle then ring position (lift applied). */
  readonly sampled: Map<number, Float32Array>
}

async function refine(prep: RotarySamplingPrep, stock: BarStock, tool: NormalizedTool, lifts: 'given' | 'withheld'): Promise<Refinement> {
  const base = sampleAnglesWithPrep(prep, BASE, [])
  assert.ok(base.valid, 'the base grid samples')
  const jobs: RotaryAngleJob[] = []
  const sampled = new Map<number, Float32Array>()
  const run = serialRotaryBatches(prep)
  const refined = await refineAroundSamplingAsync({
    prep, stock, tool, warnings: [], angles: base.anglesDeg, tips: base.tipRadius,
    ...(lifts === 'given' ? { lifts: base.lifts } : {}),
  }, async (batch) => {
    const samples = await run(batch)
    for (const job of batch) {
      jobs.push(job)
      const sample = samples.find((entry) => entry.index === job.index)!
      const row = Float32Array.from(sample.row)
      for (let i = 0; i < row.length; i++) if (Number.isFinite(row[i])) row[i] += sample.lift
      sampled.set(job.angle, row)
    }
    return samples
  })
  assert.ok(refined !== null && !refined.stopped, 'the refinement completes')
  return { angles: refined.angles, tips: refined.tips, jobs, sampled }
}

/** The two angles an inserted angle is the midpoint of: its segment when it was inserted. */
function parentsOf(angle: number): [number, number] {
  const k = Math.min(BASE.length - 2, Math.floor(angle / 4))
  let low = BASE[k]
  let high = BASE[k + 1]
  for (let depth = 0; depth < 12; depth++) {
    const mid = (low + high) / 2
    if (mid === angle) return [low, high]
    if (angle < mid) high = mid
    else low = mid
  }
  throw new Error(`A${angle} is not a midpoint of the grid`)
}

for (const axis of ['x', 'y'] as const) {
  const stock = roundStock(24, 40, axis)
  for (const [name, exact, ridges] of [['exact rows', true, 'none'], ['height-map rows', false, 'all']] as const) {
    for (const tool of TOOLS) {
      const label = `${name}, ${axis} bar, ${toolName(tool)}`
      const prep = prepFor(body(stock, ridges), stock, tool, exact)
      const result = await refine(prep, stock, tool, 'given')
      const { angles, tips, jobs, sampled } = result
      const indexOf = new Map(angles.map((angle, k) => [angle, k]))
      const isBase = new Set(BASE)
      assert.ok(angles.length > BASE.length + 40, `${label}: the body needs refining (${angles.length} angles)`)

      // The saving, and that it is real: most jobs after the first round ask for
      // a few positions, and the positions sampled are a fraction of whole rows.
      const part = jobs.filter((job) => job.columns !== undefined)
      const positionsSampled = jobs.reduce((n, job) => n + (job.columns?.length ?? ALONG.length), 0)
      assert.ok(part.length > jobs.length / 2, `${label}: ${part.length} of ${jobs.length} rows were sampled in part`)
      assert.ok(positionsSampled < 0.5 * jobs.length * ALONG.length,
        `${label}: ${positionsSampled} positions sampled, against ${jobs.length * ALONG.length} for whole rows`)
      for (const job of part) {
        assert.ok(job.columns!.length > 0, `${label}: a row in part asks for at least one position`)
        for (let n = 1; n < job.columns!.length; n++) assert.ok(job.columns![n] > job.columns![n - 1], `${label}: positions are ascending`)
      }

      let settledChords = 0
      let refinedPoints = 0
      let unjudged = 0
      const refinedAt = new Set<number>()
      for (let i = 0; i < ALONG.length; i++) {
        const value = (angle: number): number => tips[indexOf.get(angle)!][i]
        // A ring's own points: the base grid, and every inserted angle whose value
        // there is not simply the midpoint of the chord it was inserted on.
        const own: number[] = []
        for (const angle of angles) {
          if (isBase.has(angle)) {
            own.push(angle)
            continue
          }
          const [low, high] = parentsOf(angle)
          const a = value(low)
          const b = value(high)
          const here = value(angle)
          const row = sampled.get(angle)
          const asked = jobs.find((job) => job.angle === angle)
          const sampledHere = asked !== undefined && (asked.columns === undefined || asked.columns.includes(i))
          const onChord = Number.isFinite(a) && Number.isFinite(b) && Object.is(here, Math.fround((a + b) / 2))
          if (onChord && !(sampledHere && Object.is(row![i], here))) continue
          // Refined here: the value must be the one sampled for this ring at this angle...
          assert.ok(sampledHere, `${label}: ring ${i} carries a value of its own at A${angle}, which no job sampled for it`)
          assert.ok(Object.is(here, row![i]), `${label}: ring ${i} at A${angle} is ${here}, the job returned ${row![i]}`)
          own.push(angle)
          refinedPoints++
          refinedAt.add(angle)
          if (!Number.isFinite(a) || !Number.isFinite(b)) unjudged++
        }
        // Between two of its own points a ring's path is one chord. Where the grid
        // has more angles inside it, they were inserted for other rings.
        for (let n = 0; n + 1 < own.length; n++) {
          const from = own[n]
          const to = own[n + 1]
          const kFrom = indexOf.get(from)!
          const kTo = indexOf.get(to)!
          if (kTo === kFrom + 1) continue
          settledChords++
          const a = value(from)
          const b = value(to)
          assert.ok(Number.isFinite(a) && Number.isFinite(b), `${label}: ring ${i} is settled from A${from} to A${to} with both ends on the model`)
          for (let k = kFrom + 1; k < kTo; k++) {
            const f = (angles[k] - from) / (to - from)
            assert.ok(Math.abs(tips[k][i] - (a + (b - a) * f)) <= 1e-5,
              `${label}: ring ${i} at A${angles[k]} lies on its chord from A${from} to A${to}`)
          }
          // The chord is the segment the ring was settled on, and its midpoint was
          // sampled for this ring and compared with it.
          const mid = (from + to) / 2
          const radians = (to - from) * Math.PI / 180
          const arc = (Math.max(a, b, 0) + tool.radius) * radians
          if (arc <= FLOOR) continue
          const job = jobs.find((entry) => entry.angle === mid)
          assert.ok(job !== undefined && (job.columns === undefined || job.columns.includes(i)),
            `${label}: ring ${i}'s chord from A${from} to A${to} was never sampled at its midpoint for that ring`)
          const middle = sampled.get(mid)![i]
          if (!Number.isFinite(middle)) continue
          const allowance = exact || tool.type !== 'ball_endmill'
            ? FLOOR
            : Math.max(FLOOR, (Math.max(0, Math.min(a, b)) * radians) ** 2 / (8 * tool.radius))
          assert.ok(middle - (a + b) / 2 <= allowance,
            `${label}: ring ${i}'s chord from A${from} to A${to} stands ${(middle - (a + b) / 2).toFixed(5)} mm under the model at its midpoint; `
              + `a chord is only settled within ${allowance.toFixed(5)} mm`)
        }
      }
      // An angle is inserted because some ring failed there, and that ring carries
      // its sampled value at it: no angle is inserted for nobody.
      for (const angle of angles) {
        if (!isBase.has(angle)) assert.ok(refinedAt.has(angle), `${label}: A${angle} was inserted, yet no ring was refined there`)
      }
      assert.ok(settledChords > 100, `${label}: ${settledChords} chords were settled across angles inserted for other rings`)
      assert.ok(refinedPoints > 100, `${label}: ${refinedPoints} points were refined on their own ring`)
      assert.ok(unjudged > 0, `${label}: ${unjudged} points were kept where an end of the chord has no model under the cutter`)

      // Every refined point is the whole row's value at that angle: sample a
      // spread of the inserted angles again, as whole rows.
      const inserted = angles.filter((angle) => !isBase.has(angle))
      for (let n = 0; n < inserted.length; n += 7) {
        const angle = inserted[n]
        const whole = runJob(prep, angle).row
        const job = jobs.find((entry) => entry.angle === angle)!
        for (const i of job.columns ?? ALONG.map((_, index) => index)) {
          assert.ok(Object.is(sampled.get(angle)![i], whole[i]),
            `${label}: ring ${i} at A${angle} was sampled as ${sampled.get(angle)![i]}, the whole row reads ${whole[i]}`)
        }
      }
      console.log(`  ${label}: ${angles.length} angles, ${jobs.length} rows of which ${part.length} in part (${positionsSampled} positions against`
        + ` ${jobs.length * ALONG.length}), ${refinedPoints} refined points, ${settledChords} settled chords`)
    }
  }
}

// ── block 3: when a height-map row may be sampled in part ───────────────────
{
  const stock = roundStock(24, 40, 'x')
  const tool = TOOLS[0]
  // Rows at the cap either side: later rounds ask for rows in part (block 2).
  // Without the lifts the refinement cannot know, and samples whole rows.
  const ridged = prepFor(body(stock, 'all'), stock, tool, false)
  const withheld = await refine(ridged, stock, tool, 'withheld')
  assert.ok(withheld.jobs.length > 91 && withheld.jobs.every((job) => job.columns === undefined),
    'a height-map refinement given no lifts samples whole rows')
  // A smooth body's strips are under the cap: a row in part would take the cap
  // and stand above its neighbours, so none is asked for where an end is under it.
  const smooth = prepFor(body(stock, 'none'), stock, tool, false)
  const base = sampleAnglesWithPrep(smooth, BASE, [])
  const result = await refine(smooth, stock, tool, 'given')
  const liftAt = new Map(BASE.map((angle, k) => [angle, base.lifts[k]]))
  const rowLift = (angle: number): number => {
    const known = liftAt.get(angle)
    if (known !== undefined) return known
    const whole = runRotaryAngleJob(smooth, smooth.planFor([angle]), { index: 0, angle })
    return whole.lift
  }
  let partial = 0
  let whole = 0
  for (const job of result.jobs) {
    if (job.columns === undefined) {
      whole++
      continue
    }
    partial++
    const [low, high] = parentsOf(job.angle)
    assert.ok(rowLift(low) >= CELL && rowLift(high) >= CELL,
      `the row in part at A${job.angle} sits between rows lifted ${rowLift(low)} and ${rowLift(high)}; both must be at the ${CELL} mm cap`)
  }
  assert.ok(whole > 91, `the smooth body kept ${whole} whole rows after the first round's 90 (${partial} in part)`)
  // Exact rows carry no lift, so they are always sampled in part, lifts or none.
  const exact = prepFor(body(stock, 'none'), stock, tool, true)
  const exactWithheld = await refine(exact, stock, tool, 'withheld')
  assert.ok(exactWithheld.jobs.some((job) => job.columns !== undefined), 'an exact refinement samples rows in part without being given lifts')
  console.log(`  height-map rows in part only between rows at the cap: smooth body ${whole} whole and ${partial} in part; no lifts given, ${withheld.jobs.length} whole`)
}

console.log('engine/toolpaths/rotaryPerRingRefinement.test.ts: all assertions passed')
