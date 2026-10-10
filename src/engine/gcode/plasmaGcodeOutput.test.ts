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
 * G-code-owned plasma piercing (issue #983): the per-cut sequence of the Grbl
 * (OpenBuilds CONTROL) machine. The structure is also enforced on real exported
 * output by `scripts/gcode-conformance/grbl-plasma/verdict.ts` and the motion
 * syntax by grbl-gvalidate through `scripts/gcode-conformance/corpus.ts`.
 *
 * Per cut: safe Z (operator zero) -> rapid to the pierce point -> probe ->
 * set Z zero on the sheet -> pierce-height rapid -> M3 -> dwell -> drop to cut
 * height at the plunge feed -> leads/contour at the cut feed -> M5 -> safe Z.
 * Only the program's first safe Z is in the operator's zero: after a touch-off
 * every Z, the retract included, is measured from the sheet.
 */

import assert from 'node:assert/strict'
import { exportPlasma, PLASMA_EXPORT_SCENARIOS, rectangle } from '../../test/plasmaExportFixtures'
import type { PlasmaExportSpec } from '../../test/plasmaExportFixtures'
import { defaultPlasmaTool } from '../../toolPolicy'
import { convertLength } from '../../utils/units'
import { warningSeverity } from '../toolpaths/warningCodes'
import { runPostProcessor } from './postprocessor'

const TORCH_ON = 'M3 S1000'
const TORCH_OFF = 'M5'

function codeLines(gcode: string): string[] {
  return gcode.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith(';') && !line.startsWith('('))
}

function grbl(spec: PlasmaExportSpec) {
  return exportPlasma({ ...spec, machineId: 'grbl-plasma' })
}

/** Resolved motion and words of one emitted program line. */
interface ResolvedLine {
  text: string
  /** G0/G1/G2/G3 in effect, modal motion included. */
  motion: 'G0' | 'G1' | 'G2' | 'G3' | null
  torch: 'on' | 'off' | null
  probe: boolean
  setZeroZ: number | null
  dwell: number | null
  words: Record<string, number>
}

/** Resolve modal motion, feeds and Z across a program, as the controller reads it. */
function resolve(gcode: string): ResolvedLine[] {
  const out: ResolvedLine[] = []
  let motion: ResolvedLine['motion'] = null
  for (const text of codeLines(gcode)) {
    const words: Record<string, number> = {}
    for (const match of text.matchAll(/([XYZIJFPQR])(-?\d*\.?\d+)/g)) words[match[1]] = Number(match[2])
    const probe = /(^|\s)G38\.[0-9](\s|$)/.test(text)
    const motionMatch = /(^|\s)G0?([0-3])(?![\d.])/.exec(text)
    if (motionMatch) motion = `G${motionMatch[2]}` as ResolvedLine['motion']
    const torch = /(^|\s)M0?3(\s|$)/.test(text) ? 'on' : /(^|\s)M0?5(\s|$)/.test(text) ? 'off' : null
    const setZero = /(^|\s)G10(\s|$)/.test(text) ? words.Z ?? null : null
    const dwell = /(^|\s)G0?4(\s|$)/.test(text) ? words.P ?? null : null
    out.push({ text, motion, torch, probe, setZeroZ: setZero, dwell, words })
  }
  return out
}

/** Every torch-on/torch-off pair, with the lines that prepare it and the moves inside it. */
function cycles(gcode: string): Array<{ prepare: string[]; moves: string[] }> {
  const result: Array<{ prepare: string[]; moves: string[] }> = []
  let pending: string[] = []
  let open: { prepare: string[]; moves: string[] } | null = null
  for (const line of codeLines(gcode)) {
    if (line === TORCH_ON) {
      assert.equal(open, null, 'torch-on while the torch is already on')
      open = { prepare: pending, moves: [] }
      pending = []
      result.push(open)
    } else if (line === TORCH_OFF) {
      assert.ok(open, 'torch-off without a torch-on')
      open = null
    } else if (open) {
      open.moves.push(line)
    } else {
      // Everything between the previous torch-off and the next torch-on, plus
      // the program header before the first one, prepares the next cut.
      pending.push(line)
    }
  }
  assert.equal(open, null, 'the program ends with the torch off')
  return result
}

const SCENARIOS = ['single-outline', 'part-with-holes', 'nested-sheet', 'small-hole', 'small-hole-arc-lead', 'arc-lead-ins', 'inch-output'] as const

