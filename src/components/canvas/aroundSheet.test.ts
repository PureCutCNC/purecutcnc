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
 * The unrolled sheet the Around view reads (issue #395 slice D2): both bar
 * axes, an off-origin bar, an inch bar, the turn lines for a range that runs
 * past the sheet, the clamp bands and the origin marker — and null on Top, on
 * Bottom and on a block.
 *
 * Mutations checked one at a time against these assertions:
 * - the sheet one diameter across instead of one circumference → "the sheet is
 *   one circumference across" fails;
 * - the sheet swapped for a Y bar (X/Y swapped) → the Y-bar assertions fail;
 * - turn lines limited to the sheet → "a range past the sheet keeps its turns"
 *   fails;
 * - `k = 0` not solid → "the start line is the only solid turn" fails;
 * - clamp bands keeping their own across extent → "a band spans the sheet
 *   across" fails;
 * - the band not following the visible range → "a band spans the whole visible
 *   range across" fails;
 * - the origin marker keeping the bar's across coordinate → "the origin lands
 *   on the start line" fails;
 * - null checks removed → the Top/Bottom/block assertions fail.
 *
 * Run with: npx tsx src/components/canvas/aroundSheet.test.ts
 */

import { DEFAULT_SETUP_ID, newProject, rectProfile, roundStock } from '../../types/project'
import type { Clamp, MachiningSetup, Project, RoundStock, SketchFeature, SketchProfile } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import {
  aroundClampBand,
  aroundOrigin,
  aroundSheet,
  aroundSheetForOperation,
  aroundSheetStock,
  aroundTurnLines,
  authoredOnFace,
} from './aroundSheet'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

function near(actual: number, expected: number, message: string, epsilon = 1e-9): void {
  assert(Math.abs(actual - expected) <= epsilon, `${message}: ${actual} != ${expected}`)
}

const X_BAR = roundStock(40, 200, 'x', { x: 10, y: 30 })
const Y_BAR = roundStock(2, 8, 'y', { x: 3, y: 5 })

function aroundSetup(stock: RoundStock, id = 'setup-around'): MachiningSetup {
  return {
    id,
    name: 'Around',
    kind: 'around',
    orientation: { axis: stock.axis, angleDeg: 0 },
    indexing: 'manual',
    registration: [],
    notes: '',
    operationIds: [],
  }
}

function clamp(id: string, type: Clamp['type']): Clamp {
  return { id, name: id, type, x: 100, y: 40, w: 30, h: 20, height: 25, visible: true }
}

function aroundProject(stock: RoundStock, clamps: Clamp[] = [], activeSetupId?: string): Project {
  const base = newProject()
  const setup = aroundSetup(stock)
  return {
    ...base,
    stock,
    clamps,
    origin: { ...base.origin, x: 55, y: 62 },
    setups: [...base.setups, setup],
    activeSetupId: activeSetupId ?? setup.id,
  }
}

// ── Both bar axes ─────────────────────────────────────────────

{
  const sheet = aroundSheet(aroundProject(X_BAR))
  assert(sheet !== null, 'a bar on Around has a sheet')
  const frame = sheet!
  assert(frame.axis === 'x', 'an X bar keeps X as the along axis')
  near(frame.sheetStart, 30, 'the sheet starts at the bar minimum across')
  near(frame.circumference, 40 * Math.PI, 'the circumference is pi times the diameter')
  near(frame.radius, 20, 'the radius is half the diameter')
  near(frame.centre, 50, 'the frame carries the bar centreline')
  assert(JSON.stringify(frame.rect) === JSON.stringify({ minX: 10, maxX: 210, minY: 30, maxY: 30 + 40 * Math.PI }),
    `the sheet is one circumference across: ${JSON.stringify(frame.rect)}`)
  assert(JSON.stringify(frame.along) === JSON.stringify({ min: 10, max: 210 }), 'the sheet keeps the bar extent along')
}

{
  const frame = aroundSheet(aroundProject(Y_BAR))!
  assert(frame.axis === 'y', 'a Y bar keeps Y as the along axis')
  near(frame.sheetStart, 3, 'the sheet starts at the bar minimum across (X)')
  near(frame.circumference, 2 * Math.PI, 'the Y bar circumference')
  assert(JSON.stringify(frame.rect) === JSON.stringify({ minX: 3, maxX: 3 + 2 * Math.PI, minY: 5, maxY: 13 }),
    `X and Y are never swapped: ${JSON.stringify(frame.rect)}`)
  assert(JSON.stringify(frame.along) === JSON.stringify({ min: 5, max: 13 }), 'the Y bar keeps its length along Y')
  assert(frame.origin.x === 3 && frame.origin.y === 62, 'the Y origin lands on the start line at its along coordinate')
}

// ── An across coordinate that is off the origin ──────────────

{
  const offOrigin = roundStock(40, 200, 'x', { x: -120, y: -35 })
  const frame = aroundSheet(aroundProject(offOrigin))!
  near(frame.sheetStart, -35, 'the sheet starts at the bar minimum across, wherever that is')
  assert(JSON.stringify(frame.rect) === JSON.stringify({ minX: -120, maxX: 80, minY: -35, maxY: -35 + 40 * Math.PI }),
    `an off-origin bar frames the sheet where the bar is: ${JSON.stringify(frame.rect)}`)
}

// ── An inch bar ──────────────────────────────────────────────

{
  const inch = newProject('inch part', 'inch')
  const stock = roundStock(0.75, 4, 'x', { x: 0, y: 0 })
  const project: Project = { ...inch, stock, activeSetupId: aroundSetup(stock).id, setups: [...inch.setups, aroundSetup(stock)] }
  const frame = aroundSheet(project)!
  near(frame.circumference, 0.75 * Math.PI, 'an inch bar circumference is pi times its inch diameter')
  near(frame.rect.maxY - frame.rect.minY, 0.75 * Math.PI, 'the inch sheet is one circumference tall')
}

// ── Turn lines for a visible range ───────────────────────────

{
  const frame = aroundSheet(aroundProject(X_BAR))!
  // No range given: only the sheet's own two edges are turns.
  assert(frame.turnLines.length === 2, `the sheet edges are the default turns (${frame.turnLines.length})`)
  assert(frame.turnLines[0].solid && frame.turnLines[0].across === frame.sheetStart, 'k = 0 is the start line, solid')
  assert(!frame.turnLines[1].solid, 'k = 1 is a plain dashed turn on the far edge')

  const c = frame.circumference
  const lines = aroundTurnLines(frame, frame.sheetStart - c, frame.sheetStart + 3 * c)
  assert(lines.length === 5, `a range one turn before to three after has five turns (${lines.length})`)
  assert(lines.map((line) => Math.round((line.across - frame.sheetStart) / c)).join(',') === '-1,0,1,2,3',
    `the turns are every integer k in range: ${lines.map((line) => line.across).join(',')}`)
  assert(lines.filter((line) => line.solid).length === 1 && lines[1].solid, 'the start line is the only solid turn')
  const beyond = aroundTurnLines(frame, frame.sheetStart + 0.2 * c, frame.sheetStart + 2.8 * c)
  assert(beyond.length === 2 && beyond.every((line) => !line.solid), 'turns beyond the sheet are drawn, none solid')
}

// ── Clamp bands ──────────────────────────────────────────────

{
  const project = aroundProject(X_BAR, [clamp('chuck', 'chuck'), clamp('tail', 'tailstock'), clamp('step', 'step_clamp'), clamp('vise', 'vise_jaw')])
  const frame = aroundSheet(project)!
  assert(frame.clampBands.length === 2, `only a chuck and a tailstock are bands (${frame.clampBands.length})`)
  const chuck = frame.clampBands.find((band) => band.id === 'chuck')!
  near(chuck.y, frame.sheetStart, 'a band starts on the start line')
  near(chuck.h, frame.circumference, 'a band spans the whole sheet across')
  near(chuck.x, 100, 'a band keeps its extent along the bar')
  near(chuck.w, 30, 'a band keeps its length along the bar')
  assert(!frame.clampBands.some((band) => band.id === 'step'), 'other clamp types are left out')

  const yBand = aroundClampBand(clamp('chuck', 'chuck'), { axis: 'y', sheetStart: 3, circumference: 2 * Math.PI })
  near(yBand.x, 3, 'a Y bar band starts on the start line (X)')
  near(yBand.w, 2 * Math.PI, 'a Y bar band spans the sheet across (X)')
  near(yBand.y, 40, 'a Y bar band keeps its extent along the bar (Y)')

  // The band is drawn and snapped across the whole visible range, like the
  // turn lines: a view spanning three turns gives a band three turns tall.
  const c = frame.circumference
  const wide = aroundSheet(project, { acrossMin: frame.sheetStart - c, acrossMax: frame.sheetStart + 2 * c })!
  const wideChuck = wide.clampBands.find((band) => band.id === 'chuck')!
  near(wideChuck.y, frame.sheetStart - c, 'a band starts at the visible range start')
  near(wideChuck.h, 3 * c, 'a band spans the whole visible range across')
  const yWide = aroundClampBand(
    clamp('chuck', 'chuck'),
    { axis: 'y', sheetStart: 3, circumference: 2 * Math.PI },
    { acrossMin: 3 - 2 * Math.PI, acrossMax: 3 + 4 * Math.PI },
  )
  near(yWide.x, 3 - 2 * Math.PI, 'a Y bar band starts at the visible range start (X)')
  near(yWide.w, 6 * Math.PI, 'a Y bar band spans the whole visible range across (X)')
}

// ── Origin marker ────────────────────────────────────────────

{
  const project = aroundProject(X_BAR)
  const frame = aroundSheet(project)!
  assert(frame.origin.x === 55 && frame.origin.y === 30,
    `the origin marker is on the start line at its along coordinate: ${JSON.stringify(frame.origin)}`)
  assert(frame.origin.name === project.origin.name, 'the origin marker keeps the origin name the canvas labels it with')
  const yMarker = aroundOrigin({ x: 1, y: 2 }, { axis: 'y', sheetStart: 7 })
  assert(JSON.stringify(yMarker) === JSON.stringify({ x: 7, y: 2 }), 'the Y origin marker uses Y as the along coordinate')
}

// ── The sheet as a stock ─────────────────────────────────────

{
  const project = aroundProject(X_BAR)
  const frame = aroundSheet(project)!
  const stock = aroundSheetStock(project.stock, frame)
  assert(stock.profile.closed, 'the sheet stock profile is closed')
  near(stock.profile.start.x, frame.rect.minX, 'the sheet stock starts at the sheet corner')
  near(stock.thickness, frame.radius, 'the sheet stock is the unrolled thickness (the radius)')
  assert(stock.color === project.stock.color && stock.material === project.stock.material, 'the sheet keeps the stock look')
  assert(!('axis' in stock) && !('shape' in stock), 'the sheet stock is a block, carrying neither bar axis nor source feature')
}

// ── The operation's own sheet ────────────────────────────────

{
  const project = aroundProject(X_BAR)
  const around = aroundSheetForOperation(project, { id: 'op-around', setupId: 'setup-around' })
  assert(around !== null, "an Around operation draws its operation's sheet, not the workspace's")
  assert(aroundSheetForOperation(project, { id: 'op-top', setupId: DEFAULT_SETUP_ID }) === null, 'a Top operation has no sheet')
  assert(aroundSheetForOperation(project, { id: 'op-legacy', setupId: undefined }) === null, 'a setup-less operation reads as Top')
  assert(aroundSheetForOperation(project, { id: 'op-missing', setupId: 'nope' }) === null, 'an operation naming a missing setup answers null, not a throw')
}

// ── Null unless Around on a bar ──────────────────────────────

{
  assert(aroundSheet({ ...aroundProject(X_BAR), activeSetupId: DEFAULT_SETUP_ID }) === null, 'null on Top')
  const bottom: MachiningSetup = {
    id: 'setup-bottom',
    name: 'Bottom',
    orientation: { axis: 'x', angleDeg: 180 },
    indexing: 'manual',
    registration: [],
    notes: '',
    operationIds: [],
  }
  const bottomProject = { ...aroundProject(X_BAR), setups: [...aroundProject(X_BAR).setups, bottom], activeSetupId: bottom.id }
  assert(aroundSheet(bottomProject) === null, 'null on Bottom')
  const block = newProject()
  const blockSetup = aroundSetup(X_BAR, 'setup-block')
  assert(aroundSheet({ ...block, setups: [...block.setups, blockSetup], activeSetupId: blockSetup.id }) === null,
    'null on a block stock, whatever the active setup says')
}

// ── Feature face ─────────────────────────────────────────────

{
  assert(authoredOnFace({ authoringFace: 'around' }, 'around'), 'an Around feature is on the sheet')
  assert(!authoredOnFace({ authoringFace: 'top' }, 'around'), 'a Top feature is not')
  assert(authoredOnFace({}, 'top'), 'a feature naming no face is on Top')
}

// ── Model bands (issue #1015 slice K) ────────────────────────
//
// The imported model lives inside the bar, so the sheet cannot draw it: it
// reports a band at the model's extent along the bar instead. Mutations
// checked one at a time against these assertions:
// - the band read from the across axis instead of the along one → the Y-bar
//   assertion fails;
// - `along` not clipped to the sheet → "a model running past the bar is
//   clipped" fails;
// - a hidden feature, or a non-model feature, included → the visible-models
//   assertion fails;
// - a model wholly outside the bar still banded → "a model wholly outside the
//   bar is no band" fails;
// - the bands dropped or reordered → the band-by-id assertions fail.

/** A visible imported model with a footprint at `profile`, as the tree holds it. */
function modelFeature(id: string, profile: SketchProfile, overrides: Partial<SketchFeature> = {}): SketchFeature {
  return {
    id,
    name: id,
    kind: 'stl',
    stl: null,
    folderId: null,
    sketch: { profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'model',
    authoringFace: 'top',
    z_top: 10,
    z_bottom: 0,
    visible: true,
    locked: false,
    ...overrides,
  }
}

{
  // An off-centre model on the X bar (10..210): the band is 30..90, nothing
  // like symmetric, so a band that swapped its ends could not pass.
  const project = projectWithFeatures(aroundProject(X_BAR), [modelFeature('bust', rectProfile(30, 40, 60, 5))])
  const frame = aroundSheet(project)!
  assert(frame.modelBands.length === 1, `one imported model is one band (${frame.modelBands.length})`)
  const band = frame.modelBands[0]
  assert(band.featureId === 'bust' && band.name === 'bust', 'the band names the model it stands for')
  assert(
    JSON.stringify(band.along) === JSON.stringify({ min: 30, max: 90 }),
    `the band is the model's extent along the bar: ${JSON.stringify(band.along)}`,
  )
}

{
  // Only visible imported models become bands, in the project's order.
  const project = projectWithFeatures(aroundProject(X_BAR), [
    modelFeature('bust', rectProfile(30, 40, 60, 5)),
    modelFeature('hidden', rectProfile(120, 40, 20, 5), { visible: false }),
    { ...modelFeature('plate', rectProfile(150, 40, 20, 5)), kind: 'rect', operation: 'add' },
    modelFeature('vase', rectProfile(170, 40, 10, 5)),
  ])
  const frame = aroundSheet(project)!
  assert(
    frame.modelBands.map((entry) => entry.featureId).join(',') === 'bust,vase',
    `a hidden or non-model feature is no band: ${frame.modelBands.map((entry) => entry.featureId).join(',')}`,
  )
}

{
  // A bar along Y measures the model along Y, not X.
  const project = projectWithFeatures(aroundProject(Y_BAR), [modelFeature('bust', rectProfile(4, 6, 3, 4))])
  const frame = aroundSheet(project)!
  assert(
    JSON.stringify(frame.modelBands[0].along) === JSON.stringify({ min: 6, max: 10 }),
    `a Y bar measures the model along Y: ${JSON.stringify(frame.modelBands[0].along)}`,
  )
}

{
  // A model running past both ends of the bar is clipped to the sheet.
  const project = projectWithFeatures(aroundProject(X_BAR), [modelFeature('long', rectProfile(-50, 40, 320, 5))])
  const frame = aroundSheet(project)!
  assert(
    JSON.stringify(frame.modelBands[0].along) === JSON.stringify({ min: 10, max: 210 }),
    `a model running past the bar is clipped to the sheet: ${JSON.stringify(frame.modelBands[0].along)}`,
  )
}

{
  // A model wholly past one end of the bar clips to an inside-out extent
  // (`min > max`): there is no width to draw, so it is left out rather than
  // banded with no extent.
  const project = projectWithFeatures(aroundProject(X_BAR), [
    modelFeature('before', rectProfile(-60, 40, 20, 5)),
    modelFeature('after', rectProfile(230, 40, 20, 5)),
  ])
  const frame = aroundSheet(project)!
  assert(
    frame.modelBands.length === 0,
    `a model wholly outside the bar is no band: ${frame.modelBands.map((entry) => entry.featureId).join(',')}`,
  )
}

console.log('aroundSheet: all assertions passed')
