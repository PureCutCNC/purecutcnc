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
 * #1258: the continuous helix's exact reads cost what their own poses need,
 * and give exactly what they gave before.
 *
 * Three changes make the reads cheaper, and none of them may move a toolpath:
 *
 * - **A** an exact read at wanted positions visits only the facets whose span
 *   along the bar meets its stretch (a per-mesh along index), instead of testing
 *   every candidate facet at the angle;
 * - **B** a ball's read skips a facet whose nearest point is so far from the
 *   pose that it cannot lift the tip above the best one found;
 * - **C** a roughing layer's helix proves a pose sits at the layer radius from a
 *   bound that does not depend on the angle, and then only checks that some
 *   facet is under the tool.
 *
 * A tip is a maximum, so visiting fewer facets is safe exactly when every facet
 * left out could not have been the maximum, and a missing one is a gouge no
 * other test would see. So the outputs are **pinned**: the digests below were
 * captured from the implementation at `468dba89`, before #1258 changed any
 * engine line, and each change must reproduce them byte for byte -- the exact
 * rows and their reported work at wanted positions, and whole roughs and
 * finishes with the helix on, on a round bar and a square blank, for a ball and
 * a flat.
 *
 * The fixtures are built to reach every way a facet could be lost: a lumpy,
 * twisted turned body with fine facets; a rail of two facets running its whole
 * length (longer than any bin, so it sits on the index's long list); splinters
 * shorter than a tenth of a millimetre standing proud of the surface; an end
 * cap meeting the axis (the plan's `always` list); a facet wide enough to sit in
 * both buckets of a turn (listed twice, so counted twice in the work); a gap
 * along the bar where no facet is under the tool; and wanted positions off both
 * ends and on the gap.
 *
 * Run with: npx tsx src/engine/toolpaths/rotaryHelixReadCost.test.ts
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { barCentre, barMaxRadius, barPivotZ, squareStock } from '../../types/barStock'
import { roundStock } from '../../types/project'
import type { BarStock } from '../../types/project'
import { generateRotaryFinish, generateRotaryRough } from './rotaryModel'
import { createRotarySamplingPrep, rotaryExactStretchWork, sampleAnglesWithPrep } from './rotarySampling'
import type { RotaryModelMesh } from './rotarySampling'
import type { NormalizedTool, ToolpathResult } from './types'

function toolOf(type: 'ball_endmill' | 'flat_endmill', radius: number): NormalizedTool {
  return {
    id: 't1', name: 't1', sourceUnits: 'mm', units: 'mm', type,
    diameter: radius * 2, radius, vBitAngle: null, flutes: 2, material: 'carbide',
    defaultRpm: 0, defaultFeed: 0, defaultPlungeFeed: 0, defaultStepdown: 0,
    defaultStepover: 0, maxCutDepth: 0,
  }
}

/** A deterministic generator, so the fixture is the same on every run. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A lumpy, twisted turned body from 6 to 34 along the bar -- or, with `gap`, two
 * such bodies, 6..18.5 and 21.5..34, with nothing between them, so a pose there
 * has no facet under the tool. `hostile` adds a rail the whole length and
 * splinters: the read's worst cases, which also make most helix bands
 * unverifiable, so the whole-operation cases leave them out.
 */
function fixtureMesh(stock: BarStock, gap: boolean, hostile = true): RotaryModelMesh {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const positions: number[] = []
  const index: number[] = []
  const point = (along: number, radius: number, angle: number): number => {
    const across = centre + radius * Math.cos(angle)
    const up = pivot + radius * Math.sin(angle)
    if (stock.axis === 'x') positions.push(along, across, up)
    else positions.push(across, along, up)
    return positions.length / 3 - 1
  }
  const body = (from: number, to: number, rings: number, sides: number, phase: number): void => {
    const first = positions.length / 3
    for (let r = 0; r < rings; r++) {
      const u = r / (rings - 1)
      const along = from + (to - from) * u
      for (let j = 0; j < sides; j++) {
        const t = phase + 0.9 * u + 2 * Math.PI * j / sides
        point(along, 6 * (1 - 0.25 * u) + 0.6 * Math.sin(7 * u + phase) + 0.4 * Math.cos(3 * t), t)
      }
    }
    for (let r = 0; r + 1 < rings; r++) {
      for (let j = 0; j < sides; j++) {
        const next = (j + 1) % sides
        const a = first + r * sides + j
        const b = first + r * sides + next
        const c = first + (r + 1) * sides + next
        const d = first + (r + 1) * sides + j
        index.push(a, b, c, a, c, d)
      }
    }
  }
  if (gap) {
    body(6, 18.5, 40, 36, 0)
    body(21.5, 34, 40, 36, 1.3)
  } else {
    body(6, 34, 80, 36, 0)
  }
  if (!hostile) return { positions: new Float32Array(positions), index: new Uint32Array(index) }
  // The rail: a strip standing proud of the bodies along their whole length.
  const r0 = point(6, 7.3, 1.0)
  const r1 = point(34, 6.0, 1.0)
  const r2 = point(34, 6.0, 1.1)
  const r3 = point(6, 7.3, 1.1)
  index.push(r0, r1, r2, r0, r2, r3)
  // An end cap meeting the axis, which every turn's strip reaches, so its facets
  // are on the plan's `always` list.
  const hub = point(6, 0, 0)
  for (let k = 0; k < 12; k++) {
    index.push(hub, point(6, 4, (2 * Math.PI * k) / 12), point(6, 4, (2 * Math.PI * (k + 1)) / 12))
  }
  // A wide facet inside the body, 140 degrees around the axis and clear of it:
  // with the strip's reach on both sides its arc of turns passes half a turn,
  // so some turns list it in both the near and the far bucket.
  index.push(point(14, 4, 0), point(16, 4, (70 * Math.PI) / 180), point(15, 4, (140 * Math.PI) / 180))
  // An open half-shell past the body's end, under half the turn only: at a
  // turn that puts it underneath, the only facets under a pose are on the far
  // side of the bar.
  const shell = positions.length / 3
  for (let r = 0; r < 6; r++) {
    for (let j = 0; j <= 12; j++) point(34.5 + 0.5 * r, 5, Math.PI + (Math.PI * j) / 12)
  }
  for (let r = 0; r + 1 < 6; r++) {
    for (let j = 0; j < 12; j++) {
      const a = shell + r * 13 + j
      const b = a + 1
      const c = b + 13
      const d = a + 13
      index.push(a, b, c, a, c, d)
    }
  }
  // Splinters: tiny facets standing on the bodies.
  const random = mulberry32(1258)
  for (let k = 0; k < 40; k++) {
    const along = 6.5 + 27 * random()
    if (gap && along > 18.3 && along < 21.7) continue
    const angle = 2 * Math.PI * random()
    const a = point(along, 6.6, angle)
    const b = point(along + 0.04, 6.6, angle + 0.004)
    const c = point(along + 0.02, 6.9, angle + 0.002)
    index.push(a, b, c)
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

const roundX = roundStock(24, 40, 'x')
const roundY = roundStock(24, 40, 'y')
const squareX = squareStock(24, 40, 'x', { x: 0, y: 0 })

function sha(parts: readonly (Float32Array | string)[]): string {
  const hash = createHash('sha256')
  for (const part of parts) {
    if (typeof part === 'string') hash.update(part)
    else hash.update(new Uint8Array(part.buffer, part.byteOffset, part.byteLength))
  }
  return hash.digest('hex')
}

function movesDigest(result: ToolpathResult): string {
  const point = (value: { x: number; y: number; z: number; a?: number }): string =>
    [value.x, value.y, value.z, value.a ?? ''].join(',')
  return sha([result.moves.map((move) =>
    [move.kind, point(move.from), point(move.to), move.source ?? '', move.feedScale ?? ''].join('|')).join('\n')])
}

// ---------------------------------------------------------------------------
// 1. Exact rows at wanted positions: values, the work each row reports, and the
//    price the helix computes for the same poses.

interface RowCase {
  readonly label: string
  readonly stock: BarStock
  readonly tool: NormalizedTool
  readonly exactTipPad?: number
  readonly digest: string
}

const ROW_ANGLES = Array.from({ length: 24 }, (_, k) => 360 * k / 24 + 3.75)

/** Wanted position sets: a helix-like spread, a single pose, the gap, both ends. */
function wantedSets(radius: number): number[][] {
  return [
    [7, 10.4, 13.8, 17.2],
    [12.3],
    [19.4, 20, 20.6],
    [4, 6 - radius, 34 + radius, 36],
    [21 + radius / 4, 25, 29.3, 33.1, 33.9],
    [35.2, 36.1, 36.8],
  ]
}

function rowCase(c: RowCase): string {
  const mesh = fixtureMesh(c.stock, true)
  const parts: (Float32Array | string)[] = []
  const radius = c.tool.radius + (c.tool.type === 'ball_endmill' ? 0 : (c.exactTipPad ?? 0))
  for (const along of wantedSets(c.tool.radius)) {
    const setup = {
      along, requestedCellSize: 0.1, conservativeCellBounds: true, exactTipRows: true,
      ...(c.exactTipPad !== undefined ? { exactTipPad: c.exactTipPad } : {}),
    }
    const prep = createRotarySamplingPrep(mesh, c.stock, c.tool, setup)
    const whole = createRotarySamplingPrep(mesh, c.stock, c.tool, setup)
    const columns = along.map((_, i) => i)
    const wanted = sampleAnglesWithPrep(prep, ROW_ANGLES, [], {}, ROW_ANGLES.map(() => columns))
    const full = sampleAnglesWithPrep(whole, ROW_ANGLES, [])
    assert.ok(wanted.valid && full.valid, `${c.label}: the rows sample`)
    for (let k = 0; k < ROW_ANGLES.length; k++) {
      const price = rotaryExactStretchWork(prep, ROW_ANGLES[k], along, radius)
      const row = sampleAnglesWithPrep(prep, [ROW_ANGLES[k]], [], {}, [columns])
      assert.equal(row.rasterWork, price, `${c.label} A${ROW_ANGLES[k]}: a wanted read's work is its price`)
      for (let i = 0; i < along.length; i++) {
        assert.ok(Object.is(wanted.tipRadius[k][i], full.tipRadius[k][i]),
          `${c.label} A${ROW_ANGLES[k]} X${along[i]}: the wanted read is the whole row's value`)
      }
      parts.push(`${price};`)
    }
    for (const row of wanted.tipRadius) parts.push(row)
    // C: a position read only for coverage is finite exactly where the full read
    // is, and never above it (it is a real contact, not the maximum). A capture
    // run measures the code before #1258, which has no coverage read.
    if (capture) continue
    const covered = sampleAnglesWithPrep(prep, ROW_ANGLES, [], {}, ROW_ANGLES.map(() => []), ROW_ANGLES.map(() => columns))
    for (let k = 0; k < ROW_ANGLES.length; k++) {
      for (let i = 0; i < along.length; i++) {
        const value = covered.tipRadius[k][i]
        const exact = full.tipRadius[k][i]
        assert.equal(Number.isFinite(value), Number.isFinite(exact),
          `${c.label} A${ROW_ANGLES[k]} X${along[i]}: coverage is the full read's (${value} vs ${exact})`)
        if (Number.isFinite(exact)) {
          assert.ok(value <= exact, `${c.label} A${ROW_ANGLES[k]} X${along[i]}: a covered value is never above the exact one`)
        }
      }
    }
  }
  return sha(parts)
}

const ROW_CASES: RowCase[] = [
  { label: 'round X, 1 mm ball', stock: roundX, tool: toolOf('ball_endmill', 1), digest: '924b8c79eb842be18993e7c0a5b84bde8c305c65de292ae0c6cbf2e6ab46f65f' },
  { label: 'round Y, 0.4 mm ball', stock: roundY, tool: toolOf('ball_endmill', 0.4), digest: '1cc0ec8a7f0fc753cd0de09fc8fff2e13d73beee17f6b932da928e810e2b5d71' },
  { label: 'round X, 1.5 mm flat with a pad', stock: roundX, tool: toolOf('flat_endmill', 1.5), exactTipPad: 0.125, digest: 'eca1613c7b07c0db777353e6a96dfde2b09ff0b69d610a126f1f3b30249a309f' },
  { label: 'square X, 2 mm ball', stock: squareX, tool: toolOf('ball_endmill', 2), digest: '3e25e1cf9a648a10c764edfadaa2333bf583fc28a7d605bfb3ae69b2a5336a28' },
]

// ---------------------------------------------------------------------------
// 2. Whole operations with the helix on: rough layers (bounded and exact poses,
//    the gap, a deeper layer reusing an outer layer's rows) and finishes.

interface OperationCase {
  readonly label: string
  readonly kind: 'rough' | 'finish'
  readonly stock: BarStock
  readonly tool: NormalizedTool
  /** The two-body fixture: every band across the gap meets a pose with nothing under it. */
  readonly gap?: boolean
  readonly digest: string
}

/**
 * Cut moves inside a helix: an unbroken run of cuts that turn A and advance
 * along the bar at once, over at least a whole turn. A ring-to-ring link moves
 * both too, but over a few degrees, so it is not counted.
 */
function helixMoves(result: ToolpathResult, stock: BarStock): number {
  let helix = 0
  let runMoves = 0
  let runTurn = 0
  const close = (): void => {
    if (runTurn >= 360 - 1e-6) helix += runMoves
    runMoves = 0
    runTurn = 0
  }
  for (const move of result.moves) {
    const along = stock.axis === 'x' ? move.to.x - move.from.x : move.to.y - move.from.y
    const turn = (move.to.a ?? 0) - (move.from.a ?? 0)
    if (move.kind !== 'cut' || turn === 0 || along === 0) {
      close()
      continue
    }
    runMoves++
    runTurn += Math.abs(turn)
  }
  close()
  return helix
}

function operationCase(c: OperationCase): { digest: string; helix: number; cuts: number } {
  const mesh = fixtureMesh(c.stock, c.gap === true, false)
  const common = {
    stepover: c.kind === 'rough' ? 1.6 : 0.8,
    sampleSpacing: c.kind === 'rough' ? c.tool.radius / 2 : c.tool.radius / 4,
    // A rough band reaching past the model's ends meets poses with nothing under
    // the tool and is refused whole, so the rough stays inside the model.
    alongStart: c.kind === 'rough' ? 7 : 2, alongEnd: c.kind === 'rough' ? 33 : 38,
    safeRadius: barMaxRadius(c.stock) + 2,
    requestedCellSize: 0.1, passDirection: 'around' as const, continuousHelix: true,
  }
  const result = c.kind === 'rough'
    ? generateRotaryRough('rough', mesh, c.stock, c.tool, { ...common, stockToLeave: 0.3, stepdown: 1.5 }, {})
    : generateRotaryFinish('finish', mesh, c.stock, c.tool, { ...common, stockToLeave: 0 }, {})
  const cuts = result.moves.filter((move) => move.kind === 'cut').length
  return { digest: movesDigest(result), helix: helixMoves(result, c.stock), cuts }
}

const OPERATION_CASES: OperationCase[] = [
  { label: 'round X rough, 1 mm ball', kind: 'rough', stock: roundX, tool: toolOf('ball_endmill', 1), digest: 'a3f8a6881a76198cbdb544ab90245dd153558f70dd8c229d6bca297abe63cacb' },
  { label: 'square X rough, 1 mm ball', kind: 'rough', stock: squareX, tool: toolOf('ball_endmill', 1), digest: '14e10408dd91c408e61645c92dff6297bb4cd9728de6bfbbcb3a67c3c9e49555' },
  { label: 'round X rough across a gap, 1 mm ball', kind: 'rough', stock: roundX, tool: toolOf('ball_endmill', 1), gap: true, digest: '77f39d12eee4049df7e0e3b8d861b2a7b6b5449622a2c2dc881a60175683c78a' },
  { label: 'round X finish, 0.5 mm ball', kind: 'finish', stock: roundX, tool: toolOf('ball_endmill', 0.5), digest: '584e46b893b7de41aeee81a53102447c433c529b0966bcf2ccc6601c1c76ed29' },
  { label: 'square X finish, 0.5 mm ball', kind: 'finish', stock: squareX, tool: toolOf('ball_endmill', 0.5), digest: '668271d19fe7343dbe179a7410af26599b376ffea464feec6249b54828e35a21' },
  { label: 'round Y finish, 1 mm flat', kind: 'finish', stock: roundY, tool: toolOf('flat_endmill', 1), digest: '804d78e5a932a7b0718e360bc95eda81fcaa639e7425b7a3c9450b306a259e62' },
]

const capture = process.argv.includes('--capture')
for (const c of ROW_CASES) {
  const digest = rowCase(c)
  if (capture) console.log(`  row ${c.label}: ${digest}`)
  else assert.equal(digest, c.digest, `${c.label}: the exact rows and their work are the ones read before #1258`)
}
for (const c of OPERATION_CASES) {
  const actual = operationCase(c)
  if (capture) console.log(`  op ${c.label}: ${actual.digest} (${actual.helix} helix of ${actual.cuts} cuts)`)
  else {
    if (c.gap !== true) assert.ok(actual.helix > 0, `${c.label}: the fixture cuts a helix (${actual.helix} of ${actual.cuts} cuts)`)
    assert.equal(actual.digest, c.digest, `${c.label}: the toolpath is the one generated before #1258`)
    console.log(`  ${c.label}: ${actual.helix} helix of ${actual.cuts} cuts, digest ${actual.digest.slice(0, 16)}`)
  }
}

console.log('engine/toolpaths/rotaryHelixReadCost.test.ts: all assertions passed')
