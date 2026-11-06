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
 * Around sheet work over a turned section of a square bar (issue #1131).
 *
 * A Turn makes its section of a square blank round, so from there the Around
 * sheet describes a real surface. This suite drives the real store, generator
 * and postprocessor over a 12 mm square bar, 30 mm long along X, with a 10 mm
 * Turn from 5 to 25 mm, and checks each rule the issue names:
 *
 * 1. Coverage: sheet work is cut only where the feature — and the cutter's
 *    reach — lies over a section a Turn **above it in the tree** made round. A
 *    Turn below it, a Turn larger than the inscribed circle, a Polygon's flats
 *    and an uncut section are all refused, each with its reason.
 * 2. Authoring: the square sheet is drawable once some section is round.
 * 3. Generation: every rapid that moves along the bar or turns it travels at
 *    the corner envelope (`rotaryTravelZ`); the cutter stays over the Turn.
 * 4. Export: the generated program posts; a stale path, or one that turns a
 *    rapid under the envelope, is refused.
 * 5. Thread/Flutes measure from Turns above them in the tree only.
 * 6. "Starts above its surface": the warning, its one-click span and the
 *    crossing note, on round and square bars.
 * 7. The 3D scene folds only the square bar's cut rows.
 *
 * Run with: npx tsx src/engine/squareTurnedSheet.test.ts
 */

import assert from 'node:assert/strict'
import { defaultTool, newProject, rectProfile, roundStock } from '../types/project'
import type { Operation, Project, SketchFeature, Tool } from '../types/project'
import { squareStock } from '../types/barStock'
import { projectWithFeatures } from '../test/projectFixtures'
import { useProjectStore } from '../store/projectStore'
import { switchWorkspaceFace } from '../store/workspaceFace'
import { defaultOperationForTarget } from '../store/helpers/operationDefaults'
import { defaultRoundWorkholding } from '../store/helpers/roundWorkholding'
import { aroundSketchAuthoringAvailable } from '../store/helpers/activeFace'
import { operationCutsInProject } from '../store/helpers/projectType'
import { rotaryPatternSurfaceOfFeature, rotarySurfaceZ } from '../store/helpers/rotarySurface'
import {
  aroundSurfaceStarts,
  squareSheetFeatureBlock,
  squareSheetHasRoundSection,
} from '../store/helpers/turnedSheet'
import { resolvedProjectFeatures } from '../store/helpers/resolveFeatures'
import { computeOperationToolpath } from './toolpaths/generateOperation'
import { rotaryTravelZ } from './toolpaths/squareRotaryStock'
import { normalizeToolForProject } from './toolpaths/geometry'
import { warningSeverity } from './toolpaths/warningCodes'
import type { ToolpathResult } from './toolpaths/types'
import { featureReachableFromFace, setupGenerationBlock, targetAllowedInSetup } from './setupTargets'
import { squareSheetModelFilter } from './csg'
import { BUNDLED_DEFINITIONS } from './gcode/definitions'
import { runPostProcessor } from './gcode/postprocessor'
import { validateMachineDefinition } from './gcode/types'
import type { MachineDefinition, PostProcessorResult } from './gcode/types'

const store = () => useProjectStore.getState()

const SIDE = 12
const LENGTH = 30
const TURN = { start: 5, length: 20, diameter: 10 }
/** The Turn's surface: the bar axis (SIDE / 2) plus the Turn radius. */
const TURN_Z = SIDE / 2 + TURN.diameter / 2

function tool(id: string, type: Tool['type'], diameter: number): Tool {
  return {
    ...defaultTool('mm', 1),
    id,
    name: id,
    type,
    diameter,
    maxCutDepth: 10,
    vBitAngle: type === 'v_bit' ? 60 : null,
    defaultStepdown: 0.5,
    defaultStepover: 0.4,
  }
}

const FLAT = tool('flat-2', 'flat_endmill', 2)
const WIDE = tool('flat-12', 'flat_endmill', 12)
const VBIT = tool('vbit-3', 'v_bit', 3)

const GRBL = validateMachineDefinition(BUNDLED_DEFINITIONS.find((entry) => entry.id === 'grbl')!)
const ROTARY: MachineDefinition = validateMachineDefinition({
  ...structuredClone(GRBL),
  id: 'grbl-a',
  rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
})

/** A square (or round) rotary bar in the Around workspace, with a chuck and the tools. */
function barProject(shape: 'square' | 'round'): Project {
  const base = newProject(`Turned sheet ${shape}`, 'mm')
  base.meta.created = base.meta.modified = '2026-01-01T00:00:00.000Z'
  base.meta.projectType = 'rotary'
  // A clearance that clears a round bar's surface but not a square blank's
  // corners (6 + 8.49 mm from the axis): the sheet generators travel 1 mm over
  // the stock, so only the corner-envelope lift keeps a square path clear.
  base.meta.operationClearanceZ = 1
  const square = squareStock(SIDE, LENGTH, 'x')
  base.stock = shape === 'square' ? square : roundStock(SIDE, LENGTH, 'x')
  base.tools = [FLAT, WIDE, VBIT]
  const project = projectWithFeatures(base, [])
  project.setups.push({ ...project.setups[0]!, id: 'around', name: 'Around', kind: 'around', orientation: { axis: 'x', angleDeg: 0 } })
  project.activeSetupId = 'around'
  project.clamps = [{ ...defaultRoundWorkholding('chuck', base.stock as typeof square, 'mm'), id: 'chuck', name: 'Chuck', visible: true }]
  return project
}

/** An Around sheet feature: along X from `from` to `to`, a band across the zero line. */
function sheetFeature(
  id: string,
  from: number,
  to: number,
  zTop: number,
  zBottom: number,
  operation: SketchFeature['operation'] = 'subtract',
): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    operation,
    folderId: null,
    sketch: { profile: rectProfile(from, SIDE / 2 - 3, to - from, 6), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    z_top: zTop,
    z_bottom: zBottom,
    visible: true,
    locked: false,
    authoringFace: 'around',
  }
}