for (const name of SCENARIOS) {
  const { result, input } = grbl(PLASMA_EXPORT_SCENARIOS[name]())
  const lines = codeLines(result.gcode)
  assert.deepEqual(result.warnings, [], `${name}: a delivered G-code pierce export raises nothing`)

  // No QtPlasmaC material table: the tool's material number is ignored.
  assert.ok(!lines.some((line) => line.startsWith('M190')), `${name}: no material select`)

  const contours = input.operations.reduce((sum, op) => sum + (op.operation.target.source === 'features' ? op.operation.target.featureIds.length : 0), 0)
  const pairs = cycles(result.gcode)
  assert.equal(pairs.length, contours, `${name}: one torch pair per contour`)
  assert.equal(lines.filter((line) => line.startsWith('G38.2 ')).length, contours, `${name}: every contour is probed`)
  assert.equal(lines.filter((line) => line.startsWith('G10 L20 ')).length, contours, `${name}: every contour sets Z zero`)
  assert.equal(lines.filter((line) => line.startsWith('G4 P')).length, contours, `${name}: every contour dwells`)
  assert.ok(!lines.some((line) => /^M4(\s|$)/.test(line)), `${name}: the torch is never M4`)

  // The per-cut order, read off the program: probe -> zero -> pierce-height
  // rapid -> M3 -> dwell -> a Z drop at a feed -> the cut moves.
  for (const pair of pairs) {
    const probe = pair.prepare.findIndex((line) => line.startsWith('G38.2 '))
    const zero = pair.prepare.findIndex((line) => line.startsWith('G10 L20 '))
    const pierce = pair.prepare.findLastIndex((line) => /^G0 Z-?[\d.]+$/.test(line))
    assert.ok(probe >= 0 && zero > probe && pierce > zero && pierce === pair.prepare.length - 1,
      `${name}: probe -> set zero -> pierce-height rapid immediately before the torch, got ${JSON.stringify(pair.prepare)}`)
    assert.equal(pair.moves.filter((line) => /^G0(\s|$)/.test(line)).length, 0, `${name}: no rapid while the torch is on`)
    assert.ok(pair.moves.some((line) => /^G1 Z-?[\d.]+ F[\d.]+$/.test(line)), `${name}: the drop to cut height carries a feed`)
  }

  // With the torch off, only rapids travel.
  const resolved = resolve(result.gcode)
  let torch = false
  for (const line of resolved) {
    if (line.torch === 'on') torch = true
    else if (line.torch === 'off') torch = false
    else if (!torch && (line.motion === 'G1' || line.motion === 'G2' || line.motion === 'G3')) {
      assert.fail(`${name}: a cutting move with the torch off: ${line.text}`)
    }
  }
}

// The exact words of the OpenBuilds sample: probe at the configured depth and
// feed, set zero on the sheet, pierce, dwell in seconds, drop at the plunge
// feed, then cut at the cut feed.
{
  const { result } = grbl(PLASMA_EXPORT_SCENARIOS['single-outline']())
  const lines = codeLines(result.gcode)
  const at = lines.indexOf('G38.2 Z-30.000 F100.000')
  assert.ok(at >= 0, 'the probe is written with the definition\'s depth and feed')
  assert.deepEqual(lines.slice(at, at + 6), [
    'G38.2 Z-30.000 F100.000',
    'G10 L20 P0 Z0.000',
    'G0 Z3.800',
    TORCH_ON,
    'G4 P0.200',
    'G1 Z1.500 F2000.000',
  ], 'probe -> zero -> pierce -> torch -> dwell -> drop')
  assert.ok(lines.some((line) => line.endsWith(' F5560.000')), 'the contour runs at the cut feed')
  const safeZ = lines.find((line) => /^G0 Z-?[\d.]+$/.test(line))
  assert.ok(safeZ && /^G0 Z[\d.]+$/.test(safeZ), `the program opens with a safe-Z rapid, got ${safeZ}`)
  const motionLines = lines.filter((line) => /^(G[0-3](\s|$)|[XYZIJ]-?\d)/.test(line))
  assert.equal(motionLines[0], safeZ, 'the first motion is the safe-Z rapid')
  const lastCut = lines.slice(0, lines.indexOf(TORCH_OFF))
  assert.ok(lastCut.includes('G0 Z5.000'), 'safe Z is the toolpath safe height in the operator zero')
}

