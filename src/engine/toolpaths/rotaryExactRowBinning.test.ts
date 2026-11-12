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
 * #1185 slice X1: the exact footprint read does less work per ring position and
 * reads exactly the rows it read before.
 *
 * Since #1177 a ball's ring grid on a round bar reads every sample as the exact
 * footprint maximum (`exactFootprintTips`), and the round-stock bust took about
 * 2.5 minutes per operation through the worker pool against 12 s for the same
 * model in a square blank. Three things in the read cost that, and none of them
 * was the contact arithmetic itself:
 *
 * - every candidate facet of the angle was tested against every ring position.
 *   The row now files its candidates in bins along the bar once, and a position
 *   reads the bins its footprint can reach plus the facets longer than a bin;
 * - a facet under the footprint was put through the full contact arithmetic
 *   even when it lay wholly below the tip already found -- the whole underside
 *   of the model, for one. A facet whose highest point is below the best tip so
 *   far is now skipped;
 * - two helper functions were made afresh on every call (one per ring position,
 *   one per facet). They are made once.
 *
 * A row's value is a maximum over the facets under the footprint, so the order
 * they are visited in cannot change it; the bins and the skip only decide which
 * facets are *left out*, and leaving out one that belongs is the whole risk. So
 * the rows are pinned: the digests below were captured from the implementation
 * at `c1002cdf`, before this slice, on fixtures built to put a facet everywhere
 * one could be lost -- facets far longer than a bin (a rail the length of the
 * model), facets shorter than one, splinters standing proud of the surface,
 * positions given out of order, positions off both ends of the model, and
 * positions exactly on a bin edge, for a ball and a flat, on both bar axes.
 *
 * Mutations these digests catch (each was applied and seen to fail):
 *  - not reaching back a bin for a facet that starts before the footprint;
 *  - stopping the bins short of the footprint's high edge;
 *  - dropping the long-facet list, or filing a long facet in one bin only;
 *  - sizing the reach from half the cutter radius;
 *  - binning on the turned across coordinate instead of the along coordinate;
 *  - dropping facets by a narrower across test than the read itself applies;
 *  - taking a facet's lowest point, or its first corner, as its top;
 *  - skipping a facet whose top is within 0.02 of the best tip;
 *  - a wrong term in the hoisted containment test or edge contact;
 *  - dropping either root of the ball's edge tangency, or either crossing of
 *    the flat's edge with the footprint.
 *
 * Not distinguished, by design:
 *  - the read takes one further bin on each side as an allowance for rounding
 *    in the bin arithmetic; removing either changes no digest, because it
 *    covers a last-bit case and not a geometric one;
 *  - the ball's two rim candidates (#1177, unchanged here) never decide a row
 *    on these fixtures: a sphere's contact along an edge peaks at a tangency
 *    inside the footprint, not on its rim.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { barCentre, barPivotZ, squareStock } from '../../types/barStock'
import { roundStock } from '../../types/project'
import type { BarStock } from '../../types/project'
import { createRotarySamplingPrep, sampleAnglesWithPrep } from './rotarySampling'
import type { RotaryModelMesh } from './rotarySampling'
import type { NormalizedTool } from './types'

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
 * A twisted, lumpy turned body from 12 to 28 with fine facets, a **rail** of two
 * facets running its whole length (far longer than any bin), and a handful of
 * splinters shorter than a tenth of a millimetre.
 */
