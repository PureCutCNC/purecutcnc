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
 * #1098: along-the-bar rotary rough layers alternate the direction of their
 * angle sequence instead of adding a full turn per layer.
 *
 * The pre-#1098 generator ran every layer's angles in ascending order and set
 * `angle = angles[pass] + (layer - 1) * 360`, so A grew without bound (a
 * 10-layer rough ended near A3600). Each layer now starts where the previous one
 * ended and runs back the other way; A stays inside [0, 360] for the whole
 * program, and the along direction alternates across the layer boundary too so
 * no traverse separates two layers.
 *
 * What must not change: the set of cut points. The canonical cut-set hash below
 * was captured from the same fixtures before the change (every cut endpoint as
 * `z|angle|along`, sorted and hashed), so a dropped, added or moved cut fails
 * even though the order and direction now differ. Layers, depths and passes are
 * otherwise unchanged.
 *
 * Mutations this file is written to catch: restoring `(layer - 1) * 360` pushes
 * max A past 360; running both layers in the same direction breaks the
 * alternation; inserting an extra full turn between layers breaks both the
 * [0, 360] bound and the cut-set identity.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { roundStock } from '../../types/project'
import type { BarStock } from '../../types/project'
import { barCentre, barMaxRadius, barPivotZ, squareStock } from '../../types/barStock'
import { generateRotaryRough } from './rotaryModel'
import type { RotaryModelMesh } from './rotaryModel'
import type { NormalizedTool, ToolpathMove } from './types'

const FLAT: NormalizedTool = {
  id: 'flat-4', name: '4 mm flat', sourceUnits: 'mm', units: 'mm',
  type: 'flat_endmill', diameter: 4, radius: 2, vBitAngle: null,
  flutes: 2, material: 'carbide', defaultRpm: 0, defaultFeed: 0,
  defaultPlungeFeed: 0, defaultStepdown: 0, defaultStepover: 0, maxCutDepth: 0,
}

const PARAMS = {
  stepover: 2, sampleSpacing: 0.5, stepdown: 1.5, stockToLeave: 0,
  alongStart: 6, alongEnd: 54, safeRadius: 26, requestedCellSize: 0.1,
  passDirection: 'along' as const,
}