/** Load a bar, add the Turn through the real store, then append sheet rows below it. */
function turnedBar(shape: 'square' | 'round', rows: SketchFeature[], turn: Partial<typeof TURN> = {}): { project: Project; turnId: string } {
  store().loadProject(barProject(shape))
  assert.equal(switchWorkspaceFace('around'), true, 'the fixture enters Around')
  const created = store().addRotarySolid({ kind: 'turn', ...TURN, ...turn })
  assert.ok(created.ok, `the Turn is created: ${created.ok ? '' : created.reason}`)
  const project = projectWithFeatures(store().project, [...store().project.features, ...rows])
  store().loadProject(project)
  return { project: store().project, turnId: created.featureId }
}

function pocketOn(project: Project, featureId: string, toolRef: string): Operation {
  return {
    ...defaultOperationForTarget(project, 'pocket', 'rough', { source: 'features', featureIds: [featureId] }, 0),
    id: `pocket-${featureId}-${toolRef}`,
    setupId: 'around',
    toolRef,
  }
}

function post(project: Project, operation: Operation, toolpath: ToolpathResult): PostProcessorResult {
  const record = project.tools.find((entry) => entry.id === operation.toolRef)!
  return runPostProcessor({
    project,
    definition: ROTARY,
    operations: [{ operation, tool: normalizeToolForProject(record, project), toolpath }],
    options: { emitToolChanges: false, emitCoolant: false, programName: 'turned-sheet' },
  })
}

const errorsOf = (result: PostProcessorResult) => result.warnings.filter((warning) => warningSeverity(warning.code) === 'error')

// ── 1. Coverage ───────────────────────────────────────────────

{
  const { project, turnId } = turnedBar('square', [
    sheetFeature('over', 10, 20, TURN_Z, TURN_Z - 1),
    sheetFeature('partly', 20, 28, TURN_Z, TURN_Z - 1),
    sheetFeature('off', 26, 29, SIDE, SIDE - 1),
  ])
  assert.equal(squareSheetFeatureBlock(project, 'over'), null, 'a pocket wholly over the Turn is round')
  assert.equal(squareSheetFeatureBlock(project, 'partly'), 'uncut', 'a pocket that runs off the Turn is not')
  assert.equal(squareSheetFeatureBlock(project, 'off'), 'uncut', 'a pocket over the uncut square is not')
  assert.equal(squareSheetFeatureBlock(project, 'over', 4), null, 'the reach that stays on the Turn (10 ± 4 in 5..25) is admitted')
  assert.equal(squareSheetFeatureBlock(project, 'over', 6), 'uncut', 'a reach past the Turn end is refused')

  // The Turn must be above the work in the tree.
  store().moveFeatureTreeFeature('over', null, turnId)
  assert.equal(squareSheetFeatureBlock(store().project, 'over'), 'uncut', 'a Turn below the pocket in the tree has not cut it yet')
}