// The switch offset is applied negatively, and an absent offset means zero and
// stays absent in the definition.
{
  const plain = grbl(PLASMA_EXPORT_SCENARIOS['single-outline']())
  assert.ok(codeLines(plain.result.gcode).includes('G10 L20 P0 Z0.000'), 'an absent offset sets Z zero exactly')

  const explicit = grbl({
    ...PLASMA_EXPORT_SCENARIOS['single-outline'](),
    definition: (definition) => ({
      ...definition,
      plasma: { ...definition.plasma!, touchOff: { ...definition.plasma!.touchOff!, switchOffset: 5 } },
    }),
  })
  assert.ok(codeLines(explicit.result.gcode).includes('G10 L20 P0 Z-5.000'), 'a 5 mm offset is subtracted')

  const absent = grbl({
    ...PLASMA_EXPORT_SCENARIOS['single-outline'](),
    definition: (definition) => {
      const { switchOffset: _offset, ...touchOff } = definition.plasma!.touchOff!
      return { ...definition, plasma: { ...definition.plasma!, touchOff } }
    },
  })
  assert.deepEqual(absent.result.warnings, [])
  assert.ok(codeLines(absent.result.gcode).includes('G10 L20 P0 Z0.000'), 'an omitted offset is zero')
}

// Configured heights are emitted as configured, even when pierce height is the
// lower of the two: there is no ordering rule and no climbing move is invented.
{
  const { result } = grbl({
    ...PLASMA_EXPORT_SCENARIOS['single-outline'](),
    operations: [{ featureIds: ['plate'], tool: { pierceHeight: 1, cutHeight: 2 } }],
  })
  const lines = codeLines(result.gcode)
  const at = lines.indexOf('G0 Z1.000')
  assert.ok(at >= 0, `pierce height is emitted from the tool, got ${JSON.stringify(lines.slice(0, 12))}`)
  assert.equal(lines[at + 1], 'M3 S1000')
  assert.equal(lines[at + 3], 'G1 Z2.000 F2000.000', 'the drop goes to the configured cut height at the plunge feed')
}

// Line and arc leads are both cut at the fixed cut height and the cut feed,
// and the torch never drops out of the pair.
{
  for (const [name, lead] of [['line', 'line'], ['arc', 'arc']] as const) {
    const { result } = grbl({
      ...PLASMA_EXPORT_SCENARIOS['arc-lead-ins'](),
      operations: [{ featureIds: ['disc'], operation: { plasmaLeadIn: lead, plasmaLeadOut: lead } }],
    })
    const pair = cycles(result.gcode)[0]
    const feedMoves = pair.moves.filter((line) => !/^G4/.test(line))
    assert.ok(feedMoves.length > 0, `${name}: the contour moves are written`)
    const arcs = feedMoves.filter((line) => /^G[23](\s|$)/.test(line))
    if (lead === 'arc') assert.ok(arcs.length > 0, 'an arc lead-in is a G2/G3')
    assert.equal(feedMoves[0], `G1 Z1.500 F2000.000`, `${name}: the first move is the drop to cut height`)
    assert.ok(feedMoves.every((line) => pair.moves.includes(line)), `${name}: every cut move sits inside the pair`)
  }
}

// Units: the touch-off fields are millimetres and millimetres per minute
// whatever the project units; the tool heights are already project units.
{
  const { result } = grbl(PLASMA_EXPORT_SCENARIOS['inch-output']())
  const lines = codeLines(result.gcode)
  const depth = convertLength(30, 'mm', 'inch').toFixed(4)
  const feed = convertLength(100, 'mm', 'inch').toFixed(4)
  assert.ok(lines.includes(`G38.2 Z-${depth} F${feed}`), `probe depth and feed convert to inch, got ${JSON.stringify(lines.slice(0, 10))}`)
  const tool = defaultPlasmaTool('inch')
  assert.ok(lines.includes(`G0 Z${tool.pierceHeight!.toFixed(4)}`), 'pierce height is the tool value in inch')
  assert.ok(lines.includes(`G1 Z${tool.cutHeight!.toFixed(4)} F${convertLength(2000, 'mm', 'inch').toFixed(4)}`), 'the drop is the tool value in inch')
}