/** A coaxial surface of revolution: radius 4 at the ends, 6.17 in the middle. */
function lathe(stock: BarStock): RotaryModelMesh {
  const centre = barCentre(stock)
  const radius = stock.thickness / 2
  const positions: number[] = []
  const index: number[] = []
  const steps = 26
  const segments = 64
  const alongStart = 4
  const alongEnd = 56
  for (let s = 0; s <= steps; s++) {
    const along = alongStart + (alongEnd - alongStart) * s / steps
    const r = 4 + Math.abs(along - 30) / 12
    for (let j = 0; j < segments; j++) {
      const t = 2 * Math.PI * j / segments
      const across = centre + r * Math.cos(t)
      const up = radius + r * Math.sin(t)
      if (stock.axis === 'x') positions.push(along, across, up)
      else positions.push(across, along, up)
    }
  }
  for (let s = 0; s < steps; s++) {
    for (let j = 0; j < segments; j++) {
      const j2 = (j + 1) % segments
      const a = s * segments + j
      const b = s * segments + j2
      const c = (s + 1) * segments + j2
      const d = (s + 1) * segments + j
      index.push(a, b, c, a, c, d)
    }
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

const baseAngle = (a: number): number => Math.round((((a % 360) + 360) % 360) * 1e6) / 1e6
const alongOf = (stock: BarStock, point: { x: number; y: number }): number =>
  stock.axis === 'x' ? point.x : point.y

/**
 * Canonical identity of every cut endpoint: height, physical angle and along
 * position. It ignores kind, order and direction, which is exactly what #1098
 * is allowed to change. The hashes were captured from the pre-#1098 generator
 * on these fixtures.
 */
function cutSetHash(stock: BarStock, moves: readonly ToolpathMove[]): string {
  const keys = new Set<string>()
  for (const move of moves) {
    if (move.kind !== 'cut') continue
    for (const point of [move.from, move.to]) {
      if (point.a === undefined) continue
      keys.add(`${point.z.toFixed(6)}|${baseAngle(point.a).toFixed(6)}|${alongOf(stock, point).toFixed(6)}`)
    }
  }
  return createHash('sha256').update([...keys].sort().join(';')).digest('hex')
}

interface LayerRun {
  readonly first: number
  readonly last: number
  readonly direction: 1 | -1
}

/**
 * Split the program's cut endpoints into emitted layers. A layer's cut tips lie
 * in the disjoint band `[layerRadius, previousRadius)`, so the tip height still
 * identifies the layer even though A no longer does. Returns the layer runs in
 * emission order, each with the base angle it starts and ends on and the
 * monotonic direction of its angle sequence.
 */
function layerRuns(
  stock: BarStock,
  moves: readonly ToolpathMove[],
  lowest: number,
  layers: number,
): LayerRun[] {
  const pivot = barPivotZ(stock)
  const maxRadius = barMaxRadius(stock)
  const layerOf = (tip: number): number => {
    for (let layer = 1; layer <= layers; layer++) {
      const previous = maxRadius - (layer - 1) * PARAMS.stepdown
      const layerRadius = Math.max(lowest, maxRadius - layer * PARAMS.stepdown)
      if (tip >= layerRadius - 1e-6 && tip < previous - 1e-9) return layer - 1
    }
    return -1
  }
  const anglesByLayer: number[][] = Array.from({ length: layers }, () => [])
  for (const move of moves) {
    if (move.kind !== 'cut' || move.to.a === undefined) continue
    const layer = layerOf(move.to.z - pivot)
    if (layer < 0) continue
    const angles = anglesByLayer[layer]
    const angle = baseAngle(move.to.a)
    if (angles.length === 0 || angles[angles.length - 1] !== angle) angles.push(angle)
  }
  const runs: LayerRun[] = []
  for (const angles of anglesByLayer) {
    if (angles.length === 0) continue
    assert.ok(angles.length >= 2, `every emitted layer spans at least two passes (${angles.length})`)
    let direction: 1 | -1 = 1
    for (let i = 1; i < angles.length; i++) {
      const delta = angles[i] - angles[i - 1]
      assert.ok(Math.abs(delta) > 1e-9, `a layer never revisits an angle mid-layer (${angles[i - 1]})`)
      const sign: 1 | -1 = delta > 0 ? 1 : -1
      if (i === 1) direction = sign
      else assert.equal(sign, direction, `a layer runs its angles in one direction (${angles.join(', ')})`)
    }
    runs.push({ first: angles[0], last: angles[angles.length - 1], direction })
  }
  return runs
}

/** Run the generator and all the #1098 invariants on one fixture. */
function checkFixture(label: string, stock: BarStock, expectedCuts: string): void {
  const mesh = lathe(stock)
  const pivot = barPivotZ(stock)
  const maxRadius = barMaxRadius(stock)
  const result = generateRotaryRough('layer-direction', mesh, stock, FLAT, PARAMS, {})
  assert.ok(result.moves.length > 0, `${label}: the rough generates motion`)
  assert.deepEqual(result.warnings, [], `${label}: no warnings`)

  // 1. A never leaves the first turn.
  const angles = result.moves
    .flatMap((move) => [move.from.a, move.to.a])
    .filter((angle): angle is number => angle !== undefined)
  assert.ok(angles.length > 0, `${label}: every move carries A`)
  assert.ok(Math.min(...angles) >= 0, `${label}: min A stays at or above 0 (${Math.min(...angles)})`)
  assert.ok(Math.max(...angles) <= 360, `${label}: max A stays at or below 360 (${Math.max(...angles)})`)

  // 2. The same cut points as before the change.
  assert.equal(cutSetHash(stock, result.moves), expectedCuts, `${label}: the set of cuts is unchanged`)

  // 3. At least three layers, alternating direction, each starting where the
  // previous one ended.
  const cutTips = result.moves
    .filter((move) => move.kind !== 'rapid')
    .map((move) => move.to.z - pivot)
    .filter((tip) => tip <= maxRadius + 1e-9)
  const lowest = Math.min(...cutTips)
  const layers = Math.ceil((maxRadius - lowest) / PARAMS.stepdown)
  assert.ok(layers >= 3, `${label}: at least three layers (${layers})`)
  const runs = layerRuns(stock, result.moves, lowest, layers)
  assert.ok(runs.length >= 3, `${label}: at least three layers emit cuts (${runs.length})`)
  for (let i = 0; i < runs.length; i++) {
    const expected: 1 | -1 = i % 2 === 0 ? 1 : -1
    assert.equal(runs[i].direction, expected,
      `${label}: layer ${i + 1} runs ${expected === 1 ? 'up' : 'down'} the angle sequence`)
    if (i > 0 && stock.shape === 'round') {
      assert.equal(runs[i].first, runs[i - 1].last,
        `${label}: layer ${i + 1} starts where layer ${i} ended (${runs[i].first})`)
    }
  }
}

checkFixture('round', roundStock(40, 60), '29a416445e5a41cb233e44aaa984ca0dc66133715dfc8886325d5270a72bfc43')
checkFixture('square', squareStock(20, 60), 'ae1cf3b0760592ae5736efe60fbef4ab34f77c1683d39acf653f7601372f69b3')

console.log('engine/toolpaths/rotaryLayerDirection.test.ts: all assertions passed')
