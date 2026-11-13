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
 * QtPlasmaC torch path (issue #959): the emitted sequence of a controller-
 * pierced plasma program. The QtPlasmaC simulator (`check:gcode:qtplasmac`)
 * runs the same scenarios; these assertions pin the rules without a container.
 */

import assert from 'node:assert/strict'
import { exportPlasma, PLASMA_EXPORT_SCENARIOS, rectangle } from '../../test/plasmaExportFixtures'
import type { PlasmaExportSpec } from '../../test/plasmaExportFixtures'
import { warningSeverity } from '../toolpaths/warningCodes'
import { defaultTool } from '../../types/project'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { normalizeToolForProject } from '../toolpaths/geometry'
import { runPostProcessor } from './postprocessor'
import { foldFullCircleArcs, planPlasmaPath } from './motionPipeline'
import type { ArcMoveDescriptor } from './arcFitting'

const TORCH_ON = 'M3 $0 S1'
const TORCH_OFF = 'M5 $0'

function codeLines(gcode: string): string[] {
  return gcode.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('('))
}

/** Every torch-on/off pair, with the motion lines between them. */
function cuts(gcode: string): Array<{ before: string; moves: string[] }> {
  const lines = codeLines(gcode)
  const result: Array<{ before: string; moves: string[] }> = []
  let open: { before: string; moves: string[] } | null = null
  lines.forEach((line, index) => {
    if (line === TORCH_ON) {
      assert.equal(open, null, 'torch-on while the torch is already on')
      open = { before: lines[index - 1], moves: [] }
      result.push(open)
    } else if (line === TORCH_OFF) {
      assert.ok(open, 'torch-off without a torch-on')
      open = null
    } else if (open) {
      open.moves.push(line)
    }
  })
  assert.equal(open, null, 'the program ends with the torch off')
  return result
}

/** Motion words: an explicit G0-G3, or a modal continuation (a line of axis words). */
const isMotion = (line: string) => /^G[0-3]\b/.test(line) || /^[XYIJ]-?\d/.test(line)

for (const [name, scenario] of Object.entries(PLASMA_EXPORT_SCENARIOS)) {
  const { result, input } = exportPlasma(scenario())
  const lines = codeLines(result.gcode)
  assert.deepEqual(result.warnings, [], `${name}: a clean plasma export raises nothing (the torch path is written)`)

  // Material handshake: select, wait, then the feed word, before the first torch-on.
  const select = lines.indexOf('M190 P1')
  const wait = lines.indexOf('M66 P3 L3 Q1')
  const feed = lines.indexOf('F#<_hal[plasmac.cut-feed-rate]>')
  const firstTorch = lines.indexOf(TORCH_ON)
  assert.ok(select >= 0 && select < wait && wait < feed && feed < firstTorch, `${name}: select -> wait -> feed -> first torch-on`)

  // QtPlasmaC owns Z and the cut feed.
  assert.ok(!lines.some((line) => /\bZ-?[\d.]/.test(line)), `${name}: no Z word anywhere`)
  assert.ok(!lines.some((line) => /\bF-?[\d.]/.test(line)), `${name}: no numeric feed anywhere`)
  assert.ok(!lines.some((line) => /^M[345]\b/.test(line) && line !== TORCH_ON && line !== TORCH_OFF), `${name}: no spindle words`)
  assert.ok(lines.includes('#<holes> = 1'), `${name}: QtPlasmaC hole handling is switched on`)

  // One torch-on per contour, every cut move inside a pair, travel outside.
  const contours = input.operations.reduce((sum, op) => sum + (op.operation.target.source === 'features' ? op.operation.target.featureIds.length : 0), 0)
  const pairs = cuts(result.gcode)
  assert.equal(pairs.length, contours, `${name}: one torch-on per contour`)
  for (const pair of pairs) {
    assert.ok(/^G0 X-?[\d.]+ Y-?[\d.]+$/.test(pair.before), `${name}: each torch-on follows an XY rapid to the pierce point, got ${pair.before}`)
    assert.ok(pair.moves.length > 0 && pair.moves.every((line) => isMotion(line) && !/^G0\b/.test(line)), `${name}: only feed and arc moves while the torch is on`)
  }
  let torch = false
  for (const line of lines) {
    if (line === TORCH_ON) torch = true
    else if (line === TORCH_OFF) torch = false
    else if (!torch && isMotion(line)) assert.ok(/^G0\b/.test(line), `${name}: travel with the torch off is rapid only, got ${line}`)
  }
}