// Physical direction survives a mirrored machine axis: arcs swap G2/G3, and
// the signed area read back through the same axis is unchanged.
{
  const disc = PLASMA_EXPORT_SCENARIOS['arc-lead-ins']()
  const plain = cycles(grbl(disc).result.gcode)[0].moves
  const mirrored = cycles(grbl({
    ...disc,
    definition: (definition) => ({ ...definition, coordinateSystem: { ...definition.coordinateSystem, xAxis: '-X' } }),
  }).result.gcode)[0].moves
  const arcs = (moves: string[], word: string) => moves.filter((line) => line.startsWith(word)).length
  assert.ok(arcs(plain, 'G3') > 0, 'the disc is cut with counter-clockwise arcs')
  assert.equal(arcs(mirrored, 'G2'), arcs(plain, 'G3'), 'mirrored X turns every G3 into a G2')
  assert.equal(arcs(mirrored, 'G3'), arcs(plain, 'G2'))

  const linear: PlasmaExportSpec = { ...disc, operations: [{ featureIds: ['disc'], operation: { arcFittingEnabled: false } }] }
  const area = (gcode: string, flipX: boolean) => {
    const points = resolve(gcode)
      .filter((line) => line.motion === 'G1' && line.words.X !== undefined && line.words.Y !== undefined)
      .map((line) => {
        const x = line.words.X
        return { x: flipX ? -x : x, y: line.words.Y }
      })
    return points.reduce((sum, p, i) => { const q = points[(i + 1) % points.length]; return sum + p.x * q.y - q.x * p.y }, 0) / 2
  }
  const unmirroredArea = area(grbl(linear).result.gcode, false)
  const mirroredArea = area(grbl({
    ...linear,
    definition: (definition) => ({ ...definition, coordinateSystem: { ...definition.coordinateSystem, xAxis: '-X' } }),
  }).result.gcode, true)
  assert.ok(unmirroredArea < 0, 'outside contour: clockwise viewed from above')
  assert.ok(Math.abs(mirroredArea - unmirroredArea) < 1e-6, 'the mirrored program, mapped back, cuts the same direction')
}

// A milling operation on the Grbl plasma machine is still skipped with a
// warning rather than exported through the spindle path.
{
  const spec = PLASMA_EXPORT_SCENARIOS['single-outline']()
  const { result } = grbl({
    ...spec,
    features: [...spec.features, { id: 'extra', operation: 'add', profile: rectangle(200, 200, 10, 10) }],
    operations: [{ featureIds: ['plate'] }, { featureIds: ['extra'], operation: { kind: 'pocket' } }],
  })
  assert.deepEqual(result.warnings, [{ code: 'postPlasmaOperationSkipped', params: { operation: 'Cut 2' } }])
}

// The QtPlasmaC material number is controller-only metadata. For G-code
// piercing an absent, zero or reserved number neither blocks the export nor
// changes the program: there is no material table to select on.
{
  for (const qtplasmacMaterialNumber of [undefined, 0, 1000000]) {
    const { result } = grbl({
      ...PLASMA_EXPORT_SCENARIOS['single-outline'](),
      operations: [{ featureIds: ['plate'], tool: { qtplasmacMaterialNumber } }],
    })
    assert.deepEqual(result.warnings, [], `material ${qtplasmacMaterialNumber} does not block a G-code pierce export`)
    assert.ok(!codeLines(result.gcode).some((line) => line.startsWith('M190')), 'no material is selected')
    assert.ok(codeLines(result.gcode).includes('M3 S1000'), 'the torch path is still written')
  }
}

// ── #983 modal feed after the raw probe ─────────────────────────────────────
// `G38.2 ... F<probeFeed>` is emitted as a raw line, so it changes the
// controller's modal feed without passing through `emitMotionLine`. The
// emitter must treat its own feed model as unknown after the probe: every
// contour's drop spells its own explicit configured plunge F, and every
// cutting move runs at the configured cut feed — including equal cut/plunge
// feeds, and a plunge feed that happens to equal the probe feed.

/** Effective modal feed at each emitted code line, as the controller reads it. */
function modalFeedByLine(gcode: string): Array<{ text: string; feed: number | null }> {
  let feed: number | null = null
  return codeLines(gcode).map((text) => {
    const match = /(?:^|\s)F(-?\d*\.?\d+)/.exec(text)
    if (match) feed = Number(match[1])
    return { text, feed }
  })
}

interface CycleFeed {
  /** Configured plunge feed the drop must run at. */
  plunge: number
  /** Configured cut feed every cutting move must run at. */
  cut: number
}

function closeEnough(actual: number | null, expected: number): boolean {
  return actual !== null && Math.abs(actual - expected) < 1e-3
}

/**
 * Walk each torch pair as the controller does and check the effective modal
 * feed of its drop and every cutting move. `expected` is one entry per
 * contour, in program order.
 */
