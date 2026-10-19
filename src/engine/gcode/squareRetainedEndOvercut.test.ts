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
 * #1045 slice G item 1: the retained-end overcut the export guard found.
 *
 * Slice F's guard refused a 20 x 1,000 mm square blank with 100 mm retained ends
 * because the around rough's ring tip was lifted to the retained stub's corner
 * at the end of the band, and the *next* layer then took more than `stepdown`
 * out of what that raised sample had left. The generator now (a) samples a
 * square blank's around rings against the model alone -- the cut range is pulled
 * a cutter radius inside a stub face and the exact stub-contact floor is the
 * net -- and (b) keeps what each sample last left, so a layer's target is
 * `max(layerRadius, standing - stepdown)` whenever any sample still stands above
 * the previous layer's top (a model protrusion, or a stub floor).
 *
 * This test generates rough + finish on the handoff's 20 x 1,000 case and on a
 * seeded set of retained-end variants, asserts the export guard admits every
 * one, and then makes the independent measurement the guard is supposed to be
 * approximating: walking the rough's own emitted layers, at every (along, angle)
 * sample the second and later layers may not take more than `stepdown` out of
 * the material the earlier layers left there.
 *
 * #1045 slice I: every seeded variant, ball included, is admitted. The slice-H
 * guard's whole-cell rasterisation refused the ball variants at a cut-range
 * boundary fringe; it now caps a partially covered cell's charge by the cutter
 * body's own radial span, which is an upper bound on what any cut can remove
 * there (see `cutBand`).
 *
 * Run with: npx tsx src/engine/gcode/squareRetainedEndOvercut.test.ts
 */

import assert from 'node:assert/strict'
import { barMaxRadius, barPivotZ, squareStock } from '../../types/barStock'
import type { SquareStock } from '../../types/project'
import { defaultTool, getStockBounds, newProject } from '../../types/project'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { generateRotaryFinish, generateRotaryRough } from '../toolpaths/rotaryModel'
import type { RotaryModelMesh } from '../toolpaths/rotaryModel'
import type { ToolpathResult } from '../toolpaths/types'
import { createSquareSweepState, guardSquareOperation, squareMaterialAlongRange } from './squareSweepGuard'
import type { EmittedSquareCutter } from '../squareRotarySafety'

const PIVOT = (stock: SquareStock): number => barPivotZ(stock)
const CENTRE = (stock: SquareStock): number => stock.thickness / 2