{
  // A Turn as large as the blank's side still makes it round (the flats touch
  // the circle); one larger only trims the corners.
  const exact = turnedBar('square', [sheetFeature('over', 10, 20, SIDE, SIDE - 1)], { diameter: SIDE })
  assert.equal(squareSheetFeatureBlock(exact.project, 'over'), null, 'a Turn at the full side is round')
  // The store refuses a Turn wider than the blank, but a placement can scale
  // one past the inscribed circle: about the bar's centre, so it stays coaxial.
  const scale = 1.2
  const scaled: Project = {
    ...exact.project,
    features: exact.project.features.map((feature) => feature.id !== exact.turnId ? feature : {
      ...feature,
      transform: { a: scale, b: 0, c: 0, d: scale, e: (1 - scale) * LENGTH / 2, f: (1 - scale) * SIDE / 2 },
    }),
  }
  assert.equal(squareSheetFeatureBlock(scaled, 'over'), 'uncut', 'a Turn larger than the inscribed circle leaves flats')
  assert.equal(squareSheetHasRoundSection(scaled), false, 'and the bar has no round section at all')
}

{
  // A Polygon above the pocket shapes its section into flats.
  const { project } = turnedBar('square', [])
  store().loadProject(project)
  assert.equal(switchWorkspaceFace('around'), true)
  const polygon = store().addRotarySolid({ kind: 'polygon', start: 8, length: 6, sides: 6, acrossFlats: 9 })
  assert.ok(polygon.ok, 'the Polygon is created')
  const withPocket = projectWithFeatures(store().project, [...store().project.features, sheetFeature('hex', 9, 13, 10, 9)])
  assert.equal(squareSheetFeatureBlock(withPocket, 'hex'), 'flats', 'a pocket over a Polygon reports its flats')
}

{
  // A round bar never asks the question.
  const { project } = turnedBar('round', [sheetFeature('off', 26, 29, SIDE, SIDE - 1)])
  assert.equal(squareSheetFeatureBlock(project, 'off'), null, 'a round bar is round everywhere')
}

// ── 2. Authoring ──────────────────────────────────────────────

{
  store().loadProject(barProject('square'))
  assert.equal(switchWorkspaceFace('around'), true)
  assert.equal(aroundSketchAuthoringAvailable(store().project), false, 'an uncut square sheet is not drawable')
  const created = store().addRotarySolid({ kind: 'turn', ...TURN })
  assert.ok(created.ok)
  assert.equal(aroundSketchAuthoringAvailable(store().project), true, 'a Turn makes the square sheet drawable')
  // The store accepts a drawn feature there now.
  const before = store().project.features.length
  store().addFeature(sheetFeature('drawn', 10, 20, TURN_Z, TURN_Z - 1))
  assert.equal(store().project.features.length, before + 1, 'a feature drawn on the turned square sheet is kept')
}

// ── 3. Eligibility and generation ─────────────────────────────

const { project: square } = turnedBar('square', [
  sheetFeature('over', 10, 20, TURN_Z, TURN_Z - 1),
  sheetFeature('off', 26, 29, SIDE, SIDE - 1),
])
const pocket = pocketOn(square, 'over', FLAT.id)
const wide = pocketOn(square, 'over', WIDE.id)
const off = pocketOn(square, 'off', FLAT.id)