// The pierce point is where #957 put it, lead-in included: the first point of
// the toolpath's plunge, unchanged in machine XY.
{
  const { input, result } = exportPlasma(PLASMA_EXPORT_SCENARIOS['single-outline']())
  const plunge = input.operations[0].toolpath.moves.find((move) => move.kind === 'plunge')!
  const machineY = input.project.origin.y - plunge.to.y
  assert.equal(cuts(result.gcode)[0].before, `G0 X${plunge.to.x.toFixed(3)} Y${machineY.toFixed(3)}`, 'the torch fires at the toolpath pierce point')
}

// The handshake is written again only when the material changes.
{
  const two: PlasmaExportSpec = {
    ...PLASMA_EXPORT_SCENARIOS['nested-sheet'](),
    operations: [{ featureIds: ['part-a'] }, { featureIds: ['part-b'], tool: { qtplasmacMaterialNumber: 2 } }, { featureIds: ['part-c'], tool: { qtplasmacMaterialNumber: 2 } }],
  }
  const lines = codeLines(exportPlasma(two).result.gcode)
  assert.deepEqual(lines.filter((line) => line.startsWith('M190')), ['M190 P1', 'M190 P2'], 'one select per material change')
  assert.equal(lines.filter((line) => line.startsWith('M66')).length, 2, 'every select is followed by its wait')
  const second = lines.indexOf('M190 P2')
  assert.deepEqual(lines.slice(second, second + 3), ['M190 P2', 'M66 P3 L3 Q1', 'F#<_hal[plasmac.cut-feed-rate]>'], 'the second handshake keeps its order')
  const thirdOp = exportPlasma(two).result.warnings
  assert.deepEqual(thirdOp.map((warning) => warning.code), ['postNoToolChangeCommands', 'postNoToolChangeCommands'], 'a different consumable is disclosed, not paused for')
}

// A tool with no material number, or one outside the selectable range, blocks
// the export. QtPlasmaC reserves 1000000+ for the temporary materials it
// numbers itself, and this project's simulator reserves 0 for "nothing
// selected" — neither may be selected by CAM. This is the project's contract:
// it is not a claim that every controller forbids material 0.
{
  const spec = PLASMA_EXPORT_SCENARIOS['single-outline']()
  const blocked = (material: number | undefined) =>
    exportPlasma({ ...spec, operations: [{ featureIds: ['plate'], tool: { qtplasmacMaterialNumber: material } }] }).result
  const missingWarning = [{ code: 'postPlasmaMaterialMissing' as const, params: { operation: 'Cut 1', tool: 'Torch 1' } }]

  const missing = blocked(undefined)
  assert.deepEqual(missing.warnings, missingWarning)
  assert.equal(warningSeverity('postPlasmaMaterialMissing'), 'error', 'a missing material blocks saving')
  assert.ok(!missing.gcode.includes('M190'), 'no material is invented')

  for (const reserved of [0, 1000000]) {
    const result = blocked(reserved)
    assert.deepEqual(result.warnings, missingWarning, `material ${reserved} is not selectable and blocks the export`)
    assert.equal(warningSeverity('postPlasmaMaterialMissing'), 'error', `material ${reserved} is an error, not a warning`)
    assert.ok(!codeLines(result.gcode).some((line) => line.startsWith('M190')), `material ${reserved} must not be selected`)
  }

  // The boundary: the highest permanent material is selectable, one past it is
  // the first reserved temporary number.
  const top = blocked(999999)
  assert.deepEqual(top.warnings, [])
  assert.ok(codeLines(top.gcode).includes('M190 P999999'), 'the highest permanent material is selected')
}