function assertDropAndCutFeeds(name: string, gcode: string, expected: CycleFeed[]): void {
  let torch = false
  let cycle = -1
  let dropSeen = false
  let drops = 0
  let cuts = 0
  for (const { text, feed } of modalFeedByLine(gcode)) {
    if (text === TORCH_ON) {
      torch = true
      dropSeen = false
      cycle += 1
      assert.ok(cycle < expected.length, `${name}: more torch pairs than expected`)
      continue
    }
    if (text === TORCH_OFF) {
      torch = false
      continue
    }
    if (!torch) continue
    const want = expected[cycle]
    if (/^G1\s+Z/.test(text)) {
      assert.ok(!dropSeen, `${name}: one drop per contour, got a second: ${text}`)
      assert.ok(!/[XY]/.test(text), `${name}: the drop is Z only: ${text}`)
      assert.ok(closeEnough(feed, want.plunge), `${name}: the drop runs at the configured plunge feed ${want.plunge}, effective ${feed}: ${text}`)
      assert.ok(/\bF-?\d/.test(text), `${name}: the drop spells its own plunge F: ${text}`)
      dropSeen = true
      drops += 1
      continue
    }
    if (/^G[123](\s|$)/.test(text) || /^[XYZIJ]-?\d/.test(text)) {
      assert.ok(dropSeen, `${name}: a cutting move before the drop: ${text}`)
      assert.ok(closeEnough(feed, want.cut), `${name}: the cut runs at the configured cut feed ${want.cut}, effective ${feed}: ${text}`)
      cuts += 1
    }
  }
  assert.equal(cycle + 1, expected.length, `${name}: every contour fires`)
  assert.equal(drops, expected.length, `${name}: every contour drops`)
  assert.ok(cuts > 0, `${name}: cutting moves are written`)
}

/** Per-cut safe Z, probe, zero, pierce rapid, dwell, drop, retract, order. */
function assertPerCutSequence(name: string, gcode: string): void {
  const lines = codeLines(gcode)
  const safeZ = lines.find((line) => /^G0 Z-?[\d.]+$/.test(line))
  assert.ok(safeZ, `${name}: the program opens with a safe-Z rapid`)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === TORCH_OFF) {
      assert.equal(lines[i + 1], safeZ, `${name}: the retract after torch-off returns to the program safe Z`)
    }
  }
  for (const pair of cycles(gcode)) {
    assert.ok(pair.prepare.some((line) => line.startsWith('G38.2 ')), `${name}: each contour is probed`)
    assert.ok(pair.prepare.some((line) => line.startsWith('G10 L20 ')), `${name}: each contour sets Z zero`)
    assert.ok(/^G0 Z-?[\d.]+$/.test(pair.prepare.at(-1)!), `${name}: the pierce-height rapid sits immediately before the torch`)
    assert.ok(/^G4 P/.test(pair.moves[0]), `${name}: the dwell follows torch-on`)
    assert.ok(/^G1 Z-?[\d.]+ F[\d.]+$/.test(pair.moves[1]), `${name}: the explicit-feed drop follows the dwell`)
  }
}

// Equal cut and plunge feeds across a multi-contour part: the verified failing
// case (cutFeed = plungeFeed = 300, probe feed 100). Every drop must carry its
// own F300 rather than inherit the probe's F100.
{
  const spec = PLASMA_EXPORT_SCENARIOS['part-with-holes']()
  const featureIds = ['hole-1', 'hole-2', 'plate']
  const equal = grbl({ ...spec, operations: [{ featureIds, operation: { feed: 300, plungeFeed: 300 } }] })
  assert.deepEqual(equal.result.warnings, [], 'equal cut/plunge raises nothing')
  assertPerCutSequence('equal cut=plunge', equal.result.gcode)
  assertDropAndCutFeeds('equal cut=plunge', equal.result.gcode, [
    { plunge: 300, cut: 300 }, { plunge: 300, cut: 300 }, { plunge: 300, cut: 300 },
  ])

  // All three feeds equal the probe feed: invalidating the modal state is the
  // only fix that still spells F100 on the second and third drops. Assigning
  // the probe feed to the state would suppress them.
  const probeEqual = grbl({ ...spec, operations: [{ featureIds, operation: { feed: 100, plungeFeed: 100 } }] })
  assertDropAndCutFeeds('cut=plunge=probe', probeEqual.result.gcode, [
    { plunge: 100, cut: 100 }, { plunge: 100, cut: 100 }, { plunge: 100, cut: 100 },
  ])

  // Differing feeds keep the ordinary modal behaviour: the drop at the plunge
  // feed, the cuts restated at the cut feed.
  const differing = grbl({ ...spec, operations: [{ featureIds, operation: { feed: 5560, plungeFeed: 2000 } }] })
  assertDropAndCutFeeds('differing feeds', differing.result.gcode, [
    { plunge: 2000, cut: 5560 }, { plunge: 2000, cut: 5560 }, { plunge: 2000, cut: 5560 },
  ])
}