{
  const overFeature = square.features.find((feature) => feature.id === 'over')!
  const offFeature = square.features.find((feature) => feature.id === 'off')!
  assert.equal(featureReachableFromFace(square, overFeature, 'around', 'pocket'), true, 'the turned pocket is a target')
  assert.equal(featureReachableFromFace(square, offFeature, 'around', 'pocket'), false, 'the uncut one is not')
  assert.equal(targetAllowedInSetup(square, pocket.target, 'around', 'pocket'), true, 'the store accepts the turned target')
  assert.equal(targetAllowedInSetup(square, off.target, 'around', 'pocket'), false, 'and refuses the uncut one')
  assert.equal(targetAllowedInSetup(square, { source: 'stock' }, 'around', 'pocket'), false, 'a stock target is never sheet work')

  assert.equal(setupGenerationBlock(square, pocket), null, 'the turned pocket generates')
  assert.equal(operationCutsInProject(square, pocket), true, 'and is part of the job')
  const wideBlock = setupGenerationBlock(square, wide)
  assert.equal(wideBlock?.reason, 'squareSectionNotRound', 'a cutter that reaches past the Turn is refused')
  assert.equal(wideBlock?.section, 'uncut')
  assert.equal(operationCutsInProject(square, wide), false, 'and is not part of the job')
  assert.equal(setupGenerationBlock(square, off)?.reason, 'squareSectionNotRound', 'the uncut pocket is refused')
}

const travelZ = rotaryTravelZ(square.stock as Parameters<typeof rotaryTravelZ>[0], 'mm')
const generated = computeOperationToolpath(square, pocket)!.result

{
  assert(generated.moves.length > 0, `the turned pocket has motion: ${JSON.stringify(generated.warnings)}`)
  assert(generated.moves.every((move) => move.from.a !== undefined && move.to.a !== undefined), 'every move is wrapped')
  for (const move of generated.moves) {
    if (move.kind !== 'rapid') continue
    const travels = Math.abs((move.to.a ?? 0) - (move.from.a ?? 0)) > 1e-9 || Math.abs(move.to.x - move.from.x) > 1e-9
    if (travels) {
      assert(Math.min(move.from.z, move.to.z) >= travelZ - 1e-9,
        `a travelling rapid stays at the corner envelope (${move.from.z} → ${move.to.z} under ${travelZ})`)
    }
  }
  assert(generated.moves.some((move) => move.kind !== 'rapid' && move.from.a !== move.to.a && Math.min(move.from.z, move.to.z) < TURN_Z),
    'the pocket cuts turns into the turned surface')
  for (const move of generated.moves) {
    if (Math.min(move.from.z, move.to.z) >= travelZ) continue
    assert(Math.min(move.from.x, move.to.x) - FLAT.diameter / 2 >= TURN.start - 1e-6
      && Math.max(move.from.x, move.to.x) + FLAT.diameter / 2 <= TURN.start + TURN.length + 1e-6,
    'the cutter body stays over the Turn')
  }
  const refused = computeOperationToolpath(square, wide)!.result
  assert.equal(refused.moves.length, 0, 'the wide cutter generates nothing')
  assert.equal(refused.warnings[0]?.code, 'squareSheetNotTurned', 'and says to turn the section round first')
  assert.equal(warningSeverity('squareSheetNotTurned'), 'error', 'which blocks the export')
}

{
  // The admission check grows the *feature* by the cutter radius; an outside
  // route runs a radius outside the feature, so its cutter reaches a radius
  // further still. Only the generated path shows that, and it is refused.
  const { project: routed } = turnedBar('square', [sheetFeature('island', 6.5, 23.5, TURN_Z, TURN_Z - 0.5, 'add')])
  const route: Operation = {
    ...defaultOperationForTarget(routed, 'edge_route_outside', 'rough', { source: 'features', featureIds: ['island'] }, 0),
    id: 'route', setupId: 'around', toolRef: FLAT.id,
  }
  assert.equal(setupGenerationBlock(routed, route), null, 'the island, grown by the cutter radius, is over the Turn')
  const result = computeOperationToolpath(routed, route)!.result
  assert.equal(result.moves.length, 0, 'but the route itself reaches past the Turn end, so nothing is cut')
  assert.equal(result.warnings[0]?.code, 'squareSheetNotTurned', 'and it says why')
}