function fixtureMesh(stock: BarStock): RotaryModelMesh {
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
  const sides = 36
  const rings = 61
  for (let r = 0; r < rings; r++) {
    const u = r / (rings - 1)
    const along = 12 + 16 * u
    for (let j = 0; j < sides; j++) {
      const t = 0.9 * u + 2 * Math.PI * j / sides
      point(along, 5 * (1 - 0.25 * u) + 0.5 * Math.sin(7 * u) + 0.3 * Math.cos(3 * t), t)
    }
  }
  for (let r = 0; r + 1 < rings; r++) {
    for (let j = 0; j < sides; j++) {
      const next = (j + 1) % sides
      const a = r * sides + j
      const b = r * sides + next
      const c = (r + 1) * sides + next
      const d = (r + 1) * sides + j
      index.push(a, b, c, a, c, d)
    }
  }
  // The rail: a strip standing proud of the body along its whole length.
  const r0 = point(12, 6.4, 1.0)
  const r1 = point(28, 6.1, 1.0)
  const r2 = point(28, 6.1, 1.12)
  const r3 = point(12, 6.4, 1.12)
  index.push(r0, r1, r2, r0, r2, r3)
  // Splinters: tiny facets standing on the body, each inside one bin.
  const random = mulberry32(1185)
  for (let k = 0; k < 40; k++) {
    const along = 12.5 + 15 * random()
    const angle = 2 * Math.PI * random()
    const a = point(along, 6.0, angle)
    const b = point(along + 0.04, 6.0, angle + 0.004)
    const c = point(along + 0.02, 6.3, angle + 0.002)
    index.push(a, b, c)
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

/** Ring positions in no particular order: off both ends, on the ends, and dense in between. */
function alongPositions(radius: number): number[] {
  const random = mulberry32(77)
  const positions = [5, 35, 12, 28, 12 - radius, 28 + radius, 12 - radius - 0.001, 28 + radius + 0.001, 20]
  // Positions one footprint apart land on the bins' own edges.
  for (let k = 0; k < 12; k++) positions.push(12 + k * radius)
  for (let k = 0; k < 130; k++) positions.push(10.5 + 19 * random())
  return positions
}

const ANGLES = Array.from({ length: 48 }, (_, k) => 360 * k / 48)

interface Case {
  readonly label: string
  readonly stock: BarStock
  readonly tool: NormalizedTool
  readonly exactTipPad?: number
  readonly digest: string
}

function rowsDigest(c: Case): { digest: string; finite: number; empty: number } {
  const prep = createRotarySamplingPrep(fixtureMesh(c.stock), c.stock, c.tool, {
    along: alongPositions(c.tool.radius),
    requestedCellSize: 0.1,
    conservativeCellBounds: true,
    exactTipRows: true,
    ...(c.exactTipPad !== undefined ? { exactTipPad: c.exactTipPad } : {}),
  })
  const sampled = sampleAnglesWithPrep(prep, ANGLES, [])
  assert.ok(sampled.valid, `${c.label}: the rows sample`)
  const hash = createHash('sha256')
  let finite = 0
  let empty = 0
  for (const row of sampled.tipRadius) {
    hash.update(new Uint8Array(row.buffer, row.byteOffset, row.byteLength))
    for (const value of row) {
      if (Number.isFinite(value)) finite++
      else empty++
    }
  }
  return { digest: hash.digest('hex'), finite, empty }
}

const roundX = roundStock(20, 40, 'x')
const roundY = roundStock(20, 40, 'y')
const squareX = squareStock(20, 40, 'x', { x: 0, y: 0 })

const CASES: Case[] = [
  { label: 'round X, 1 mm ball', stock: roundX, tool: toolOf('ball_endmill', 1), digest: 'becc0b04da56656569ef974b6a11483eeaa566846bfaa7b8d7cf902f81129b7f' },
  { label: 'round Y, 0.4 mm ball', stock: roundY, tool: toolOf('ball_endmill', 0.4), digest: '5f3bca3e625b0366601714d7ea98b2acdd5a7a6be13d468281166b7eae77d7c4' },
  { label: 'round X, 1.5 mm flat', stock: roundX, tool: toolOf('flat_endmill', 1.5), digest: '9cb57029cffbd0394d9505e4c9bf46be8ec676e8d1a8f358bae387be5f1f876a' },
  { label: 'round Y, 0.5 mm flat with a pad', stock: roundY, tool: toolOf('flat_endmill', 0.5), exactTipPad: 0.125, digest: 'c7ee89bafb3a07c8718f1a9b4eef5ae38f49d9a5d5ae160bf221c3d480c519e8' },
  { label: 'square X, 3 mm ball', stock: squareX, tool: toolOf('ball_endmill', 3), digest: '7bfa3b228720cf5e0d844c6ecf7accfd93d30de7b6d7012cfa4e9dac02a8087f' },
  { label: 'round X, 0.05 mm flat', stock: roundX, tool: toolOf('flat_endmill', 0.05), digest: 'bff1bc6923a9b881b2fee0589998938b6662ea552f18b4be05c18863375cf993' },
]

for (const c of CASES) {
  const actual = rowsDigest(c)
  // The fixture has to exercise both answers: a position over the model and a
  // position with nothing under the cutter, which a bin must not invent.
  assert.ok(actual.finite > 0 && actual.empty > 0, `${c.label}: ${actual.finite} read and ${actual.empty} empty samples`)
  assert.equal(actual.digest, c.digest, `${c.label}: the exact rows are the rows the read gave before it was binned`)
  console.log(`  ${c.label}: ${actual.finite} read, ${actual.empty} empty, digest ${actual.digest.slice(0, 16)}`)
}

console.log('engine/toolpaths/rotaryExactRowBinning.test.ts: all assertions passed')
