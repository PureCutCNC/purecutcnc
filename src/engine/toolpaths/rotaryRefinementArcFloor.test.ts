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
 * #1185 slice R1: the around refinement stops bisecting a segment whose arc is
 * already within the surface tolerance.
 *
 * `refineAroundSampling` bisects a segment when the model at its mid angle
 * stands more than the tolerance above the straight move between its ends.
 * Where the cutter drops off a wall the tip is a step in angle, and no halving
 * satisfies that test: the refinement ran all eight rounds there, down to a
 * 0.005-degree step on the benchmark bust, and still had failing segments.
 *
 * A segment whose arc is within the tolerance cannot put the cutter further
 * into the model than the tolerance, whatever its midpoint reads (see
 * `aroundArcFloor`), so it is left alone and its midpoint is not sampled.
 *
 * Block 1 is three cams of different sizes along the bar, each with undercut
 * walls, where the tip really is a step. With a grid sample placed just before
 * a step, its segment must be bisected down to the floor and no further --
 * judged on the ring the step is on, not on the first ring or the segment as a
 * whole -- its settled halves must cost no rows, and the cutter body, swept
 * along that segment's chord against the section itself, must stay within the
 * tolerance of the model. Block 2 pins a refinement that converges long before
 * the floor, captured before this slice, so the floor cannot be what changed it.
 *
 * Mutations these blocks catch (each was applied and seen to fail):
 *  - no floor at all (the old behaviour): the step segment is bisected to a
 *    quarter of what the floor allows;
 *  - a floor three or ten times the tolerance: the step segment is left longer
 *    than the tolerance;
 *  - measuring the arc without the cutter radius, or at the lower of the two
 *    tips: the step segment stops a halving early;
 *  - settling a segment on its first ring alone: the large ring's step segment
 *    stops when the small ring is satisfied;
 *  - dropping the per-ring test inside a segment that is not settled as a
 *    whole: the small ring's step segment is halved once more than it asks for;
 *  - sampling the midpoint of a settled segment anyway: the row count;
 *  - (#1185 R2) the arc floor staying at the surface bound when the caller's
 *    tolerance floor is larger: block 3.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { barCentre, barPivotZ } from '../../types/barStock'
import { roundStock } from '../../types/project'
import type { BarStock } from '../../types/project'
import { createRotarySamplingPrep, refineAroundSampling, sampleAnglesWithPrep } from './rotarySampling'
import type { RotaryModelMesh, RotarySamplingPrep } from './rotarySampling'
import type { NormalizedTool } from './types'

const TOLERANCE = 0.005

function toolOf(type: 'ball_endmill' | 'flat_endmill', radius: number): NormalizedTool {
  return {
    id: 't1', name: 't1', sourceUnits: 'mm', units: 'mm', type,
    diameter: radius * 2, radius, vBitAngle: null, flutes: 2, material: 'carbide',
    defaultRpm: 0, defaultFeed: 0, defaultPlungeFeed: 0, defaultStepdown: 0,
    defaultStepover: 0, maxCutDepth: 0,
  }
}

/** A closed section outline as `(across, up)` points from the axis, in order. */
type Section = Array<[number, number]>

/** A prism of `section` from `from` to `to` along the bar. */
function prism(stock: BarStock, section: Section, from = 12, to = 28): RotaryModelMesh {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const positions: number[] = []
  const index: number[] = []
  const count = section.length
  for (const along of [from, to]) {
    for (const [across, up] of section) positions.push(along, centre + across, pivot + up)
  }
  for (let j = 0; j < count; j++) {
    const next = (j + 1) % count
    index.push(j, next, count + next, j, count + next, count + j)
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

function join(...meshes: RotaryModelMesh[]): RotaryModelMesh {
  const positions = new Float32Array(meshes.reduce((n, m) => n + m.positions.length, 0))
  const index = new Uint32Array(meshes.reduce((n, m) => n + m.index.length, 0))
  let p = 0
  let i = 0
  for (const mesh of meshes) {
    const offset = p / 3
    positions.set(mesh.positions, p)
    for (let k = 0; k < mesh.index.length; k++) index[i + k] = mesh.index[k] + offset
    p += mesh.positions.length
    i += mesh.index.length
  }
  return { positions, index }
}

/**
 * A cam with two **undercut** walls, scaled by `scale`: radius 6 from 20 to 200
 * degrees and radius 4 from 190 round to 30, so each wall leans back under the
 * land it ends.
 *
 * The lean is what makes the tip a step. A radial wall turns into the cutter's
 * footprint foot first, and the tip climbs it smoothly; an undercut wall brings
 * its top corner in first, so the tip jumps from the low surface to the land the
 * moment that corner crosses the cutter's edge.
 */
function camSection(scale: number): Section {
  const section: Section = []
  for (let degrees = 20; degrees <= 200; degrees += 1) {
    const t = degrees * Math.PI / 180
    section.push([6 * scale * Math.cos(t), 6 * scale * Math.sin(t)])
  }
  for (let degrees = 190; degrees <= 390; degrees += 1) {
    const t = degrees * Math.PI / 180
    section.push([4 * scale * Math.cos(t), 4 * scale * Math.sin(t)])
  }
  return section
}

/** `section` as closely spaced points along its outline, for the body sweep. */
function outlinePoints(section: Section, spacing: number): Section {
  const points: Section = []
  for (let j = 0; j < section.length; j++) {
    const [ax, ay] = section[j]
    const [bx, by] = section[(j + 1) % section.length]
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / spacing))
    for (let s = 0; s < steps; s++) points.push([ax + (bx - ax) * s / steps, ay + (by - ay) * s / steps])
  }
  return points
}

/**
 * How far the cutter body is inside the model's outline with its tip at
 * `tip` above the axis and the bar turned to `angleDeg`: the largest, over the
 * outline's points, of that point's depth inside the body. The body is the
 * cutter's own shape -- a cylinder with a flat or a ball end -- and the depth is
 * the distance to the body's nearest surface, so a wall the cutter's flank has
 * just crossed reads as the little it has crossed and not as the wall's height.
 */
function bodyPenetration(outline: Section, angleDeg: number, tip: number, tool: NormalizedTool): number {
  const turn = angleDeg * Math.PI / 180
  const cos = Math.cos(turn)
  const sin = Math.sin(turn)
  const r = tool.radius
  let worst = 0
  for (const [a, u] of outline) {
    const across = a * cos - u * sin
    const up = a * sin + u * cos
    const side = r - Math.abs(across)
    if (side <= 0) continue
    let depth: number
    if (tool.type === 'ball_endmill' && up < tip + r) {
      depth = r - Math.hypot(across, up - (tip + r))
    } else {
      depth = Math.min(side, up - tip)
    }
    if (depth > worst) worst = depth
  }
  return worst
}

const STOCK = roundStock(20, 40, 'x')

/**
 * Three cams of different sizes along the bar, one ring on each, and the
 * **smallest listed first**. A segment's arc is longer on a larger ring, so the
 * rings reach the floor at different depths -- which is what tells a floor
 * applied per ring from one applied to the first ring, or to the whole segment.
 * Each ring sits more than a cutter radius from its cam's ends, so the cutter
 * there sees one section only and the body sweep can use that section alone.
 */
const SCALES = [0.594, 0.7, 1.05]
const SPANS: Array<[number, number]> = [[22.6, 28], [17.3, 22.6], [12, 17.3]]
const ALONG = [25.3, 20, 14.65]
const SMALL = 0
const LARGE = 2
/**
 * The base steps. Six halvings of 2.72 degrees leave 0.0425, where the large
 * ring's land sweeps just over the floor with the cutter radius counted and
 * just under it without; six halvings of 3.6 leave 0.05625, where the small
 * ring's land is within the floor and the large ring's low surface is not.
 */
const LARGE_STEP = 2.72
const SMALL_STEP = 3.6

function camsMesh(): RotaryModelMesh {
  return join(...SCALES.map((scale, i) => prism(STOCK, camSection(scale), SPANS[i][0], SPANS[i][1])))
}

interface Refined {
  readonly angles: number[]
  readonly tips: Float32Array[]
  /** Angle rows the refinement sampled beyond the base grid. */
  readonly sampledRows: number
}

function prepFor(mesh: RotaryModelMesh, tool: NormalizedTool, exact: boolean): RotarySamplingPrep {
  // `exact` reads each tip as the true footprint maximum, with none of the
  // conservative map's lift: the rows then sit on the model, so the body sweep
  // below measures the chords and not a margin the sampler added.
  return createRotarySamplingPrep(mesh, STOCK, tool, {
    along: ALONG, requestedCellSize: 0.1, conservativeCellBounds: true,
    ...(exact ? { exactTipRows: true } : {}),
  })
}

function refine(
  prep: RotarySamplingPrep, tool: NormalizedTool, baseAngles: readonly number[], toleranceFloor?: number,
): Refined {
  const base = sampleAnglesWithPrep(prep, baseAngles, [])
  assert.ok(base.valid, 'the base grid samples')
  // The stop callback is polled once before every angle row and never stops:
  // it counts the rows the refinement asks for.
  let polled = 0
  const refined = refineAroundSampling({
    prep, stock: STOCK, tool, warnings: [], angles: base.anglesDeg, tips: base.tipRadius,
    shouldStop: () => { polled++; return false },
    ...(toleranceFloor !== undefined ? { toleranceFloor } : {}),
  })
  assert.ok(refined !== null && !refined.stopped, 'the refinement completes')
  return { angles: refined.angles, tips: refined.tips, sampledRows: polled }
}

/** The angle at which ring `ring`'s tip steps up onto its land, between A232 and A246. */
function stepAngle(prep: RotarySamplingPrep, ring: number, label: string): number {
  const tipAt = (angle: number): number => sampleAnglesWithPrep(prep, [angle], []).tipRadius[0][ring]
  const threshold = 4.5 * SCALES[ring]
  let below = 232
  let above = 246
  assert.ok(tipAt(below) < threshold && tipAt(above) > threshold, `${label}: ring ${ring}'s step lies between A232 and A246`)
  for (let n = 0; n < 44; n++) {
    const mid = (below + above) / 2
    if (tipAt(mid) > threshold) above = mid
    else below = mid
  }
  assert.ok(tipAt(above + 1e-6) - tipAt(above - 1e-6) > 0.4 * SCALES[ring], `${label}: ring ${ring}'s tip steps at A${above.toFixed(6)}`)
  return above
}

/** A grid with a sample 0.002 degrees before `step`: every bisection of that
 *  segment then finds its midpoint on the high side of the step, which is the
 *  case no number of halvings resolves. A real grid meets it by chance. */
function gridBefore(step: number, baseStep: number): number[] {
  const offset = (((step - 0.002) % baseStep) + baseStep) % baseStep
  return Array.from({ length: Math.floor(356 / baseStep) + 1 }, (_, k) => offset + baseStep * k)
}

// ── block 1: a step is refined to the floor, and no further ─────────────────
for (const tool of [toolOf('flat_endmill', 1), toolOf('ball_endmill', 1)]) {
  const label = tool.type === 'ball_endmill' ? 'cams, 1 mm ball' : 'cams, 1 mm flat'
  const prep = prepFor(camsMesh(), tool, true)
  const outlines = SCALES.map((scale) => outlinePoints(camSection(scale), 0.002))
  // The arc a segment sweeps at one ring position, as `aroundSegmentArc` measures it.
  const arcOf = (r: Refined, k: number, i: number): number =>
    (Math.max(r.tips[k][i], r.tips[k + 1][i], 0) + tool.radius) * (r.angles[k + 1] - r.angles[k]) * Math.PI / 180
  /** The segment of `r` that holds `angle`. */
  const segmentAt = (r: Refined, angle: number): number => {
    for (let k = 0; k + 1 < r.angles.length; k++) if (r.angles[k] <= angle && angle <= r.angles[k + 1]) return k
    throw new Error(`no segment holds A${angle}`)
  }
  /**
   * The floor's own promise, on the cutter's body: nowhere along the chord of
   * the segment the floor settled, on the ring whose step it holds, is the body
   * further into the model than the tolerance allows. Twice the tolerance is
   * the bound: one for the chord, one for the outline's own facets against the
   * true arcs the body turns through.
   *
   * Only that segment and that ring are swept, because only they are this
   * slice's doing. A step that falls in the half of a segment its midpoint does
   * not sample passes the midpoint test at any depth; that is the test's own
   * blind spot, it predates the floor, and the floor neither causes nor cures
   * it (on these cams an exact flat read leaves the body up to 0.06 mm into a
   * land at such a step, with or without this slice).
   */
  const sweep = (r: Refined, k: number, ring: number, what: string): number => {
    let worst = 0
    let worstAt = ''
    {
      for (let step = 0; step <= 64; step++) {
        const f = step / 64
        const angle = r.angles[k] + (r.angles[k + 1] - r.angles[k]) * f
        for (const i of [ring]) {
          const a = r.tips[k][i]
          const b = r.tips[k + 1][i]
          if (!Number.isFinite(a) || !Number.isFinite(b)) continue
          const depth = bodyPenetration(outlines[i], angle, a + (b - a) * f, tool)
          if (depth > worst) {
            worst = depth
            worstAt = `A${angle.toFixed(4)}, ring ${i}`
          }
        }
      }
    }
    assert.ok(worst <= 2 * TOLERANCE,
      `${label}, ${what}: the body is ${worst.toFixed(5)} mm into the model at ${worstAt}; the bound is ${2 * TOLERANCE} mm`)
    return worst
  }

  // 1a. The step on the LARGE ring. Its segment is bisected while the large
  // ring's arc is above the floor -- the smaller rings' arcs are within it a
  // halving earlier, and must not be what stops it.
  {
    const step = stepAngle(prep, LARGE, label)
    const grid = gridBefore(step, LARGE_STEP)
    const refined = refine(prep, tool, grid)
    const k = segmentAt(refined, step)
    const arc = arcOf(refined, k, LARGE)
    assert.ok(arc <= TOLERANCE,
      `${label}: the large ring's step segment sweeps ${arc.toFixed(6)} mm, within the ${TOLERANCE} mm floor`)
    assert.ok(arc > TOLERANCE / 2 * 0.999,
      `${label}: the large ring's step segment sweeps ${arc.toFixed(6)} mm; nothing is bisected below the floor`)
    // Rows: one midpoint per base segment, then two per inserted angle -- the
    // two halves each bisection leaves -- less the halves already within the
    // floor, whose midpoints are never sampled.
    const inserted = refined.angles.length - grid.length
    assert.ok(inserted > 0, `${label}: the step was refined`)
    assert.ok(refined.sampledRows < grid.length - 1 + 2 * inserted,
      `${label}: ${refined.sampledRows} rows sampled for ${inserted} inserted angles; a settled segment's midpoint is not sampled`)
    const worst = sweep(refined, k, LARGE, 'large ring step')
    console.log(`  ${label}, step on the large ring: ${refined.angles.length} angles, ${refined.sampledRows} rows sampled,`
      + ` step segment arc ${arc.toFixed(5)} mm, body at most ${worst.toFixed(5)} mm into the model`)
  }

  // 1b. The step on the SMALL ring. That ring's arc reaches the floor a halving
  // before the large ring's does, and its step segment must stop there: the
  // large ring is smooth at this angle and passes its own test, so nothing asks
  // for another halving. A flat only: the ball rides up the small cam's wall on
  // its flank, so its tip does not step there.
  if (tool.type === 'flat_endmill') {
    const step = stepAngle(prep, SMALL, label)
    const refined = refine(prep, tool, gridBefore(step, SMALL_STEP))
    const k = segmentAt(refined, step)
    const small = arcOf(refined, k, SMALL)
    const large = arcOf(refined, k, LARGE)
    assert.ok(small <= TOLERANCE,
      `${label}: the small ring's step segment sweeps ${small.toFixed(6)} mm on that ring, within the floor`)
    assert.ok(small > TOLERANCE / 2 * 0.999,
      `${label}: the small ring's step segment sweeps ${small.toFixed(6)} mm on that ring; a ring within the floor asks for no further halving`)
    assert.ok(large > TOLERANCE,
      `${label}: the same segment sweeps ${large.toFixed(6)} mm on the large ring, above the floor -- so this is the per-ring case`)
    const worst = sweep(refined, k, SMALL, 'small ring step')
    console.log(`  ${label}, step on the small ring: ${refined.angles.length} angles, step segment arc ${small.toFixed(5)} mm there`
      + ` and ${large.toFixed(5)} mm on the large ring, body at most ${worst.toFixed(5)} mm into the model`)
  }
}

// ── block 2: a refinement that converges is the refinement it was ───────────
{
  // A hexagon under a ball, read through the conservative map: the ball rolls
  // over each corner, a few rounds of bisection follow it, and no segment comes
  // anywhere near the floor.
  const section: Section = []
  for (let k = 0; k < 6; k++) {
    const t = (15 + 60 * k) * Math.PI / 180
    section.push([7 * Math.cos(t), 7 * Math.sin(t)])
  }
  const tool = toolOf('ball_endmill', 1.5)
  const HEX_ANGLES = Array.from({ length: 181 }, (_, k) => 2 * k)
  const HEX_ALONG_MESH = prism(STOCK, section)
  const refined = refine(prepFor(HEX_ALONG_MESH, tool, false), tool, HEX_ANGLES)
  const hash = createHash('sha256')
  hash.update(new Uint8Array(new Float64Array(refined.angles).buffer))
  for (const row of refined.tips) hash.update(new Uint8Array(row.buffer, row.byteOffset, row.byteLength))
  const digest = hash.digest('hex')
  let shortestStep = Infinity
  for (let k = 0; k + 1 < refined.angles.length; k++) shortestStep = Math.min(shortestStep, refined.angles[k + 1] - refined.angles[k])
  assert.ok(refined.angles.length > HEX_ANGLES.length, 'the hexagon needs refining')
  assert.ok(shortestStep * Math.PI / 180 * (7 + tool.radius) > 4 * TOLERANCE,
    `the hexagon's shortest step (${shortestStep} degrees) is well above the floor`)
  assert.equal(digest, '02fa8129bdd6130fac123bbfaefb400b742c1398b62bdca61033a1b8e7a0a408', 'the hexagon refines to the angles and rows it did before the floor existed')
  console.log(`  hexagon, 1.5 mm ball: ${refined.angles.length} angles, shortest step ${shortestStep} degrees, digest ${digest.slice(0, 16)}`)
}

// ── block 3: the floor is the refinement's own tolerance (#1185 R2) ─────────
{
  // A rough that leaves stock refines to a share of it, and the arc below which
  // a step is no longer bisected is that same share: a step followed down to
  // 0.005 mm under a 0.125 mm tolerance would be rows spent on stock the finish
  // removes. The large cam's step again, with a rough's floor.
  const tool = toolOf('flat_endmill', 1)
  const label = 'cams, 1 mm flat, rough floor'
  const roughFloor = 0.125
  const prep = prepFor(camsMesh(), tool, true)
  const step = stepAngle(prep, LARGE, label)
  const grid = gridBefore(step, LARGE_STEP)
  const refined = refine(prep, tool, grid, roughFloor)
  let k = -1
  for (let n = 0; n + 1 < refined.angles.length; n++) if (refined.angles[n] <= step && step <= refined.angles[n + 1]) k = n
  assert.ok(k >= 0, `${label}: a segment holds the step`)
  const arc = (Math.max(refined.tips[k][LARGE], refined.tips[k + 1][LARGE], 0) + tool.radius)
    * (refined.angles[k + 1] - refined.angles[k]) * Math.PI / 180
  assert.ok(arc <= roughFloor, `${label}: the step segment sweeps ${arc.toFixed(5)} mm, within the ${roughFloor} mm floor`)
  assert.ok(arc > roughFloor / 2 * 0.999,
    `${label}: the step segment sweeps ${arc.toFixed(5)} mm; nothing is bisected below the rough's own floor`)
  const strict = refine(prep, tool, grid)
  assert.ok(refined.angles.length < strict.angles.length,
    `${label}: ${refined.angles.length} angles against ${strict.angles.length} at the surface bound`)
  console.log(`  ${label}: step segment arc ${arc.toFixed(5)} mm, ${refined.angles.length} angles (${strict.angles.length} at the surface bound)`)
}

console.log('engine/toolpaths/rotaryRefinementArcFloor.test.ts: all assertions passed')