{
  // The square blank's physical guard still applies to admitted sheet work: a
  // chuck smaller than the corner envelope cannot hold the blank as it turns.
  const small = { ...square, clamps: square.clamps.map((clamp) => ({ ...clamp, y: 0, h: SIDE, height: SIDE })) }
  const block = setupGenerationBlock(small, pocket)
  assert.equal(block?.reason, 'squareRotaryUnsupported', 'a too-small chuck refuses the turned pocket')
  assert.equal(block?.refusal?.reason, 'workholdingDiameter', 'and names the chuck')
}

{
  // Two pockets, each below its own Turn: A under Turn 1 only, B under both.
  // A move is not tagged with the target it cuts, so the whole path is judged
  // for A, the higher target: B's moves may not borrow Turn 2, which is below
  // A (#1131 review — an outside route with stock to leave could otherwise
  // pass A's moves off as B's). One operation per Turn cuts each.
  const { turnId: firstTurn } = turnedBar('square', [], { start: 9, length: 7 })
  const second = store().addRotarySolid({ kind: 'turn', start: 18, length: 8, diameter: TURN.diameter })
  assert.ok(second.ok, 'the second Turn is created')
  const twoTurns = projectWithFeatures(store().project, [
    ...store().project.features,
    sheetFeature('a', 11, 14, TURN_Z, TURN_Z - 0.5),
    sheetFeature('b', 20, 23, TURN_Z, TURN_Z - 0.5),
  ])
  store().loadProject(twoTurns)
  store().moveFeatureTreeFeature('a', null, second.featureId)
  const ordered = store().project
  assert.deepEqual(ordered.features.map((feature) => feature.id), [firstTurn, 'a', second.featureId, 'b'], 'the tree is Turn 1, A, Turn 2, B')
  const both: Operation = {
    ...defaultOperationForTarget(ordered, 'pocket', 'rough', { source: 'features', featureIds: ['a', 'b'] }, 0),
    id: 'both', setupId: 'around', toolRef: FLAT.id,
  }
  assert.equal(setupGenerationBlock(ordered, both), null, 'each target is over a Turn above it')
  const refused = computeOperationToolpath(ordered, both)!.result
  assert.equal(refused.moves.length, 0, 'but one path over both is judged for the higher target, and refused')
  assert.equal(refused.warnings[0]?.code, 'squareSheetNotTurned', 'with the turn-it-first reason')
  for (const featureId of ['a', 'b']) {
    const single: Operation = { ...both, id: `only-${featureId}`, target: { source: 'features', featureIds: [featureId] } }
    const cut = computeOperationToolpath(ordered, single)!.result
    assert(cut.moves.length > 0, `pocket ${featureId} on its own operation is cut: ${JSON.stringify(cut.warnings)}`)
  }
}

// ── 4. Export ─────────────────────────────────────────────────

