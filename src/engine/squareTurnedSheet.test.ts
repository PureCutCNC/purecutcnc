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
import { circleProfile, defaultTool, newProject, rectProfile, roundStock } from '../types/project'
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
  operationTurnSurfaceRadius,
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
import { buildBarModelSolid, getManifoldModule, squareSheetModelFilter } from './csg'
import { modelFeatures } from '../store/helpers/featureRoles'
import { resolveCannedShapeShapes } from '../cannedShapes'
import { SLOT_CANNED_KIND } from '../cannedShapes/generators/kinds'
import { rotarySolidFrame } from '../cannedShapes/generators/rotarySolidParams'
import { rotarySolidCannedData } from '../store/helpers/rotarySolids'
import { aroundFrame, acrossScaledAroundProject, surfaceAroundFrame } from './aroundFrame'
import { captureCacheInputs, cacheInputsValid } from '../app/toolpathGeneration/cacheInputs'
import type { SketchProfile } from '../types/project'
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
const DRILL = { ...tool('drill-2', 'drill', 2), defaultPlungeFeed: 60 }

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
  base.tools = [FLAT, WIDE, VBIT, DRILL]
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

// ── 8. A pocket that starts on the Turn surface opens in 3D ───
//
// Frank's retest of #1163: a pocket whose Z top is exactly the Turn's surface
// (what "Start at turn surface" writes) was drawn under a skin, because the cut
// was coplanar with the Turn. The 3D build pushes such a subtract past its top;
// the stored span and the toolpath are untouched. The check: inside the
// pocket's footprint the folded model keeps only the floor — no face is left
// near the Turn's radius.

const manifold = await getManifoldModule()

/** Largest radius of any model face whose centre lies inside the footprint (inset). */
function highestFaceInside(project: Project, from: number, to: number, halfAcross: number, below = Number.POSITIVE_INFINITY): number {
  const resolved = resolvedProjectFeatures(project).filter((feature) => feature.visible)
  const flat = modelFeatures(resolved.filter((feature) => feature.authoringFace !== 'around'))
  const around = squareSheetModelFilter(project, modelFeatures(resolved.filter((feature) => feature.authoringFace === 'around')))
  const solid = buildBarModelSolid(manifold, project, flat, around)
  assert(solid, 'the bar folds into a model')
  const mesh = solid.getMesh()
  const centre = SIDE / 2
  let highest = 0
  for (let tri = 0; tri < mesh.numTri; tri += 1) {
    let x = 0
    let y = 0
    let z = 0
    for (let corner = 0; corner < 3; corner += 1) {
      const offset = mesh.triVerts[tri * 3 + corner]! * mesh.numProp
      x += mesh.vertProperties[offset]! / 3
      y += mesh.vertProperties[offset + 1]! / 3
      z += mesh.vertProperties[offset + 2]! / 3
    }
    const across = y - centre
    const up = z - centre
    const radius = Math.hypot(across, up)
    // The footprint's across extent is sheet length on the reference cylinder
    // (radius SIDE / 2), centred on the top line (a = 0).
    const sheetAcross = Math.atan2(across, up) * (SIDE / 2)
    if (x > from + 0.5 && x < to - 0.5 && Math.abs(sheetAcross) < halfAcross - 0.5 && radius < below) {
      highest = Math.max(highest, radius)
    }
  }
  solid.delete()
  return highest
}

for (const shape of ['round', 'square'] as const) {
  const turnRadius = TURN.diameter / 2
  const { project } = turnedBar(shape, [sheetFeature('flush', 10, 20, TURN_Z, TURN_Z - 1)])
  const top = highestFaceInside(project, 10, 20, 3)
  assert(top < turnRadius - 0.5,
    `${shape}: a pocket at the Turn surface is open — the highest face inside it is at r ${top.toFixed(3)}, the floor is ${turnRadius - 1}`)
}