/** A coaxial cylinder surface: a square-to-round model inside the blank. */
function cylinder(stock: SquareStock, radius: number, from: number, to: number, segments = 96): RotaryModelMesh {
  const centre = CENTRE(stock)
  const pivot = PIVOT(stock)
  const positions: number[] = []
  const index: number[] = []
  for (const along of [from, to]) {
    for (let j = 0; j < segments; j++) {
      const t = 2 * Math.PI * j / segments
      const across = centre + radius * Math.cos(t)
      const up = pivot + radius * Math.sin(t)
      if (stock.axis === 'x') positions.push(along, across, up)
      else positions.push(across, along, up)
    }
  }
  for (let j = 0; j < segments; j++) {
    const j2 = (j + 1) % segments
    index.push(j, j2, segments + j2, j, segments + j2, segments + j)
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

/** A revolved stepped part: coaxial cylinders joined by flat shoulders. */
function stepped(stock: SquareStock, profile: ReadonlyArray<{ along: number; radius: number }>, segments = 96): RotaryModelMesh {
  const centre = CENTRE(stock)
  const pivot = PIVOT(stock)
  const positions: number[] = []
  const index: number[] = []
  for (const step of profile) {
    for (let j = 0; j < segments; j++) {
      const t = 2 * Math.PI * j / segments
      const across = centre + step.radius * Math.cos(t)
      const up = pivot + step.radius * Math.sin(t)
      if (stock.axis === 'x') positions.push(step.along, across, up)
      else positions.push(across, step.along, up)
    }
  }
  for (let ring = 0; ring + 1 < profile.length; ring++) {
    for (let j = 0; j < segments; j++) {
      const j2 = (j + 1) % segments
      const a = ring * segments
      const b = (ring + 1) * segments
      index.push(a + j, a + j2, b + j2, a + j, b + j2, b + j)
    }
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

interface Case {
  readonly label: string
  readonly stock: SquareStock
  readonly model: RotaryModelMesh
  readonly type: 'flat_endmill' | 'ball_endmill'
  readonly diameter: number
  readonly stepdown: number
  readonly stepover: number
  readonly sampleSpacing: number
  readonly alongStart: number
  readonly alongEnd: number
}

function normalizedTool(type: Case['type'], diameter: number): Parameters<typeof generateRotaryRough>[3] {
  const row = {
    ...defaultTool('mm', 1), id: 'tool', name: 'tool', units: 'mm' as const,
    type, diameter,
  }
  return {
    id: row.id, name: row.name, sourceUnits: 'mm' as const, units: 'mm' as const,
    type, diameter, radius: diameter / 2, vBitAngle: null,
    flutes: row.flutes, material: row.material, defaultRpm: 0, defaultFeed: 0,
    defaultPlungeFeed: 0, defaultStepdown: 0, defaultStepover: 0, maxCutDepth: 0,
  }
}

function projectFor(stock: SquareStock, tool: Case): ReturnType<typeof newProject> {
  const project = newProject('retained overcut', 'mm')
  project.meta.projectType = 'rotary'
  project.stock = stock
  project.tools = [{
    ...defaultTool('mm', 1), id: 'tool', name: 'tool', units: 'mm',
    type: tool.type, diameter: tool.diameter,
  }]
  return project
}

function cutterFor(entry: Case): EmittedSquareCutter {
  return {
    id: 'tool', units: 'mm', type: entry.type, diameter: entry.diameter, radius: entry.diameter / 2,
  }
}

function travelZ(stock: SquareStock): number {
  return PIVOT(stock) + barMaxRadius(stock) + 1
}

/**
 * The independent per-sample measurement: for every emitted turning cut, read
 * the commanded tip at each 0.25 degree sample of its sweep and assert no cut
 * takes more than `stepdown` out of the material an **earlier pass** left at
 * that sample. The commanded motion only lowers material, so the lowest tip
 * already emitted there is what stands, and the check needs no layer
 * bookkeeping: a second pass at the same sample is a second pass, whichever
 * layer it is in. A sample no earlier pass cut is exempt -- its first cut is
 * the operation's own layer depth, not a step from what a layer left (and
 * comparing it to the raw blank would charge the layer's angular resolution,
 * not the generator's per-sample material tracking).
 */
function worstPerSampleDrop(result: ToolpathResult, stock: SquareStock, stepdown: number): number {
  const alongOf = (point: { x: number; y: number }): number => stock.axis === 'x' ? point.x : point.y
  const step = 0.25
  const grid = Math.round(360 / step)
  // What stands at each (along, 0.25 degree angle) sample after the cuts so far.
  // `along` is keyed by microns; the angle index fits below 2048.
  const left = new Map<number, number>()
  let worst = Number.NEGATIVE_INFINITY
  for (const move of result.moves) {
    if (move.kind !== 'cut') continue
    const fromAngle = move.from.a
    const toAngle = move.to.a
    if (fromAngle === undefined || toAngle === undefined || fromAngle === toAngle) continue
    const along = alongOf(move.from)
    const alongKey = Math.round(along * 1e6) * 2048
    const low = Math.min(fromAngle, toAngle)
    const high = Math.max(fromAngle, toAngle)
    for (let angle = Math.ceil(low / step) * step; angle <= high + 1e-9; angle += step) {
      const fraction = (angle - fromAngle) / (toAngle - fromAngle)
      const tip = move.from.z + (move.to.z - move.from.z) * fraction - barPivotZ(stock)
      const index = Math.round(angle / step) % grid
      const cell = alongKey + index
      const material = left.get(cell)
      if (material !== undefined) {
        const drop = material - tip
        if (drop > worst) worst = drop
      }
      if (material === undefined || tip < material) left.set(cell, tip)
    }
  }
  // A drop above one stepdown is a layer taking too much at a sample.
  return worst - stepdown
}

console.log('Testing the 20 x 1,000 retained-end rough + finish...')
{
  const stock = squareStock(20, 1000, 'x', { x: 0, y: 0 })
  const entry: Case = {
    label: '20x1000 retained',
    stock,
    model: cylinder(stock, 5, 100, 900),
    type: 'ball_endmill',
    diameter: 3,
    stepdown: 2,
    stepover: 2,
    sampleSpacing: 1,
    alongStart: 100,
    alongEnd: 900,
  }
  runCase(entry)
}

console.log('Testing that the guard refuses the stepped part\'s real shoulder overcut...')
{
  // A 30 mm square blank, a 12 mm flange between two 6 mm journals. Slice G's
  // per-sample tracking was meant to make the neighbouring rings step down the
  // raised shelf one `stepdown` at a time. It never did: the tracking looked at
  // the neighbouring ring's *tip at its own along position*, not at the
  // material that ring leaves over the current along position, so the shelf
  // survived and the next ring took ~2.8 mm. Codex found exactly this (the
  // tracking never binds and the fixture exempted first cuts); slice H removed
  // the tracking rather than leave dead code. The guard, now conservative in
  // whole cells, sees the shelf and refuses the rough. That refusal is the
  // correct answer for this generated program, and is asserted here so the
  // generator limitation stays visible rather than hidden behind a guard that
  // evaluated cell centres.
  const stock = squareStock(30, 200, 'x', { x: 0, y: 0 })
  const tool = normalizedTool('flat_endmill', 4)
  const params = {
    stepover: 2.5, sampleSpacing: 1, stockToLeave: 0, alongStart: 20, alongEnd: 180,
    safeRadius: barMaxRadius(stock) * 2, requestedCellSize: 0.1,
  }
  const rough = generateRotaryRough('flanged shoulder rough', stepped(stock, [
    { along: 20, radius: 6 },
    { along: 80, radius: 6 },
    { along: 80, radius: 12 },
    { along: 120, radius: 12 },
    { along: 120, radius: 6 },
    { along: 180, radius: 6 },
  ]), stock, tool, { ...params, stepdown: 2, passDirection: 'around' }, {})
  const project = projectFor(stock, { type: 'flat_endmill', diameter: 4 } as Case)
  const cutter = cutterFor({ type: 'flat_endmill', diameter: 4 } as Case)
  const state = createSquareSweepState(
    stock,
    2,
    squareMaterialAlongRange(stock, [{ moves: rough.moves, radius: 2 }]),
  )
  const roughOp = {
    ...defaultOperationForTarget(project, 'rotary_rough', 'rough', { source: 'stock' }, 0),
    rotaryPassDirection: 'around' as const, stepdown: 2, stockToLeaveRadial: 0,
  }
  const verdict = guardSquareOperation(state, {
    operation: roughOp, moves: rough.moves, cutter, entryAngle: 0, direction: 1,
    travelZ: travelZ(stock), roundingAllowance: 0.0005,
  })
  assert.deepEqual(verdict, { admitted: false, reason: 'turn' },
    'the guard refuses the rough that takes more than one stepdown at the flange shoulder')
  console.log('  flanged shoulder rough: refused, as the conservative guard requires')
}

console.log('Testing seeded retained-end variants...')
{
  /** Deterministic generator so the variant set is the same every run. */
  let state = 0x1045_0007
  const random = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
  const between = (low: number, high: number): number => low + (high - low) * random()
  const variants: Case[] = []
  for (let seed = 0; seed < 6; seed++) {
    const side = Math.round(between(16, 40))
    const length = Math.round(between(120, 400))
    const ends = Math.round(between(10, Math.min(60, length / 4)))
    const diameter = [2, 3, 4, 6][seed % 4]
    const type = seed % 2 === 0 ? 'ball_endmill' as const : 'flat_endmill' as const
    const stock = squareStock(side, length, 'x', { x: 0, y: 0 })
    const bounds = getStockBounds(stock)
    const lower = stock.axis === 'x' ? bounds.minX : bounds.minY
    const upper = stock.axis === 'x' ? bounds.maxX : bounds.maxY
    const alongStart = lower + ends
    const alongEnd = upper - ends
    // A coaxial round part at every seed. A square prism's corners stand above
    // the layer tops and the generator's raised shelf over that shoulder is a
    // real overcut the conservative guard refuses (see the flanged block above),
    // not a retained-end case this test is about.
    const model = cylinder(stock, Math.round(side * 0.22), alongStart + 2, alongEnd - 2)
    variants.push({
      label: `variant ${seed} ${side}x${length} ends ${ends} D${diameter} ${type}`,
      stock,
      model,
      type,
      diameter,
      stepdown: [1.5, 2, 2.5][seed % 3],
      stepover: Math.max(1, diameter * 0.6),
      sampleSpacing: 1,
      alongStart,
      alongEnd,

    })
  }
  for (const entry of variants) runCase(entry)
}

function runCase(entry: Case): void {
  const { stock } = entry
  const tool = normalizedTool(entry.type, entry.diameter)
  const params = {
    stepover: entry.stepover,
    sampleSpacing: entry.sampleSpacing,
    stockToLeave: 0,
    alongStart: entry.alongStart,
    alongEnd: entry.alongEnd,
    safeRadius: barMaxRadius(stock) * 2,
    requestedCellSize: 0.1,
  }
  const rough = generateRotaryRough(`${entry.label} rough`, entry.model, stock, tool, {
    ...params, stepdown: entry.stepdown, passDirection: 'around',
  }, {})
  const finish = generateRotaryFinish(`${entry.label} finish`, entry.model, stock, tool, {
    ...params, passDirection: 'around', squareRoughBefore: true,
  }, {})
  assert.ok(rough.moves.length > 0, `${entry.label}: the rough emits motion`)
  assert.ok(finish.moves.length > 0, `${entry.label}: the finish emits motion`)
  const project = projectFor(stock, entry)
  const cutter = cutterFor(entry)
  const travel = travelZ(stock)
  const state = createSquareSweepState(
    stock,
    entry.diameter / 2,
    squareMaterialAlongRange(stock, [
      { moves: rough.moves, radius: entry.diameter / 2 },
      { moves: finish.moves, radius: entry.diameter / 2 },
    ]),
  )
  const roughOp = {
    ...defaultOperationForTarget(project, 'rotary_rough', 'rough', { source: 'stock' }, 0),
    rotaryPassDirection: 'around' as const, stepdown: entry.stepdown, stockToLeaveRadial: 0,
  }
  const finishOp = {
    ...defaultOperationForTarget(project, 'rotary_finish', 'finish', { source: 'stock' }, 1),
    rotaryPassDirection: 'around' as const, stockToLeaveRadial: 0,
  }
  const roughVerdict = guardSquareOperation(state, {
    operation: roughOp, moves: rough.moves, cutter, entryAngle: 0, direction: 1,
    travelZ: travel, roundingAllowance: 0.0005,
  })
  assert.deepEqual(roughVerdict, { admitted: true }, `${entry.label}: the guard admits the rough`)
  const finishVerdict = guardSquareOperation(state, {
    operation: finishOp, moves: finish.moves, cutter, entryAngle: 360, direction: 1,
    travelZ: travel, roundingAllowance: 0.0005,
  })
  assert.deepEqual(finishVerdict, { admitted: true }, `${entry.label}: the guard admits the finish`)
  const excess = worstPerSampleDrop(rough, stock, entry.stepdown)
  assert.ok(excess <= 1e-6,
    `${entry.label}: no layer takes more than one stepdown (worst ${excess.toFixed(6)} mm over)`)
  console.log(`  ${entry.label}: rough ${rough.moves.length} moves, finish ${finish.moves.length} moves, `
    + `worst per-sample drop ${excess.toFixed(6)} mm`)
}

console.log('engine/gcode/squareRetainedEndOvercut.test.ts: all assertions passed')