// A hole under QtPlasmaC's 32 mm default is written as one closed arc block.
// Its load filter recognises a hole from a single G2/G3 whose end is the point
// the previous block left the torch at; the simulator then asserts the speed
// reduction actually runs. Arc fitting's ≤ 90° sub-arcs are folded back
// together here, and the folded block spells its own arc word.
{
  const { result } = exportPlasma(PLASMA_EXPORT_SCENARIOS['small-hole']())
  assert.deepEqual(result.warnings, [])
  const moves = cuts(result.gcode)[0].moves
  assert.equal(moves.length, 2, 'a straight lead-in, then the whole hole')
  const lead = /^G1 X(-?[\d.]+) Y(-?[\d.]+)$/.exec(moves[0])
  const circle = /^G3 X(-?[\d.]+) Y(-?[\d.]+) I(-?[\d.]+) J(-?[\d.]+)$/.exec(moves[1])
  assert.ok(lead, `the lead-in is a line, got ${moves[0]}`)
  assert.ok(circle, `the hole is one explicit G3 block, got ${moves[1]}`)
  assert.equal(circle[1], lead[1], 'the circle ends on its own start X')
  assert.equal(circle[2], lead[2], 'the circle ends on its own start Y')
  const diameter = 2 * Math.hypot(Number(circle[3]), Number(circle[4]))
  assert.ok(diameter > 0 && diameter < 32, `the hole is under QtPlasmaC's 32 mm default, got ${diameter}`)
}

/** Index of the folded full circle: the move that ends where the one before left the tool. */
function foldedCircleIndex(moves: string[]): number {
  for (let index = 1; index < moves.length; index++) {
    const end = /X(-?[\d.]+) Y(-?[\d.]+)/.exec(moves[index])
    const previous = /X(-?[\d.]+) Y(-?[\d.]+)/.exec(moves[index - 1])
    if (end && previous && end[1] === previous[1] && end[2] === previous[2]) return index
  }
  return -1
}

// The default arc lead-in leaves G3 modal, so a folded hole would be a bare
// continuation if the emitter left its command to modal motion. The folded
// block must still spell its own G3: that is the arc word QtPlasmaC's hole
// handling reads, and the simulator's `exported-small-hole-arc-lead` case
// asserts the reduction that block asks for actually runs.
{
  const { result } = exportPlasma(PLASMA_EXPORT_SCENARIOS['small-hole-arc-lead']())
  assert.deepEqual(result.warnings, [])
  const moves = cuts(result.gcode)[0].moves
  const at = foldedCircleIndex(moves)
  assert.ok(at >= 0, `the arc-lead hole is folded into one block, got ${JSON.stringify(moves)}`)
  const circle = /^G3 X(-?[\d.]+) Y(-?[\d.]+) I(-?[\d.]+) J(-?[\d.]+)$/.exec(moves[at])
  assert.ok(circle, `the folded arc-lead hole spells its own G3, got ${moves[at]}`)
  const diameter = 2 * Math.hypot(Number(circle[3]), Number(circle[4]))
  assert.ok(diameter > 0 && diameter < 32, `the hole is under QtPlasmaC's 32 mm default, got ${diameter}`)
}

// Radius format: LinuxCNC makes an R arc whose end is its current point an
// error, so the fold is center-format only and an R machine keeps the ≤ 90°
// sub-arcs the emitted-arc fallback validated. Before this was fixed the same
// input came out as one closed R block the controller would refuse.
{
  const { result } = exportPlasma({
    ...PLASMA_EXPORT_SCENARIOS['small-hole'](),
    definition: (d) => ({ ...d, motion: { ...d.motion, arcFormat: 'r' as const } }),
  })
  assert.deepEqual(result.warnings, [], 'every R sub-arc survives emitted-arc validation')
  const moves = cuts(result.gcode)[0].moves
  const arcs = moves.filter((line) => / R-?[\d.]+$/.test(line))
  assert.ok(arcs.length > 1, `an R hole is not one closed block, got ${JSON.stringify(moves)}`)
  assert.ok(arcs.every((line) => !/\b[IJ]-?[\d.]/.test(line)), `every R arc carries a radius word only, got ${JSON.stringify(arcs)}`)
  assert.equal(foldedCircleIndex(moves), -1, 'no R arc ends where the previous block left the tool')
}