{
  // A pocket at the plain round bar's surface keeps opening as before.
  const { project } = turnedBar('round', [sheetFeature('plain', 27, 29.5, SIDE, SIDE - 1)])
  const top = highestFaceInside(project, 27, 29.5, 3)
  assert(top < SIDE / 2 - 0.5, `a pocket at the bar surface is open (highest face r ${top.toFixed(3)})`)
}

{
  // A pocket that starts below the Turn surface is not pushed: its top stays
  // where it is drawn, with material above it.
  const { project } = turnedBar('round', [sheetFeature('buried', 10, 20, TURN_Z - 0.5, TURN_Z - 1)])
  const top = highestFaceInside(project, 10, 20, 3)
  assert(Math.abs(top - (TURN.diameter / 2)) < 0.3, `a buried pocket leaves the Turn surface over it (highest face r ${top.toFixed(3)})`)
  // Its own ceiling is where it was drawn (r 4.5), not pushed outward.
  const ceiling = highestFaceInside(project, 10, 20, 3, TURN.diameter / 2 - 0.3)
  assert(Math.abs(ceiling - (TURN.diameter / 2 - 0.5)) < 0.02, `the buried pocket's ceiling stays at r ${TURN.diameter / 2 - 0.5} (got ${ceiling.toFixed(3)})`)
}

// ── 9. Across the bar, work on a Turn is planned at the Turn's radius ──
//
// Frank's retest of #1163: V-carved text on a Turn came out with rounded stroke
// ends. The sheet is drawn on the reference cylinder (radius SIDE / 2), but the
// cut happens on the Turn (radius TURN.diameter / 2), where a sheet distance
// across the bar is physically shorter by their ratio. Generators plan cones
// and offsets in sheet units, so they cut that much too wide across. Planning
// across at the Turn's radius makes the physical cut what was asked for;
// angles and heights are unchanged (Frank, 2026-11-06: "keep Z as is").

/** Physical across distance from the zero line, on the Turn, of a wrapped point. */
function acrossOnTurn(point: { a?: number }): number {
  return ((point.a ?? 0) * Math.PI / 180) * (TURN.diameter / 2)
}

const RATIO = (TURN.diameter / 2) / (SIDE / 2)
const ZERO = SIDE / 2

