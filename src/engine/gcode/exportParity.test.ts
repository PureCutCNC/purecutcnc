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
 * `compareExportedToInternal` (issue #1261): segmentation and arc fitting are
 * not deviations; a moved, missing or extra cut is; a wrong feed (a dropped
 * `feedScale`, the #1264 bug) is; the comparison runs in the stock frame for a
 * turning move; and a read-back that is not verified is never a verdict.
 * The spatial grid is checked against a plain scan.
 *
 * Run with: npx tsx src/engine/gcode/exportParity.test.ts
 */

import { roundStock } from '../../types/project'
import type { ToolpathMove, ToolpathPoint } from '../toolpaths/types'
import { arcChordSagitta } from '../toolpaths/arcReconstruction'
import { compareExportedToInternal } from './exportParity'
import type { ExportParityOptions } from './exportParity'
import type { ExportedToolpathMove } from './exportedMotion'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const OPTIONS: ExportParityOptions = { operationId: 'op', tolerance: 0.02, feeds: { cut: 600, plunge: 180 } }

const pt = (x: number, y: number, z: number, a?: number): ToolpathPoint => (a === undefined ? { x, y, z } : { x, y, z, a })

function withFeed(moves: ToolpathMove[]): ExportedToolpathMove[] {
  return moves.map((move) => move.kind === 'rapid'
    ? move
    : { ...move, feed: move.kind === 'plunge' ? 180 : 600 * (move.feedScale ?? 1) })
}

/** A plunge, a square and a circle of 72 chords, at Z −2. */
function internalPath(): ToolpathMove[] {
  const moves: ToolpathMove[] = [
    { kind: 'rapid', from: pt(0, 0, 5), to: pt(0, 0, 5) },
    { kind: 'plunge', from: pt(0, 0, 5), to: pt(0, 0, -2) },
    { kind: 'cut', from: pt(0, 0, -2), to: pt(40, 0, -2), feedScale: 0.5 },
    { kind: 'cut', from: pt(40, 0, -2), to: pt(40, 40, -2) },
  ]
  const at = (index: number) => pt(60 + 20 * Math.cos(index * Math.PI / 36), 20 + 20 * Math.sin(index * Math.PI / 36), -2)
  moves.push({ kind: 'cut', from: pt(40, 40, -2), to: at(0) })
  for (let index = 0; index < 72; index += 1) {
    moves.push({ kind: 'cut', from: at(index), to: at(index + 1), arcChordError: arcChordSagitta(20, Math.PI / 36) })
  }
  return moves
}

function testIdenticalAndResegmented(): void {
  console.log('Testing the same path, split and as a true circle, is verified...')
  const internal = internalPath()
  const same = compareExportedToInternal(internal, withFeed(internal), OPTIONS)
  assert(same.verdict === 'verified', `identical: ${same.verdict} ${JSON.stringify(same.deviations)}`)
  assert(same.samples.internal > 0 && same.samples.exported > 0, 'both sides were sampled')

  // Split every straight move in three and replace the chords by a finely
  // flattened true circle: the radius-20 chords sag 0.019 from the circle,
  // which their own arcChordError allows.
  const exported: ToolpathMove[] = []
  for (const move of internal.slice(0, 5)) {
    if (move.kind === 'rapid') { exported.push(move); continue }
    const lerp = (t: number) => pt(
      move.from.x + (move.to.x - move.from.x) * t, move.from.y + (move.to.y - move.from.y) * t, move.from.z + (move.to.z - move.from.z) * t,
    )
    for (let i = 0; i < 3; i += 1) exported.push({ ...move, from: lerp(i / 3), to: lerp((i + 1) / 3) })
  }
  const fine = (index: number) => pt(60 + 20 * Math.cos(index * Math.PI / 720), 20 + 20 * Math.sin(index * Math.PI / 720), -2)
  for (let index = 0; index < 1440; index += 1) exported.push({ kind: 'cut', from: fine(index), to: fine(index + 1) })
  const resegmented = compareExportedToInternal(internal, withFeed(exported), OPTIONS)
  assert(resegmented.verdict === 'verified', `resegmented: ${resegmented.verdict} ${JSON.stringify(resegmented.deviations.slice(0, 3))}`)

  // Without the chord allowance the circle is a deviation: the allowance is what admits it.
  const noAllowance = internal.map(({ arcChordError: _arcChordError, ...move }) => move)
  const strict = compareExportedToInternal(noAllowance, withFeed(exported), { ...OPTIONS, tolerance: 0.01 })
  assert(strict.verdict === 'deviation', 'a sag beyond the tolerance and with no allowance is a deviation')
}

function testMovedMissingAndExtraCuts(): void {
  console.log('Testing a moved, a missing and an extra cut are deviations...')
  const internal = internalPath()
  // One cut shifted 0.1 sideways.
  const moved = withFeed(internal).map((move, index) => index === 3
    ? { ...move, from: { ...move.from, x: move.from.x + 0.1 }, to: { ...move.to, x: move.to.x + 0.1 } }
    : move)
  const shifted = compareExportedToInternal(internal, moved, OPTIONS)
  assert(shifted.verdict === 'deviation', `moved: ${shifted.verdict}`)
  assert(shifted.deviations.some((deviation) => deviation.kind === 'extraCut' && Math.abs(deviation.distance - 0.1) < 1e-6), 'the moved cut is an extra cut 0.1 away')
  assert(shifted.deviations.some((deviation) => deviation.kind === 'missingCut'), 'and its source is missing')
  assert(Math.abs(shifted.maxDistance - 0.1) < 1e-6, `the worst distance is 0.1, got ${shifted.maxDistance}`)

  const missing = compareExportedToInternal(internal, withFeed(internal.filter((_, index) => index !== 3)), OPTIONS)
  assert(missing.verdict === 'deviation' && missing.deviations.every((deviation) => deviation.kind === 'missingCut'), 'a dropped cut is missing only')
  const location = missing.deviations[0].location
  assert(Math.abs(location.x - 40) < 1e-6 && location.y > 0 && location.y < 40, `it is reported on the dropped cut, got ${JSON.stringify(location)}`)

  // A spurious arc bulging off a straight edge (the #1253 shape).
  const bulge = withFeed([...internal, { kind: 'cut', from: pt(20, 0, -2), to: pt(20, 3, -2) }])
  const extra = compareExportedToInternal(internal, bulge, OPTIONS)
  assert(extra.verdict === 'deviation' && extra.deviations.every((deviation) => deviation.kind === 'extraCut'), 'an added cut is extra only')

  // The same cut at another Z is not the same cut.
  const deeper = withFeed(internal).map((move, index) => index === 3 ? { ...move, from: { ...move.from, z: -2.5 }, to: { ...move.to, z: -2.5 } } : move)
  assert(compareExportedToInternal(internal, deeper, OPTIONS).verdict === 'deviation', 'a cut 0.5 deeper is a deviation')
}

function testFeeds(): void {
  console.log('Testing the cut feed: feedScale, the plunge feed, the ShopBot Z speed...')
  const internal = internalPath()
  // The #1264 bug: feedScale dropped, the half-feed cut runs at full feed.
  const dropped = withFeed(internal).map((move, index) => index === 2 ? { ...move, feed: 600 } : move)
  const result = compareExportedToInternal(internal, dropped, OPTIONS)
  assert(result.verdict === 'deviation', `a dropped feedScale is a deviation, got ${result.verdict}`)
  const feed = result.deviations.find((deviation) => deviation.kind === 'feed')
  assert(feed && feed.expectedFeed === 300 && feed.actualFeed === 600, `expected 300, ran 600, got ${JSON.stringify(feed)}`)

  // A plunge at the cut feed is wrong too.
  const fastPlunge = withFeed(internal).map((move, index) => index === 1 ? { ...move, feed: 600 } : move)
  assert(compareExportedToInternal(internal, fastPlunge, OPTIONS).verdict === 'deviation', 'a plunge at the cut feed is a deviation')

  // A vertical move capped at the plunge feed (ShopBot's own Z speed) is not.
  const vertical: ToolpathMove[] = [{ kind: 'cut', from: pt(0, 0, 0), to: pt(0, 0, 5) }]
  const capped = compareExportedToInternal(vertical, [{ ...vertical[0], feed: 180 }], OPTIONS)
  assert(capped.verdict === 'verified', `a vertical cut at the Z speed is verified, got ${JSON.stringify(capped.deviations)}`)

  // Without feeds the check is skipped.
  assert(compareExportedToInternal(internal, dropped, { ...OPTIONS, feeds: null }).verdict === 'verified', 'no feeds, no feed check')
}

function testRotaryStockFrame(): void {
  console.log('Testing a turning move is compared in the stock frame...')
  const stock = roundStock(20, 100, 'x') // centreline across at y 10, pivot z 10
  const turning: ToolpathMove[] = [{ kind: 'cut', from: pt(0, 10, 18, 0), to: pt(10, 10, 18, 90) }]
  const options = { ...OPTIONS, stock, feeds: null }
  // Split in two: the same helix on the bar.
  const split: ToolpathMove[] = [
    { kind: 'cut', from: pt(0, 10, 18, 0), to: pt(5, 10, 18, 45) },
    { kind: 'cut', from: pt(5, 10, 18, 45), to: pt(10, 10, 18, 90) },
  ]
  assert(compareExportedToInternal(turning, split, options).verdict === 'verified', 'a split turning move is the same cut')
  // Two degrees more turn ends 0.28 mm away on the bar's surface (radius 8).
  const overturned: ToolpathMove[] = [{ kind: 'cut', from: pt(0, 10, 18, 0), to: pt(10, 10, 18, 92) }]
  assert(compareExportedToInternal(turning, overturned, options).verdict === 'deviation', 'a different turn is a deviation')
  // Read without the bar, a turning move's angle would be ignored and both look the same.
  assert(compareExportedToInternal(turning, overturned, { ...options, stock: null }).verdict === 'verified', 'the stock frame is what tells them apart')

  // Inverse-time feed: 600 mm/min along the stock-frame length.
  const length = Math.hypot(10, 8 * Math.PI / 2)
  const inverse: ExportedToolpathMove[] = [{ ...turning[0], inverseTimeFeed: 600 / length }]
  const feeds = { ...options, feeds: { cut: 600, plunge: 180 } }
  assert(compareExportedToInternal(turning, inverse, feeds).verdict === 'verified', 'the right inverse-time F is verified')
  const wrong: ExportedToolpathMove[] = [{ ...turning[0], inverseTimeFeed: 600 / 10 }]
  const result = compareExportedToInternal(turning, wrong, feeds)
  assert(result.verdict === 'deviation' && result.deviations[0].inverseTime === true, 'an F from the linear length alone is a deviation')
}

function testUnverified(): void {
  console.log('Testing an unverified read-back and an empty comparison are never verdicts...')
  const internal = internalPath()
  for (const status of ['unsupported', 'failed'] as const) {
    const result = compareExportedToInternal(internal, withFeed(internal), { ...OPTIONS, exportStatus: status })
    assert(result.verdict === 'unverified', `${status}: unverified`)
    assert(result.reason === (status === 'failed' ? 'exportFailed' : 'exportUnsupported'), `${status}: its reason`)
  }
  const empty = compareExportedToInternal([internal[0]], [internal[0]], OPTIONS)
  assert(empty.verdict === 'unverified' && empty.reason === 'noCutMoves', 'only rapids: nothing to compare')
  const lost = compareExportedToInternal(internal, [], OPTIONS)
  assert(lost.verdict === 'deviation' && lost.deviations[0].kind === 'missingCut', 'an export with no cut at all is a deviation')
}

function testGridMatchesScan(): void {
  console.log('Testing the spatial grid finds what a plain scan finds...')
  // A dense zig-zag and a copy with every 7th move nudged by a varying amount.
  const internal: ToolpathMove[] = []
  for (let row = 0; row < 40; row += 1) {
    internal.push({ kind: 'cut', from: pt(0, row * 0.5, -1), to: pt(30, row * 0.5, -1) })
    internal.push({ kind: 'cut', from: pt(30, row * 0.5, -1), to: pt(0, row * 0.5 + 0.5, -1) })
  }
  const nudged = internal.map((move, index) => {
    if (index % 7 !== 0) return move
    const dz = 0.005 + (index % 5) * 0.01
    return { ...move, from: { ...move.from, z: move.from.z + dz }, to: { ...move.to, z: move.to.z + dz } }
  })
  const result = compareExportedToInternal(internal, nudged, { ...OPTIONS, feeds: null, maxDeviations: 1000 })
  // A scan: a nudged move deviates exactly when its offset exceeds the
  // tolerance and no other move is that close (the rows are 0.5 apart).
  const expected = nudged.filter((move, index) => index % 7 === 0 && move.from.z - -1 > OPTIONS.tolerance).length
  const extra = result.deviations.filter((deviation) => deviation.kind === 'extraCut').length
  assert(extra === expected, `the grid finds ${extra} extra cuts, a scan ${expected}`)
}

testIdenticalAndResegmented()
testMovedMissingAndExtraCuts()
testFeeds()
testRotaryStockFrame()
testUnverified()
testGridMatchesScan()

console.log('exportParity tests passed')