// Multiple operations in one program: the feed state carries across the
// operation boundary, so the second operation's first drop is the same
// suppression case as a second contour.
{
  const multi = grbl({
    ...PLASMA_EXPORT_SCENARIOS['part-with-holes'](),
    operations: [
      { featureIds: ['hole-1'], operation: { feed: 300, plungeFeed: 300 } },
      { featureIds: ['hole-2', 'plate'], operation: { feed: 700, plungeFeed: 300 } },
    ],
  })
  assertDropAndCutFeeds('two operations', multi.result.gcode, [
    { plunge: 300, cut: 300 }, { plunge: 300, cut: 700 }, { plunge: 300, cut: 700 },
  ])
  assertPerCutSequence('two operations', multi.result.gcode)
}

// Inch output: the same modal invariant over converted plunge, cut and probe
// feeds, including a plunge feed equal to the converted probe feed.
{
  const inchMulti: PlasmaExportSpec = {
    units: 'inch',
    thickness: convertLength(2, 'mm', 'inch'),
    features: [
      { id: 'plate', operation: 'add', profile: rectangle(1, 1, 4, 3) },
      { id: 'hole-1', operation: 'subtract', profile: rectangle(1.5, 1.5, 1, 1) },
      { id: 'hole-2', operation: 'subtract', profile: rectangle(3, 1.5, 1, 1) },
    ],
    operations: [{ featureIds: ['hole-1', 'hole-2', 'plate'] }],
  }
  const plunge = convertLength(2000, 'mm', 'inch')
  const cut = convertLength(5560, 'mm', 'inch')
  assertDropAndCutFeeds('inch defaults', grbl(inchMulti).result.gcode, [
    { plunge, cut }, { plunge, cut }, { plunge, cut },
  ])

  const probe = convertLength(100, 'mm', 'inch')
  const probeEqual = grbl({
    ...inchMulti,
    operations: [{ featureIds: ['hole-1', 'hole-2', 'plate'], operation: { feed: cut, plungeFeed: probe } }],
  })
  assertDropAndCutFeeds('inch plunge=probe', probeEqual.result.gcode, [
    { plunge: probe, cut }, { plunge: probe, cut }, { plunge: probe, cut },
  ])
}

// ── #983 Z frames around the touch-off ──────────────────────────────────────
// The safe height is the toolpath's, in the project's Z zero. That number is
// right only until the first `G10 L20`: the touch-off puts Z zero on the sheet,
// so the retract after every cut, and a safe rapid before any later cut, are
// the same clearance measured from the sheet surface. Wherever the operator's
// zero sits, only the program's first safe rapid may show it.

/** The Z of every Z-only rapid, by where it sits in the cut cycle. */
function zRapids(gcode: string): { first: number[]; pierce: number[]; retract: number[]; laterSafe: number[] } {
  const lines = resolve(gcode)
  const out = { first: [] as number[], pierce: [] as number[], retract: [] as number[], laterSafe: [] as number[] }
  let touchedOff = false
  lines.forEach((line, index) => {
    if (line.setZeroZ !== null) {
      touchedOff = true
      return
    }
    const zOnly = line.motion === 'G0' && !line.probe
      && line.words.Z !== undefined && line.words.X === undefined && line.words.Y === undefined
    if (!zOnly) return
    const before = lines[index - 1]
    if (!touchedOff) out.first.push(line.words.Z)
    else if (before.setZeroZ !== null) out.pierce.push(line.words.Z)
    else if (before.torch === 'off') out.retract.push(line.words.Z)
    else out.laterSafe.push(line.words.Z)
  })
  return out
}

/**
 * Once Z zero is on the sheet, the head never travels in XY, and never comes
 * to rest after a cut, at or below the height it just cut at.
 */
function assertTravelClearsTheCut(name: string, gcode: string): void {
  let torch = false
  let touchedOff = false
  let z: number | null = null
  let cutZ: number | null = null
  let travels = 0
  const lines = resolve(gcode)
  lines.forEach((line, index) => {
    if (line.torch === 'on') torch = true
    else if (line.torch === 'off') torch = false
    if (line.setZeroZ !== null) {
      touchedOff = true
      z = line.setZeroZ
      return
    }
    if (line.words.Z !== undefined && !line.probe) z = line.words.Z
    if (torch && line.motion === 'G1' && line.words.Z !== undefined) cutZ = line.words.Z
    if (!touchedOff || torch || cutZ === null || line.motion !== 'G0' || line.probe) return
    if (lines[index - 1].torch === 'off') {
      assert.ok(z !== null && z > cutZ, `${name}: the retract clears the cut height ${cutZ}, got Z${z}: ${line.text}`)
    }
    if (line.words.X !== undefined || line.words.Y !== undefined) {
      assert.ok(z !== null && z > cutZ, `${name}: XY travel at Z${z} is not above the cut height ${cutZ}: ${line.text}`)
      travels += 1
    }
  })
  assert.ok(travels > 0, `${name}: the program travels between cuts`)
}