// An outside contour in the real exporter keeps its sub-arcs: its cut run is
// closed by the lead-out rather than by the fitted run itself, so there is no
// single closed G2 block for QtPlasmaC's "cut a hole clockwise?" warning. The
// clockwise guard itself is pinned by the fold unit test above.
{
  const { result } = exportPlasma(PLASMA_EXPORT_SCENARIOS['arc-lead-ins']())
  const moves = cuts(result.gcode)[0].moves
  const g2 = moves.filter((line) => line.startsWith('G2'))
  assert.equal(g2.length, 1, 'the clockwise disc still starts with an explicit G2')
  const end = /X(-?[\d.]+) Y(-?[\d.]+)/.exec(g2[0])!
  const before = /X(-?[\d.]+) Y(-?[\d.]+)/.exec(moves[moves.indexOf(g2[0]) - 1])!
  assert.ok(end[1] !== before[1] || end[2] !== before[2], 'the clockwise disc is not folded into a closed block')
}

// A milling operation in a plasma program is left out with a warning; the
// plasma cut around it is still written.
{
  const { input } = exportPlasma(PLASMA_EXPORT_SCENARIOS['single-outline']())
  const router = { ...defaultTool('mm'), id: 'mill', name: 'Mill' }
  const project = { ...input.project, tools: [...input.project.tools, router] }
  const pocket = { ...defaultOperationForTarget(project, 'pocket', 'rough', { source: 'features', featureIds: ['plate'] }, 0), id: 'pocket', name: 'Pocket', toolRef: 'mill' }
  const mixed = runPostProcessor({
    ...input,
    project,
    operations: [
      { operation: pocket, tool: normalizeToolForProject(router, project), toolpath: { operationId: 'pocket', moves: [{ kind: 'cut', from: { x: 0, y: 0, z: 0 }, to: { x: 5, y: 5, z: 0 } }], warnings: [], bounds: null } },
      ...input.operations,
    ],
  })
  assert.deepEqual(mixed.warnings, [{ code: 'postPlasmaOperationSkipped', params: { operation: 'Pocket' } }])
  assert.ok(!mixed.gcode.includes('Pocket'), 'nothing of the skipped operation is written')
  assert.equal(cuts(mixed.gcode).length, 1, 'the plasma cut is still written')
}

// Physical direction survives a mirrored machine axis (#957: outside contours
// clockwise viewed from above). The machine's own X runs the other way, so
// its coordinates mirror and every arc swaps G2/G3; mapped back through the
// same axis, the path turns the same way.
{
  const disc = PLASMA_EXPORT_SCENARIOS['arc-lead-ins']()
  const plain = cuts(exportPlasma(disc).result.gcode)[0].moves
  const mirrored = cuts(exportPlasma({ ...disc, definition: (d) => ({ ...d, coordinateSystem: { ...d.coordinateSystem, xAxis: '-X' } }) }).result.gcode)[0].moves
  const arcs = (moves: string[], word: string) => moves.filter((line) => line.startsWith(word)).length
  assert.ok(arcs(plain, 'G2') > 0, 'the disc is cut with clockwise arcs')
  assert.equal(arcs(mirrored, 'G3'), arcs(plain, 'G2'), 'mirrored X turns every G2 into a G3')
  assert.equal(arcs(mirrored, 'G2'), arcs(plain, 'G3'))
  // Linear moves only, to read the signed area straight off the program.
  const linear = { ...disc, operations: [{ featureIds: ['disc'], operation: { arcFittingEnabled: false } }] }
  const area = (gcode: string, flipX: boolean) => {
    const points = cuts(gcode)[0].moves.map((line) => {
      const x = Number(/X(-?[\d.]+)/.exec(line)![1])
      return { x: flipX ? -x : x, y: Number(/Y(-?[\d.]+)/.exec(line)![1]) }
    })
    return points.reduce((sum, p, i) => { const q = points[(i + 1) % points.length]; return sum + p.x * q.y - q.x * p.y }, 0) / 2
  }
  const unmirroredArea = area(exportPlasma(linear).result.gcode, false)
  const mirroredArea = area(exportPlasma({ ...linear, definition: (d) => ({ ...d, coordinateSystem: { ...d.coordinateSystem, xAxis: '-X' } }) }).result.gcode, true)
  assert.ok(unmirroredArea < 0, 'outside contour: clockwise viewed from above')
  assert.ok(Math.abs(mirroredArea - unmirroredArea) < 1e-6, 'the mirrored program, mapped back, cuts the same direction')
}