for (const shape of ['round', 'square'] as const) {
  // A stroke 11 long and 2 wide on the sheet, centred on the zero line, on the
  // Turn and clear of the chuck's keep-out. Physically it is 2 · RATIO wide.
  const stroke: SketchFeature = {
    ...sheetFeature('stroke', 12, 23, TURN_Z, TURN_Z - 3),
    sketch: { profile: rectProfile(12, ZERO - 1, 11, 2), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
  }
  const { project } = turnedBar(shape, [stroke])
  const carve: Operation = {
    ...defaultOperationForTarget(project, 'v_carve_medial', 'rough', { source: 'features', featureIds: ['stroke'] }, 0),
    id: 'carve-stroke', setupId: 'around', toolRef: VBIT.id, maxCarveDepth: 3,
  }
  const result = computeOperationToolpath(project, carve)!.result
  assert(result.moves.length > 0, `${shape}: the stroke carves: ${JSON.stringify(result.warnings)}`)
  const cuts = result.moves.filter((move) => move.kind !== 'rapid')
  const deepest = Math.min(...cuts.flatMap((move) => [move.from.z, move.to.z]))
  const halfAngle = Math.PI / 6
  const physicalHalfWidth = RATIO * 1
  assert(Math.abs((TURN_Z - deepest) * Math.tan(halfAngle) - physicalHalfWidth) < 0.02,
    `${shape}: the carve's deepest cone spans the stroke's physical half-width ${physicalHalfWidth.toFixed(3)} (got ${((TURN_Z - deepest) * Math.tan(halfAngle)).toFixed(3)})`)
  // Heights keep their meaning: the carve still travels at the bar's safe
  // height (bar surface + clearance), not one measured from the Turn.
  const lowestRapid = Math.min(...result.moves.filter((move) => move.kind === 'rapid'
    && (move.from.x !== move.to.x || move.from.a !== move.to.a)).flatMap((move) => [move.from.z, move.to.z]))
  assert(lowestRapid >= SIDE + project.meta.operationClearanceZ - 1e-6,
    `${shape}: travel stays at the bar's safe height (${lowestRapid.toFixed(3)})`)
  // Every corner is reached at the surface: a branch ends there.
  const atSurface = cuts.flatMap((move) => [move.from, move.to]).filter((point) => point.z >= TURN_Z - 1e-3)
  for (const [along, across] of [[12, -1], [12, 1], [23, -1], [23, 1]] as const) {
    const target = across * RATIO
    const nearest = Math.min(...atSurface.map((point) => Math.hypot(point.x - along, acrossOnTurn(point) - target)))
    assert(nearest < 0.05, `${shape}: the carve reaches the corner (${along}, ${across}) at the surface (nearest ${nearest.toFixed(3)})`)
  }

  // A pocket's walls are a cutter radius in from the outline, physically,
  // across and along.
  const box: SketchFeature = {
    ...sheetFeature('box', 12, 23, TURN_Z, TURN_Z - 0.5),
    sketch: { profile: rectProfile(12, ZERO - 3, 11, 6), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
  }
  const { project: boxed } = turnedBar(shape, [box])
  const pocketOp = pocketOn(boxed, 'box', FLAT.id)
  const pocketed = computeOperationToolpath(boxed, pocketOp)!.result
  const floor = pocketed.moves.filter((move) => move.kind !== 'rapid' && Math.max(move.from.z, move.to.z) < TURN_Z - 1e-3)
  assert(floor.length > 0, `${shape}: the pocket cuts: ${JSON.stringify(pocketed.warnings)}`)
  const points = floor.flatMap((move) => [move.from, move.to])
  const radius = FLAT.diameter / 2
  const acrossEdge = 3 * RATIO
  const widestAcross = Math.max(...points.map((point) => Math.abs(acrossOnTurn(point))))
  assert(Math.abs(widestAcross - (acrossEdge - radius)) < 0.01,
    `${shape}: the pocket wall across is a cutter radius in, physically (${widestAcross.toFixed(3)} vs ${(acrossEdge - radius).toFixed(3)})`)
  const firstAlong = Math.min(...points.map((point) => point.x))
  assert(Math.abs(firstAlong - (12 + radius)) < 0.01, `${shape}: and along (${firstAlong.toFixed(3)})`)
  // Heights keep their meaning: the floor is where the span says.
  const deepestFloor = Math.min(...points.map((point) => point.z))
  assert(Math.abs(deepestFloor - (TURN_Z - 0.5)) < 1e-6, `${shape}: the pocket floor is at its Z bottom (${deepestFloor})`)
}

{
  // Work on the plain bar keeps the reference sheet, byte for byte.
  const { project } = turnedBar('round', [sheetFeature('plainBox', 26, 29.5, SIDE, SIDE - 0.5)])
  const plainOp = pocketOn(project, 'plainBox', FLAT.id)
  const referenceProject: Project = { ...project, features: project.features.filter((feature) => feature.authoringFace === 'around') }
  assert.deepEqual(computeOperationToolpath(project, plainOp)!.result.moves,
    computeOperationToolpath(referenceProject, plainOp)!.result.moves, 'a pocket off the Turn is planned as before')
}

{
  // A canned slot keeps its round ends under the across-the-bar scale: each
  // cap becomes half of an ellipse, as long along the bar as before (#1131
  // review — a scaled arc kept as a circle shrank the slot's ends along too).
  const sample = (profile: SketchProfile): Array<{ x: number; y: number }> => {
    const points: Array<{ x: number; y: number }> = [profile.start]
    let from = profile.start
    for (const segment of profile.segments) {
      for (let step = 1; step <= 16; step += 1) {
        const t = step / 16
        if (segment.type === 'bezier') {
          const u = 1 - t
          points.push({
            x: u * u * u * from.x + 3 * u * u * t * segment.control1.x + 3 * u * t * t * segment.control2.x + t * t * t * segment.to.x,
            y: u * u * u * from.y + 3 * u * u * t * segment.control1.y + 3 * u * t * t * segment.control2.y + t * t * t * segment.to.y,
          })
        } else if (segment.type === 'arc' || segment.type === 'circle') {
          const radius = Math.hypot(from.x - segment.center.x, from.y - segment.center.y)
          const start = Math.atan2(from.y - segment.center.y, from.x - segment.center.x)
          const end = segment.type === 'circle' ? start + (segment.clockwise ? -2 : 2) * Math.PI
            : Math.atan2(segment.to.y - segment.center.y, segment.to.x - segment.center.x)
          let sweep = end - start
          if (segment.type === 'arc' && segment.clockwise && sweep > 0) sweep -= 2 * Math.PI
          if (segment.type === 'arc' && !segment.clockwise && sweep < 0) sweep += 2 * Math.PI
          points.push({ x: segment.center.x + radius * Math.cos(start + sweep * t), y: segment.center.y + radius * Math.sin(start + sweep * t) })
        } else {
          points.push({ x: from.x + (segment.to.x - from.x) * t, y: from.y + (segment.to.y - from.y) * t })
        }
      }
      from = segment.to
    }
    return points
  }
  const slotLength = 6
  const slotWidth = 2
  const placed = { a: 1, b: 0, c: 0, d: 1, e: 17, f: ZERO }
  const frame = aroundFrame(squareStock(SIDE, LENGTH, 'x'))
  const scaled = acrossScaledAroundProject({
    features: [{ id: 'slot', authoringFace: 'around', transform: placed }],
  } as unknown as Project, frame, RATIO).features[0]!.transform
  const shapes = resolveCannedShapeShapes({
    canned: { kind: SLOT_CANNED_KIND, params: { length: slotLength, width: slotWidth } },
    transform: scaled,
    operation: 'subtract',
  } as Parameters<typeof resolveCannedShapeShapes>[0])
  assert(shapes.length > 0, 'the slot resolves')
  const points = shapes.flatMap((shape) => sample(shape.profile))
  const alongReach = Math.max(...points.map((point) => point.x)) - 17
  const acrossReach = Math.max(...points.map((point) => point.y)) - ZERO
  assert(Math.abs(alongReach - (slotLength / 2 + slotWidth / 2)) < 1e-3, `the scaled slot is as long as before (${alongReach.toFixed(4)})`)
  assert(Math.abs(acrossReach - RATIO * slotWidth / 2) < 1e-3, `and its width is scaled across (${acrossReach.toFixed(4)})`)
}

{
  // A cached path planned at one Turn's radius is stale once that Turn's
  // diameter changes, although nothing overlapping the pocket's footprint did.
  // The pocket sits a third of a turn round the bar, across the sheet from the
  // Turn's side-view silhouette, so their world-XY footprints do not meet.
  const farSide: SketchFeature = {
    ...sheetFeature('cached', 12, 23, TURN_Z, TURN_Z - 0.5),
    sketch: { profile: rectProfile(12, ZERO + 14, 11, 2), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
  }
  const { project, turnId } = turnedBar('round', [farSide])
  const cachedOp = pocketOn(project, 'cached', FLAT.id)
  const inputs = captureCacheInputs(project, cachedOp)
  assert.equal(cacheInputsValid(inputs, cachedOp, project), true, 'the cache holds for the same project')
  const frame = rotarySolidFrame(project)
  assert(frame, 'the bar has a rotary frame')
  const smaller = rotarySolidCannedData(frame, { kind: 'turn', ...TURN, diameter: TURN.diameter - 2 }, 'mm')
  assert(smaller, 'the smaller Turn builds')
  store().updateFeature(turnId, { canned: smaller })
  assert.equal(cacheInputsValid(inputs, cachedOp, store().project), false, 'a Turn diameter change invalidates the cached pocket')
  // Moving the Turn changes no mesh and nothing in the pocket's footprint, but
  // the pocket is no longer wholly on it, so it is planned on the reference
  // sheet again: the cache must see that.
  const moved: Project = {
    ...project,
    features: project.features.map((feature) => feature.id !== turnId ? feature : {
      ...feature,
      transform: { ...feature.transform, e: feature.transform.e + 8 },
    }),
  }
  assert.equal(operationTurnSurfaceRadius(moved, cachedOp), null, 'the moved Turn no longer carries the whole pocket')
  assert.equal(cacheInputsValid(inputs, cachedOp, moved), false, 'moving the Turn invalidates the cached pocket')
}

{
  // Angles are unchanged: a pocket a quarter turn round the bar on the Turn is
  // cut at A 90 exactly as on the reference sheet.
  const quarter = Math.PI * SIDE / 4
  const side: SketchFeature = {
    ...sheetFeature('quarter', 12, 23, TURN_Z, TURN_Z - 0.5),
    sketch: { profile: rectProfile(12, ZERO + quarter - 1.5, 11, 3), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
  }
  const { project } = turnedBar('round', [side])
  const cuts = computeOperationToolpath(project, pocketOn(project, 'quarter', FLAT.id))!.result.moves.filter((move) => move.kind !== 'rapid')
  const angles = cuts.flatMap((move) => [move.from.a ?? NaN, move.to.a ?? NaN])
  const middle = (Math.min(...angles) + Math.max(...angles)) / 2
  assert(Math.abs(middle - 90) < 1e-3, `a quarter-turn pocket on the Turn is centred at A 90 (got ${middle})`)
}

{
  // The scaled sheet is centred on the zero line, as the reference one is.
  const frame = aroundFrame(roundStock(SIDE, LENGTH, 'x'))
  const scaled = surfaceAroundFrame(frame, TURN.diameter / 2)
  assert(Math.abs(scaled.circumference - frame.circumference * RATIO) < 1e-12, 'the circumference scales by the radius ratio')
  assert(Math.abs(scaled.sheetStart - (frame.zero - scaled.circumference / 2)) < 1e-12, 'and the sheet edge stays half of it below the zero line')
  assert.equal(scaled.radius, frame.radius, 'heights keep the reference radius')
}

{
  // Two targets on two Turns of different diameters share no surface: the
  // operation keeps the reference sheet rather than one Turn's radius.
  const { project: one } = turnedBar('round', [], { start: 9, length: 7 })
  store().loadProject(one)
  assert.equal(switchWorkspaceFace('around'), true)
  const other = store().addRotarySolid({ kind: 'turn', start: 18, length: 8, diameter: TURN.diameter - 2 })
  assert.ok(other.ok, 'the second Turn is created')
  const both = projectWithFeatures(store().project, [
    ...store().project.features,
    sheetFeature('left', 11, 14, TURN_Z, TURN_Z - 0.5),
    sheetFeature('right', 20, 23, TURN_Z - 1, TURN_Z - 1.5),
  ])
  const pair = { target: { source: 'features' as const, featureIds: ['left', 'right'] } }
  assert.equal(operationTurnSurfaceRadius(both, pair), null, 'targets on two diameters keep the reference sheet')
  assert.equal(operationTurnSurfaceRadius(both, { target: { source: 'features', featureIds: ['left'] } }), TURN.diameter / 2, 'one of them alone is on its Turn')
}

{
  // Drilling is not re-planned on the Turn: a hole is a plunge at its centre,
  // and the across-only scale would turn its circle into an ellipse no drill
  // cycle can target.
  const hole: SketchFeature = {
    ...sheetFeature('hole', 16, 18, TURN_Z, TURN_Z - 1),
    kind: 'circle',
    sketch: { profile: circleProfile(17, ZERO, 1), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
  }
  const { project } = turnedBar('round', [hole])
  const drill: Operation = {
    ...defaultOperationForTarget(project, 'drilling', 'rough', { source: 'features', featureIds: ['hole'] }, 0),
    id: 'drill-hole', setupId: 'around', toolRef: DRILL.id,
  }
  const drilled = computeOperationToolpath(project, drill)!.result
  assert(drilled.moves.length > 0, `the hole on the Turn is drilled: ${JSON.stringify(drilled.warnings)}`)
}

console.log('squareTurnedSheet: all assertions passed.')