for (const units of ['mm', 'inch'] as const) {
  const len = (mm: number) => convertLength(mm, 'mm', units)
  const emitted = (value: number) => Number(value.toFixed(units === 'mm' ? 3 : 4))
  const thickness = len(6)
  const features: PlasmaExportSpec['features'] = [
    { id: 'part-a', operation: 'add', profile: rectangle(len(20), len(20), len(60), len(40)) },
    { id: 'part-b', operation: 'add', profile: rectangle(len(100), len(20), len(60), len(40)) },
    { id: 'part-c', operation: 'add', profile: rectangle(len(20), len(80), len(60), len(40)) },
  ]
  // Two contours in one operation, then a second operation. With the same
  // consumable the second starts at the first one's retract; with a taller cut
  // height its own safe height is higher, so it has to rise before travelling.
  const sameHeights: PlasmaExportSpec = {
    units, thickness, features,
    operations: [{ featureIds: ['part-a', 'part-b'] }, { featureIds: ['part-c'] }],
  }
  const tallerSecond: PlasmaExportSpec = {
    ...sameHeights,
    operations: [
      { featureIds: ['part-a', 'part-b'] },
      { featureIds: ['part-c'], tool: { pierceHeight: len(5.5), cutHeight: len(5) } },
    ],
  }
  const placements = [
    ['on the sheet top', thickness],
    ['on the table', 0],
    ['above the sheet', thickness + len(20)],
  ] as const
  for (const [label, originZ] of placements) {
    for (const [shape, spec] of [['same heights', sameHeights], ['taller second cut', tallerSecond]] as const) {
      const name = `${units}, Z zero ${label}, ${shape}`
      const { result, input } = grbl({ ...spec, originZ })
      assert.deepEqual(result.warnings.map((warning) => warning.code), ['postNoToolChangeCommands'], `${name}: only the second torch is reported`)
      // The toolpath's own safe height per operation, in project Z from the
      // stock bottom: the expectations below are derived from it and from the
      // stock, not from the emitter.
      const safe = input.operations.map((op) => op.toolpath.moves.find((move) => move.kind === 'rapid')!.to.z)
      const pierce = input.operations.map((op) => op.tool.pierceHeight!)
      const z = zRapids(result.gcode)
      assert.deepEqual(z.first, [emitted(safe[0] - originZ)], `${name}: the first safe rapid is in the operator's zero`)
      assert.deepEqual(z.retract, [safe[0], safe[0], safe[1]].map((value) => emitted(value - thickness)),
        `${name}: every retract is measured from the sheet`)
      assert.deepEqual(z.pierce, [pierce[0], pierce[0], pierce[1]].map(emitted), `${name}: every pierce rapid follows its set-zero`)
      if (shape === 'same heights') {
        assert.deepEqual(z.laterSafe, [], `${name}: a later cut starts from the retract it is already at`)
      } else {
        assert.ok(safe[1] > safe[0], `${name}: the taller cut raises the second operation's safe height`)
        assert.deepEqual(z.laterSafe, [emitted(safe[1] - thickness)],
          `${name}: the second operation rises to its own safe height, measured from the sheet`)
      }
      assertTravelClearsTheCut(name, result.gcode)
    }
  }

  // The same numbers spelled out, so the frames are pinned against the sheet
  // and not only against the helper arithmetic above: 5 mm (0.2 in) of
  // clearance over a 6 mm sheet.
  const clearance = units === 'mm' ? 5 : 0.2
  for (const [originZ, first] of [[thickness, clearance], [0, emitted(thickness + clearance)], [thickness + len(20), emitted(clearance - len(20))]] as const) {
    const z = zRapids(grbl({ ...sameHeights, originZ }).result.gcode)
    assert.deepEqual(z.first, [first], `${units}: first safe rapid with Z zero at ${originZ}`)
    assert.deepEqual(z.retract, [clearance, clearance, clearance], `${units}: retracts with Z zero at ${originZ}`)
  }
}