{
  const program = post(square, pocket, generated)
  assert.deepEqual(errorsOf(program), [], `the turned pocket posts: ${JSON.stringify(program.warnings)}`)
  assert(program.gcode.includes(' A'), 'with A words')

  // A stale path: one cut point moved. The regenerate-and-match rule refuses it.
  const cutIndex = generated.moves.findIndex((move) => move.kind !== 'rapid')
  const stale = structuredClone(generated)
  stale.moves[cutIndex]!.to = { ...stale.moves[cutIndex]!.to, z: stale.moves[cutIndex]!.to.z - 0.1 }
  const staleProgram = post(square, pocket, stale)
  assert(staleProgram.warnings.some((warning) => warning.code === 'postSquareAroundToolpathStale'), 'a stale sheet path is refused')

  // A rapid that turns under the corner envelope sweeps a standing corner.
  const low = structuredClone(generated)
  const turning = low.moves.findIndex((move) => move.kind === 'rapid' && move.from.a !== move.to.a)
  assert(turning >= 0, 'the generated pocket has a turning rapid')
  low.moves[turning]!.from = { ...low.moves[turning]!.from, z: TURN_Z + 1 }
  low.moves[turning]!.to = { ...low.moves[turning]!.to, z: TURN_Z + 1 }
  const lowProgram = post(square, pocket, low)
  assert(lowProgram.warnings.some((warning) => warning.code === 'postRotarySquareTurnBelowEnvelope'), 'a low turning rapid is refused')

  // The same path with every angle stripped is stale XYZ motion, not a
  // shortcut past the checks above (#1131 review).
  const flat = structuredClone(generated)
  for (const move of flat.moves) {
    delete move.from.a
    delete move.to.a
  }
  const flatProgram = post(square, pocket, flat)
  assert(flatProgram.warnings.some((warning) => warning.code === 'postRotaryAngleNotEstablished'), 'an angle-free sheet path is refused')

  // An uncut section's operation never posts, whatever path it carries.
  const offProgram = post(square, off, generated)
  assert(offProgram.warnings.some((warning) => warning.code === 'postSetupOperationRefused'), 'an uncut section is refused at output')

  // The same angle-bearing path claimed by a Top operation is not admitted
  // sheet work, whatever its moves say.
  const topRow = { ...sheetFeature('flat', 10, 20, SIDE, SIDE - 1), authoringFace: 'top' as const }
  const withTop = projectWithFeatures(square, [...square.features, topRow])
  const onTop: Operation = {
    ...pocket, id: 'pocket-top', setupId: withTop.setups[0]!.id,
    target: { source: 'features', featureIds: ['flat'] },
  }
  assert.equal(setupGenerationBlock(withTop, onTop), null, 'a Top pocket on its own is not blocked')
  const topProgram = post(withTop, onTop, generated)
  assert(topProgram.warnings.some((warning) => warning.code === 'postSetupOperationRefused'), 'an A path on a Top operation is refused')

  // A V-bit engraving is sheet work too: any 2D cutter the generators use.
  const engraveTarget = { source: 'features' as const, featureIds: ['over'] }
  const engrave: Operation = {
    ...defaultOperationForTarget(square, 'v_carve', 'rough', engraveTarget, 0),
    id: 'carve', setupId: 'around', toolRef: VBIT.id,
  }
  const carved = computeOperationToolpath(square, engrave)!.result
  assert(carved.moves.length > 0, `the V-carve generates: ${JSON.stringify(carved.warnings)}`)
  assert.deepEqual(errorsOf(post(square, engrave, carved)), [], 'and posts with its V-bit')
}

// ── 5. Thread/Flutes take Turns above them only ───────────────

{
  store().loadProject(barProject('round'))
  assert.equal(switchWorkspaceFace('around'), true)
  const turn = store().addRotarySolid({ kind: 'turn', ...TURN })
  assert.ok(turn.ok)
  const thread = store().addRotaryPattern({ kind: 'thread', start: 8, length: 10, pitch: 1.5, starts: 1, depth: 0.5 })
  assert.ok(thread.ok, `the thread is created: ${thread.ok ? '' : thread.reason}`)
  const below = rotaryPatternSurfaceOfFeature(store().project, thread.featureId)
  assert.equal(below?.kind, 'turn', 'a thread below its Turn measures from the Turn')
  const threadRow = () => store().project.features.find((feature) => feature.id === thread.featureId)!
  assert.equal(threadRow().z_top, TURN_Z, 'and its span starts at the Turn surface')
  store().moveFeatureTreeFeature(thread.featureId, null, turn.featureId)
  const above = rotaryPatternSurfaceOfFeature(store().project, thread.featureId)
  assert.equal(above?.kind, 'bar', 'a thread above the Turn measures from the bar')
  assert.equal(threadRow().z_top, SIDE, 'and the sync moves its span back to the bar surface')
}

{
  // On a square bar, a thread over the Turn is authored and planned like a round one.
  store().loadProject(barProject('square'))
  assert.equal(switchWorkspaceFace('around'), true)
  const refusedFirst = store().addRotaryPattern({ kind: 'thread', start: 8, length: 10, pitch: 1.5, starts: 1, depth: 0.5 })
  assert.equal(refusedFirst.ok, false, 'a thread on an uncut square bar is refused')
  assert.ok(store().addRotarySolid({ kind: 'turn', ...TURN }).ok)
  const thread = store().addRotaryPattern({ kind: 'thread', start: 8, length: 10, pitch: 1.5, starts: 1, depth: 0.5 })
  assert.ok(thread.ok, 'and allowed once a Turn made its section round')
  assert.equal(squareSheetFeatureBlock(store().project, thread.featureId), null, 'the thread is over the turned section')
}

