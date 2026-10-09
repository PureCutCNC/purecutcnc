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
 */

import assert from 'node:assert/strict'
import { exportPlasma, PLASMA_EXPORT_SCENARIOS, rectangle } from '../../test/plasmaExportFixtures'
import type { PlasmaExportSpec } from '../../test/plasmaExportFixtures'
import { defaultPlasmaTool } from '../../toolPolicy'
import { convertLength } from '../../utils/units'

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

  // No QtPlasmaC material table: the tool's material number is ignored, and
  // the pending-output warning is gone now that the mode is written.
  assert.ok(!lines.some((line) => line.startsWith('M190')), `${name}: no material select`)
  assert.ok(!lines.some((line) => /postPlasmaOutputPending/.test(line)), `${name}: nothing is pending`)

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

console.log('plasmaGcodeOutput.test.ts: Grbl probe/zero/pierce/dwell/drop sequence, offsets, units, height order, leads and mirroring passed')