// Literal lines of the reviewed case: two parts on a 6 mm sheet. Z zero on the
// table used to retract to Z11 (11 above the sheet instead of 5), and Z zero 20
// above the sheet to Z-15 (15 below its surface, then an XY rapid).
{
  const spec: PlasmaExportSpec = {
    units: 'mm', thickness: 6,
    features: [
      { id: 'part-a', operation: 'add', profile: rectangle(20, 20, 60, 40) },
      { id: 'part-b', operation: 'add', profile: rectangle(100, 20, 60, 40) },
    ],
    operations: [{ featureIds: ['part-a', 'part-b'] }],
  }
  for (const [originZ, first] of [[6, 'G0 Z5.000'], [0, 'G0 Z11.000'], [26, 'G0 Z-15.000']] as const) {
    const lines = codeLines(grbl({ ...spec, originZ }).result.gcode)
    const zLines = lines.filter((line) => /^G0 Z-?[\d.]+$/.test(line))
    assert.deepEqual(zLines, [first, 'G0 Z3.800', 'G0 Z5.000', 'G0 Z3.800', 'G0 Z5.000'],
      `Z zero at ${originZ}: first safe rapid, then pierce and retract from the sheet`)
    lines.forEach((line, index) => {
      if (line === TORCH_OFF) assert.equal(lines[index + 1], 'G0 Z5.000', `Z zero at ${originZ}: the line after M5 retracts 5 above the sheet`)
    })
  }
}

// ── A cut with no safe height blocks the export ─────────────────────────────
// The safe height is read off the toolpath's rapids. Cuts with none cannot be
// retracted between, so they are not written — and a program that quietly
// lacks an operation's cuts must not be saved.
{
  const { input } = grbl(PLASMA_EXPORT_SCENARIOS['single-outline']())
  const [first] = input.operations
  const noRapids = runPostProcessor({
    ...input,
    operations: [{ ...first, toolpath: { ...first.toolpath, moves: first.toolpath.moves.filter((move) => move.kind !== 'rapid') } }],
  })
  assert.deepEqual(noRapids.warnings, [{ code: 'postPlasmaSafeHeightMissing', params: { operation: 'Cut 1' } }],
    'cuts with no safe height are reported')
  assert.equal(warningSeverity('postPlasmaSafeHeightMissing'), 'error', 'and the report blocks the export')
  assert.ok(!codeLines(noRapids.gcode).some((line) => line === TORCH_ON || line.startsWith('G38.2')), 'nothing of the cut is written')

  // An operation that generated no cuts has nothing to leave out: as on every
  // other machine it writes its header and no motion, with no new report.
  const empty = runPostProcessor({ ...input, operations: [{ ...first, toolpath: { ...first.toolpath, moves: [] } }] })
  assert.deepEqual(empty.warnings, [], 'an empty toolpath raises nothing here')
  assert.ok(!codeLines(empty.gcode).includes(TORCH_ON), 'and fires nothing')
}

// ── A plasma operation on a machine that is not a plasma table ──────────────
// Not a shipped configuration, but reachable from the CAM panel. It goes
// through the ordinary emitters, which take the plunge feed by the rule every
// milling operation uses: the operation's own, else the tool's. #983 made the
// plasma tool's plunge feed a real setting, so an operation with none of its
// own now plunges at the tool's feed where it used to write F0.
{
  const spec = PLASMA_EXPORT_SCENARIOS['single-outline']()
  const fallback: PlasmaExportSpec = { ...spec, operations: [{ featureIds: ['plate'], operation: { plungeFeed: 0 } }] }
  const router = codeLines(exportPlasma({ ...fallback, machineId: 'grbl' }).result.gcode)
  assert.ok(router.includes('G1 X83.000 Y96.300 Z1.500 F2000.000'),
    `a router plunges at the tool's plunge feed, got ${JSON.stringify(router.slice(0, 8))}`)
  assert.ok(!router.some((line) => /F0(\.0+)?(\s|$)/.test(line)), 'and writes no F0')
  const shopbot = exportPlasma({ ...fallback, machineId: 'shopbot' }).result.gcode.split(/\r?\n/)
  assert.ok(shopbot.includes('MS,33.333,33.333'), 'ShopBot takes the same fallback, in mm/s')

  const own = codeLines(exportPlasma({ ...spec, machineId: 'grbl', operations: [{ featureIds: ['plate'], operation: { plungeFeed: 900 } }] }).result.gcode)
  assert.ok(own.includes('G1 X83.000 Y96.300 Z1.500 F900.000'), 'the operation\'s own plunge feed still wins')
}

console.log('plasmaGcodeOutput.test.ts: Grbl probe/zero/pierce/dwell/drop sequence, offsets, units, height order, leads, mirroring, #983 modal feed, Z frames, missing safe height and router fallback passed')