// The fold: a complete counter-clockwise circle becomes one closed block; a
// clockwise or open run is left exactly as it was.
{
  const arc = (from: number[], to: number[], clockwise: boolean, runId: number): ArcMoveDescriptor => ({
    kind: 'arc', startPoint: { x: from[0], y: from[1], z: 1 }, endPoint: { x: to[0], y: to[1], z: 1 },
    centerOffsets: { i: 0, j: 0 }, clockwise, runId, runFallback: [],
  })
  const square = (clockwise: boolean, runId: number, close: boolean) => [
    arc([0, 0], [1, 0], clockwise, runId),
    arc([1, 0], [1, 1], clockwise, runId),
    arc([1, 1], [0, 1], clockwise, runId),
    arc([0, 1], close ? [0, 0] : [0, 2], clockwise, runId),
  ]

  const folded = foldFullCircleArcs(square(false, 1, true))
  assert.equal(folded.length, 1, 'a complete counter-clockwise circle is one block')
  const only = folded[0]
  assert.ok(only.kind === 'arc' && only.endPoint.x === only.startPoint.x && only.endPoint.y === only.startPoint.y, 'the block ends on its own start')

  assert.equal(foldFullCircleArcs(square(true, 2, true)).length, 4, 'a clockwise complete circle stays split')
  assert.equal(foldFullCircleArcs(square(false, 3, false)).length, 4, 'an open counter-clockwise run stays split')
  const twoRuns = [...square(false, 4, true), ...square(false, 5, true)]
  const both = foldFullCircleArcs(twoRuns)
  assert.equal(both.length, 2, 'two runs are not merged across their run ids')
  assert.deepEqual(both.filter((d) => d.kind === 'linear'), [], 'no linear pass-through is invented')
  assert.deepEqual(foldFullCircleArcs([{ kind: 'linear', point: { x: 0, y: 0, z: 0 }, moveKind: 'cut' }]).length, 1, 'linear moves pass through')
}

// The cut planner: travel, then a cut from each plunge to the next rapid.
{
  const point = (x: number, y: number, z: number) => ({ x, y, z })
  const items = planPlasmaPath([
    { kind: 'linear', point: point(0, 0, 10), moveKind: 'rapid' },
    { kind: 'linear', point: point(0, 0, 3), moveKind: 'plunge' },
    { kind: 'linear', point: point(5, 0, 3), moveKind: 'lead_in' },
    { kind: 'linear', point: point(5, 5, 3), moveKind: 'cut' },
    { kind: 'linear', point: point(5, 5, 10), moveKind: 'rapid' },
    { kind: 'linear', point: point(9, 9, 10), moveKind: 'rapid' },
    { kind: 'linear', point: point(9, 1, 3), moveKind: 'cut' },
  ])
  assert.deepEqual(items.map((item) => item.kind), ['travel', 'cut', 'travel', 'travel', 'cut'])
  const [, first, , , second] = items
  assert.ok(first.kind === 'cut' && first.moves.length === 2 && first.pierce.x === 0 && first.pierce.y === 0)
  assert.ok(second.kind === 'cut' && second.pierce.x === 9 && second.pierce.y === 9, 'a cut with no plunge fires where the head already is')
}

// A rectangle helper sanity check keeps the fixtures honest.
assert.equal(rectangle(0, 0, 2, 3).segments.length, 4)

console.log('plasmaOutput.test.ts: QtPlasmaC handshake, torch pairs, no Z/F, skips, material range, small-hole fold in I/J and R, arc-lead hole, mirrored direction passed')