// ── 6. "Starts above its surface" ─────────────────────────────

for (const shape of ['round', 'square'] as const) {
  const { project, turnId } = turnedBar(shape, [
    sheetFeature('high', 10, 20, SIDE, SIDE - 1.5),
    sheetFeature('onTurn', 10, 20, TURN_Z, TURN_Z - 1),
    sheetFeature('crossing', 20, 28, SIDE, SIDE - 1),
    sheetFeature('plain', 26, 29, SIDE, SIDE - 1),
  ])
  const starts = aroundSurfaceStarts(project)
  const high = starts.get('high')
  assert.equal(high?.kind, 'above', `${shape}: a pocket at the bar surface over the Turn starts above it`)
  if (high?.kind === 'above') {
    assert.equal(high.distance, SIDE - TURN_Z, `${shape}: by the bar-to-Turn radius difference`)
    assert.equal(high.zTop, rotarySurfaceZ(project.stock, TURN.diameter), `${shape}: the fix starts at the Turn surface`)
    assert.equal(high.zBottom, SIDE - 1.5 - (SIDE - TURN_Z), `${shape}: and keeps the depth`)
  }
  assert.equal(starts.has('onTurn'), false, `${shape}: a pocket at the Turn surface does not warn`)
  assert.equal(starts.get('crossing')?.kind, 'crossing', `${shape}: a pocket across the Turn end says so, with no fix`)
  assert.equal(starts.has('plain'), false, `${shape}: a pocket on the plain bar does not warn`)

  // A Polygon below the pocket in the tree has not shaped the bar yet: the
  // pocket still sits on the Turn (#1131 review).
  const polygon = store().addRotarySolid({ kind: 'polygon', start: 12, length: 4, sides: 6, acrossFlats: 8 })
  assert.ok(polygon.ok, `${shape}: the Polygon is created below the pockets`)
  assert.equal(aroundSurfaceStarts(store().project).get('high')?.kind, 'above', `${shape}: a Polygon below the pocket does not change its surface`)

  // A line around the bar at one station has no along extent; it still sits
  // on the Turn and starts above it.
  const ring = {
    ...sheetFeature('ring', 20, 20, SIDE, SIDE - 0.5, 'line'),
    sketch: {
      profile: { start: { x: 20, y: SIDE / 2 - 3 }, segments: [{ type: 'line' as const, to: { x: 20, y: SIDE / 2 + 3 } }], closed: false },
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
    },
  }
  store().loadProject(projectWithFeatures(store().project, [...store().project.features, ring]))
  assert.equal(aroundSurfaceStarts(store().project).get('ring')?.kind, 'above', `${shape}: a circumferential line over the Turn warns too`)

  // The one-click fix is one write, so one undo step.
  const fix = high?.kind === 'above' ? high : null
  assert(fix)
  const historyBefore = store().history.past.length
  store().updateFeature('high', { z_top: fix.zTop, z_bottom: fix.zBottom })
  assert.equal(store().history.past.length, historyBefore + 1, `${shape}: the fix is one undo step`)
  assert.equal(aroundSurfaceStarts(store().project).has('high'), false, `${shape}: and clears the warning`)

  // Only Turns above the feature count.
  store().moveFeatureTreeFeature(turnId, null, null)
  assert.equal(aroundSurfaceStarts(store().project).size, 0, `${shape}: a Turn below every pocket warns about none`)
}

// ── 7. The 3D scene ───────────────────────────────────────────

{
  const resolved = resolvedProjectFeatures(square).filter((feature) => feature.authoringFace === 'around')
  const shown = squareSheetModelFilter(square, resolved).map((feature) => feature.id)
  assert.deepEqual(shown, ['over'], 'the square scene folds only the turned pocket')
  const { project: round } = turnedBar('round', [sheetFeature('off', 26, 29, SIDE, SIDE - 1)])
  const roundRows = resolvedProjectFeatures(round).filter((feature) => feature.authoringFace === 'around')
  assert.equal(squareSheetModelFilter(round, roundRows), roundRows, 'a round bar keeps its list unchanged')
}

console.log('squareTurnedSheet: all assertions passed.')
