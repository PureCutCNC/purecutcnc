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

/** #957: physical winding, kerf-edge dimensions, pierce/lead clearance and persistence.
 * Mutations run separately: invert offset, use full kerf, reverse direction,
 * put pierce on the contour, bypass neighbours, remove centre fallback.
 * Review regressions separately kill M1/M2/M4/M5/M8/M10, enclosing-hole
 * half-clearance, export Y convention, non-Top generation and bounded cache.
 */
import assert from 'node:assert/strict'
import type { Operation, Project, SketchFeature, SketchProfile } from '../../types/project'
import { newProject, defaultTool, circleProfile } from '../../types/project'
import { defaultPlasmaTool } from '../../toolPolicy'
import { projectWithFeatures } from '../../test/projectFixtures'
import { defaultOperationForTarget, isOperationTargetValid } from '../../store/helpers/operationDefaults'
import { decodeProjectFormat, normalizeProject } from '../../store/helpers/projectFormat'
import { useProjectStore } from '../../store/projectStore'
import { convertProjectUnits, convertToolUnits } from '../../utils/units'
import { projectToMachinePoint } from '../gcode/utils'
import { BUNDLED_DEFINITIONS } from '../gcode/definitions'
import { setupFrameForOperation } from '../setupOrientation'
import { operationAffectedByChange, operationFootprint } from './toolpathDependencies'
import { computeOperationToolpath } from './generateOperation'
import { generatePlasmaProfileToolpath, plasmaLeadLength } from './plasma'
import { distanceToContour, pathClearOfContour, pathOnScrap, pointDistance } from './plasmaGeometry'
import type { ToolpathResult } from './types'
import { operationFieldsForGroup, OPERATION_FIELD_GROUPS } from '../../components/cam/operationFields'

function square(x: number, y: number, w: number, h = w): SketchProfile {
  return { start: { x, y }, segments: [
    { type: 'line', to: { x: x + w, y } }, { type: 'line', to: { x: x + w, y: y + h } },
    { type: 'line', to: { x, y: y + h } }, { type: 'line', to: { x, y } },
  ], closed: true }
}
function feature(id: string, operation: SketchFeature['operation'], profile = square(20, 20, 60)): SketchFeature {
  return { id, name: id, kind: 'rect', operation, folderId: null, visible: true, locked: false, z_top: 6, z_bottom: 0,
    sketch: { profile, dimensions: [], constraints: [], origin: { x: 0, y: 0 }, orientationAngle: 0 } }
}
function fixture(features: SketchFeature[] = [feature('part', 'add')]): Project {
  const project = newProject('Plasma fixture', 'mm')
  project.stock.thickness = 6
  project.tools = [{ ...defaultPlasmaTool('mm'), id: 'torch', name: 'Torch', diameter: 2, cutHeight: 1.5, defaultFeed: 2200 }, defaultTool('mm')]
  return projectWithFeatures(project, features)
}
function op(p: Project, ids = ['part'], patch: Partial<Operation> = {}): Operation {
  return { ...defaultOperationForTarget(p, 'plasma_profile', 'rough', { source: 'features', featureIds: ids }, 0), ...patch }
}
const generate = (p: Project, operation = op(p)): ToolpathResult => generatePlasmaProfileToolpath(p, operation)
function cutPoints(result: ToolpathResult) { return result.moves.filter((m) => m.kind === 'cut').map((m) => m.from) }
function physicalArea(result: ToolpathResult, project = p, operation = op(project)): number {
  const machine = BUNDLED_DEFINITIONS.find((definition) => definition.id === 'grbl')!
  assert.ok(machine, 'direction fixture uses the bundled GRBL machine')
  const frame = setupFrameForOperation(project, operation) ?? undefined
  // Pin physical direction through the real export conversion, including origin
  // and setup, rather than duplicating its Y convention in this test.
  return result.moves.filter((m) => m.kind === 'cut').reduce((sum, m) => {
    const from = projectToMachinePoint(m.from, project.origin, machine, frame)
    const to = projectToMachinePoint(m.to, project.origin, machine, frame)
    return sum + from.x * to.y - to.x * from.y
  }, 0) / 2
}
const outline = [{ x: 20, y: 20 }, { x: 80, y: 20 }, { x: 80, y: 80 }, { x: 20, y: 80 }]
const p = fixture()
const outside = generate(p)
assert.ok(outside.moves.length, 'outside square generates')
assert.deepEqual(outside.warnings, [])
assert.ok(physicalArea(outside) < 0, 'outside travels clockwise viewed from above the sheet')
for (const point of cutPoints(outside)) {
  // On each straight wall the edge of the kerf, NOT the centre, coincides with the drawing.
  if (point.y === 19 || point.y === 81) assert.equal(Math.abs(point.y - (point.y === 19 ? 20 : 80)) - 1, 0)
  if (point.x === 19 || point.x === 81) assert.equal(Math.abs(point.x - (point.x === 19 ? 20 : 80)) - 1, 0)
}
assert.equal(Math.min(...cutPoints(outside).map((v) => v.x)) + 1, 20, 'left kerf edge lies on drawn outline')
assert.equal(Math.max(...cutPoints(outside).map((v) => v.x)) - 1, 80, 'right kerf edge lies on drawn outline')
const pierce = outside.moves.find((m) => m.kind === 'plunge')!.to
assert.ok(distanceToContour(pierce, outline) >= plasmaLeadLength(p, op(p)), 'pierce is at least lead-in length from drawn part edge')
const leadIn = outside.moves.filter((m) => m.kind === 'lead_in')
assert.ok(pathOnScrap([leadIn[0].from, ...leadIn.map((m) => m.to)], outline, false, 1), 'entire outside lead swept kerf stays on scrap')
assert.ok(outside.moves.some((m) => m.kind === 'lead_out'), 'outside defaults to one kerf lead-out')
assert.ok(physicalArea(generate(p, op(p, ['part'], { plasmaReverseDirection: true }))) > 0, 'override reverses outside')
const holeRing = [{ x: 35, y: 35 }, { x: 65, y: 35 }, { x: 65, y: 65 }, { x: 35, y: 65 }]
const withHole = fixture([feature('part', 'add'), feature('hole', 'subtract', square(35, 35, 30))])
const hole = generate(withHole, op(withHole, ['hole']))
assert.ok(hole.moves.length, 'square with hole generates inside parent material')
assert.ok(physicalArea(hole) > 0, 'hole travels counter-clockwise from above physical sheet')
assert.ok(physicalArea(generate(withHole, op(withHole, ['hole'], { plasmaReverseDirection: true }))) < 0, 'override reverses hole')
assert.equal(Math.min(...cutPoints(hole).map((v) => v.x)) - 1, 35, 'hole kerf edge matches drawn hole')
assert.equal(Math.max(...cutPoints(hole).map((v) => v.x)) + 1, 65)
assert.equal(hole.moves.filter((m) => m.kind === 'lead_out').length, 0, 'holes default to no lead-out')
const holeLead = hole.moves.filter((m) => m.kind === 'lead_in')
assert.ok(holeLead.length > 2, 'hole default uses tangent arc')
assert.ok(pathOnScrap([holeLead[0].from, ...holeLead.map((m) => m.to)], holeRing, true, 1))
// tangent arrival is aligned with first contour segment (within arc tessellation angle)
const lastLead = holeLead.at(-1)!, firstCut = hole.moves.find((m) => m.kind === 'cut')!
const a = { x: lastLead.to.x - lastLead.from.x, y: lastLead.to.y - lastLead.from.y }
const b = { x: firstCut.to.x - firstCut.from.x, y: firstCut.to.y - firstCut.from.y }
assert.ok(Math.abs(a.x * b.y - a.y * b.x) / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y)) < 0.04, 'arc arrives tangent')
// Mixed hole/outline target list cannot inherit ClipperOffset winding from topmost path.
const mixed = generate(withHole, op(withHole, ['hole', 'part']))
assert.equal(mixed.moves.filter((m) => m.kind === 'plunge').length, 2)
const small = fixture([feature('tiny', 'subtract', square(35, 35, 8))])
const smallResult = generate(small, op(small, ['tiny']))
assert.ok(smallResult.moves.length, 'small hole warns but still cuts')
assert.deepEqual(smallResult.moves.find((m) => m.kind === 'plunge')!.to, { x: 39, y: 39, z: 7.5 }, 'small hole pierces at centre')
assert.equal(smallResult.moves.filter((m) => m.kind === 'lead_in').length, 1)
for (const code of ['plasmaSmallHole', 'plasmaCentrePierce']) assert.ok(smallResult.warnings.some((w) => w.code === code), `${code}: small hole warning is present`)
const overridden = generate(p, op(p, ['part'], { plasmaSide: 'inside' }))
assert.ok(physicalArea(overridden) > 0, 'inside override owns compensation and direction')
const custom = generate(p, op(p, ['part'], { plasmaStartPoint: { x: 50, y: 20 }, plasmaLeadIn: 'line', plasmaLeadInLength: 10, plasmaLeadOutLength: 0 }))
assert.deepEqual(custom.moves.find((m) => m.kind === 'cut')!.from, { x: 50, y: 19, z: 7.5 })
assert.ok(pointDistance(custom.moves.find((m) => m.kind === 'plunge')!.to, custom.moves.find((m) => m.kind === 'cut')!.from) >= 10)
assert.ok(!custom.moves.some((m) => m.kind === 'lead_out'))
const longExit = generate(withHole, op(withHole, ['hole'], { plasmaLeadOutLength: 100 }))
assert.ok(longExit.moves.length && longExit.warnings.some((w) => w.code === 'plasmaLeadOutOmitted'), 'unsafe editable hole exit omitted with warning')
const neighbours = fixture([feature('part', 'add'), feature('neighbour', 'add', square(48, 6, 4))])
const moved = generate(neighbours)
assert.ok(moved.moves.length, 'automatic start moves away from neighbour')
for (const m of moved.moves.filter((m) => ['lead_in', 'lead_out', 'cut'].includes(m.kind))) {
  assert.ok(pathClearOfContour([m.from, m.to], [{ x: 48, y: 6 }, { x: 52, y: 6 }, { x: 52, y: 10 }, { x: 48, y: 10 }], 2), 'swept lead/contour stays off neighbour kerf')
}
const surrounded = fixture([feature('part', 'add'), feature('blocking', 'add', square(18, 18, 64))])
assert.equal(generate(surrounded).moves.length, 0)
assert.ok(generate(surrounded).warnings.some((w) => w.code === 'plasmaNoLead'))
// A segment crossing a needle-thin part must fail even when endpoints are outside.
assert.equal(pathClearOfContour([{ x: 0, y: 0 }, { x: 10, y: 0 }], [{ x: 4.99, y: -1 }, { x: 5.01, y: -1 }, { x: 5.01, y: 1 }, { x: 4.99, y: 1 }], 0.5), false)
const open = fixture([feature('part', 'line', { ...square(20, 20, 60), closed: false })])
assert.equal(isOperationTargetValid(open, 'plasma_profile', op(open).target), false)
assert.equal(generate(open).moves.length, 0)
const savedOpen = normalizeProject({ ...open, operations: [op(open)] })
assert.deepEqual(savedOpen.operations[0].target, op(open).target, 'normalization preserves invalid plasma target for a clear warning')
assert.ok(generate(savedOpen, savedOpen.operations[0]).warnings.some((w) => w.code === 'plasmaOpenPath'))
assert.ok(generate(open).warnings.some((w) => w.code === 'plasmaOpenPath'))
for (const invalid of [0, -1, Infinity, NaN]) assert.equal(generate(p, op(p, ['part'], { plasmaLeadInLength: invalid })).moves.length, 0)
assert.equal(generate(p, op(p, ['missing'])).moves.length, 0)
assert.equal(generate(p, op(p, ['part'], { toolRef: p.tools[1].id })).moves.length, 0)
assert.equal(generate(p, op(p, ['part'], { plasmaLeadOutLength: -1 })).moves.length, 0)
const dirtyMilling = op(p, ['part'], { stepdown: 0.2, finishWalls: true, finishFloor: true, entryStrategy: 'helix', xyLeadStrategy: 'arc', cornerRelief: 'dogbone', stockToLeaveRadial: 10 })
assert.deepEqual(generate(p, dirtyMilling).moves, outside.moves, 'milling fields cannot affect plasma output')
assert.deepEqual(computeOperationToolpath(p, op(p))!.result.moves, computeOperationToolpath(p, dirtyMilling)!.result.moves)
assert.ok(outside.moves.filter((m) => ['cut', 'lead_in', 'lead_out'].includes(m.kind)).every((m) => m.from.z === 7.5 && m.to.z === 7.5), 'one nominal cut height')
assert.equal(outside.moves.filter((m) => m.kind === 'plunge').length, 1, 'one pass, no stepdowns')
const allowedFields = ['name', 'description', 'kind', 'enabled', 'target', 'targetSource', 'tool', 'feed', 'arcFitting']
for (const group of OPERATION_FIELD_GROUPS) assert.ok(operationFieldsForGroup(group.id, op(p)).every((f) => allowedFields.includes(f.id)), 'editor hides milling controls')
// Actual creation, history and format 3.3 save/open.
useProjectStore.setState({ project: p, dirty: false, history: { past: [], future: [], transactionStart: null } })
const id = useProjectStore.getState().addOperation('plasma_profile', 'rough', { source: 'features', featureIds: ['part'] })!
assert.ok(id)
assert.equal(useProjectStore.getState().project.operations[0].toolRef, 'torch')
useProjectStore.getState().updateOperation(id, { plasmaLeadInLength: 10, plasmaStartPoint: { x: 50, y: 20 }, plasmaReverseDirection: true })
const saved = useProjectStore.getState().saveProject()
useProjectStore.getState().openProjectFromText(saved, null)
const reopened = useProjectStore.getState().project
assert.equal(reopened.version, '3.3')
assert.equal(reopened.operations[0].plasmaLeadInLength, 10)
assert.deepEqual(reopened.operations[0].plasmaStartPoint, { x: 50, y: 20 })
assert.equal(reopened.operations[0].plasmaReverseDirection, true)
const missing = structuredClone(reopened)
for (const field of ['plasmaSide', 'plasmaReverseDirection', 'plasmaLeadIn', 'plasmaLeadOut'] as const) delete missing.operations[0][field]
const migrated = decodeProjectFormat(missing).project
assert.equal(migrated.operations[0].plasmaSide, 'auto')
assert.equal(migrated.operations[0].plasmaReverseDirection, false)
assert.deepEqual(normalizeProject(migrated), migrated, 'missing-field migration idempotent at 3.3')
const inch = convertProjectUnits(reopened, 'inch')
assert.equal(inch.operations[0].plasmaLeadInLength, 10 / 25.4)
assert.deepEqual(inch.operations[0].plasmaStartPoint, { x: 50 / 25.4, y: 20 / 25.4 })
// Native tool units are preserved but converted for generation.
const inchTool = { ...p, tools: [convertToolUnits(p.tools[0], 'inch')] }
assert.deepEqual(generate(inchTool).moves, outside.moves)
// Review #982: target every independent safety boundary, not just the whole guard.
// Arc -> line -> centre keeps ordinary holes cutting while retaining the crater clearance.
for (const thickness of [6, 12]) {
  for (const diameter of thickness === 6 ? [14, 20, 30, 40, 48] : [30, 50]) {
    const round = fixture([feature('round', 'subtract', circleProfile(50, 50, diameter / 2))])
    round.stock.thickness = thickness
    const roundOp = op(round, ['round'])
    const result = generate(round, roundOp)
    assert.ok(result.moves.length, `default ${diameter} mm round hole in ${thickness} mm plate generates`)
    const points = Array.from({ length: 360 }, (_, i) => ({ x: 50 + diameter / 2 * Math.cos(i * Math.PI / 180), y: 50 + diameter / 2 * Math.sin(i * Math.PI / 180) }))
    assert.ok(distanceToContour(result.moves.find((m) => m.kind === 'plunge')!.to, points) >= plasmaLeadLength(round, roundOp) - 0.02, 'round hole pierce clears the requested lead length')
  }
}
for (const width of [14, 20]) {
  const mid = fixture([feature('mid', 'subtract', square(35, 35, width))])
  const result = generate(mid, op(mid, ['mid']))
  assert.ok(result.moves.length, 'mid-size square hole uses straight fallback')
  assert.equal(result.moves.filter((m) => m.kind === 'lead_in').length, 1, 'arc pierce too close to an edge falls back to line')
  assert.ok(result.warnings.some((w) => w.code === 'plasmaStraightLead'))
  const drawn = [{ x: 35, y: 35 }, { x: 35 + width, y: 35 }, { x: 35 + width, y: 35 + width }, { x: 35, y: 35 + width }]
  assert.ok(distanceToContour(result.moves.find((m) => m.kind === 'plunge')!.to, drawn) >= 6, 'M2: pierce must clear lead length even when the arc kerf itself fits')
}
const requested = { plasmaStartPoint: { x: 50, y: 20 }, plasmaLeadIn: 'line' as const, plasmaLeadOutLength: 0 }
const nearKerf = fixture([feature('part', 'add'), feature('near', 'add', square(48, 10, 4, 1.6))])
assert.equal(generate(nearKerf, op(nearKerf, ['part'], requested)).moves.length, 0, 'M1: a lead 1.4 mm from a separate neighbour is inside its 2 mm kerf')
const nested = fixture([feature('enclosing', 'add', square(0, 0, 100)), feature('scrap-hole', 'subtract', square(10, 10, 80)), feature('part', 'add')])
const nestedResult = generate(nested, op(nested, ['part'], { ...requested, plasmaLeadInLength: 7.6 }))
assert.equal(nestedResult.moves.length, 0, 'enclosing-hole wall requires full kerf too: pierce y=11.4 is only 1.4 mm from its edge')
const nestedSafe = generate(nested, op(nested, ['part'], requested))
assert.ok(nestedSafe.moves.length, 'same nested part cuts with the 3 mm clearance of the default lead')
const deepInside = fixture([feature('part', 'add'), feature('enclosing', 'add', square(0, 0, 200))])
assert.equal(generate(deepInside, op(deepInside, ['part'], requested)).moves.length, 0, 'M4: clearance from neighbour boundary cannot authorize a path inside its material')
const crossingContour = fixture([feature('part', 'add'), feature('side-neighbour', 'add', square(81.5, 40, 3, 5))])
assert.equal(generate(crossingContour, op(crossingContour, ['part'], requested)).moves.length, 0, 'M5: the entire contour is checked even when its chosen entry and exit are clear')
const unrelatedHole = fixture([feature('enclosing', 'add', square(0, 0, 200)), feature('remote-hole', 'subtract', square(10, 10, 20)), feature('part', 'add')])
assert.equal(generate(unrelatedHole, op(unrelatedHole, ['part'], requested)).moves.length, 0, 'M10: a hole exempts only paths actually inside that hole')
const notch: SketchProfile = { start: { x: 20, y: 20 }, segments: [
  { type: 'line', to: { x: 40, y: 20 } }, { type: 'line', to: { x: 40, y: 40 } },
  { type: 'line', to: { x: 60, y: 40 } }, { type: 'line', to: { x: 60, y: 20 } },
  { type: 'line', to: { x: 80, y: 20 } }, { type: 'line', to: { x: 80, y: 80 } },
  { type: 'line', to: { x: 20, y: 80 } }, { type: 'line', to: { x: 20, y: 20 } },
], closed: true }
const notched = fixture([feature('part', 'add', notch)])
const curledExit = generate(notched, op(notched, ['part'], { plasmaStartPoint: { x: 50, y: 40 }, plasmaLeadIn: 'line', plasmaLeadOut: 'arc', plasmaLeadOutLength: 20 }))
assert.ok(curledExit.moves.length, 'concave part entry still cuts')
assert.ok(curledExit.warnings.some((w) => w.code === 'plasmaLeadOutOmitted'), 'M8: an outside exit curling into its own part is warned')
assert.ok(!curledExit.moves.some((m) => m.kind === 'lead_out'), 'unsafe curled exit cannot be emitted')
const topOp = op(p, ['part'], { setupId: p.setups![0].id })
assert.ok(physicalArea(generate(p, topOp), p, topOp) < 0, 'explicit Top setup keeps clockwise export direction')
for (const axis of ['x', 'y'] as const) {
  const bottom = { ...p, setups: [{ ...p.setups![0], orientation: { axis, angleDeg: 180 as const } }] }
  const result = generate(bottom, topOp)
  assert.equal(result.moves.length, 0, 'turned setup never emits nominal Top plasma geometry')
  assert.ok(result.warnings.some((w) => w.code === 'plasmaTopOnly'))
  const dispatched = computeOperationToolpath(bottom, topOp)!.result
  assert.equal(dispatched.moves.length, 0, 'dispatch must check original setup before any coordinate transform')
  assert.ok(dispatched.warnings.some((w) => w.code === 'plasmaTopOnly'))
}
const beforePart = fixture([feature('hole', 'subtract', square(35, 35, 30)), feature('part', 'add')])
const misordered = generate(beforePart, op(beforePart, ['hole']))
assert.equal(misordered.moves.length, 0)
assert.ok(misordered.warnings.some((w) => w.code === 'plasmaHoleBeforePart'), 'misordered hole is diagnosed specifically')
assert.ok(!misordered.warnings.some((w) => w.code === 'plasmaNoLead'))
const partial = fixture([feature('part', 'add'), { ...feature('hole', 'subtract', square(35, 35, 30)), z_bottom: 2 }])
const partialResult = generate(partial, op(partial, ['hole']))
assert.ok(partialResult.moves.length && partialResult.warnings.some((w) => w.code === 'plasmaPartialDepth'), 'partial-depth subtract warns that plasma still cuts through')
const namedPartial = fixture([feature('part', 'add'), { ...feature('hole', 'subtract', square(35, 35, 30)), z_bottom: 'hole_floor' }])
namedPartial.dimensions.hole_floor = { id: 'hole_floor', name: 'Hole floor', value: 2, formula: 'stock_thickness - 4' }
const namedResult = generate(namedPartial, op(namedPartial, ['hole']))
assert.ok(namedResult.moves.length && namedResult.warnings.some((w) => w.code === 'plasmaPartialDepth'), 'partial-depth warning resolves named/formula-backed dimensions')
const missingDepth = { ...namedPartial, dimensions: {} }
assert.equal(generate(missingDepth, op(missingDepth, ['hole'])).moves.length, 0, 'unknown depth reference refuses motion')
assert.ok(generate(missingDepth, op(missingDepth, ['hole'])).warnings.some((w) => w.code === 'plasmaInvalid'), 'unknown depth reference has a clear warning')
const absentDefault = op(p); delete absentDefault.plasmaLeadIn
assert.deepEqual(generate(p, absentDefault).moves, outside.moves, 'absent and stored outside lead defaults agree')
const previous = fixture([feature('part', 'add'), feature('far', 'add', square(1000, -83, 4))])
const next = fixture([feature('part', 'add'), feature('far', 'add', square(48, -83, 4))])
const longLead = op(previous, ['part'], { ...requested, plasmaLeadInLength: 100 })
assert.ok(generate(previous, longLead).moves.length)
assert.equal(generate(next, longLead).moves.length, 0, 'far-away edit can invalidate a long plasma lead')
const footprint = operationFootprint(previous, longLead)
assert.equal(footprint.bounds, null, 'plasma cache remains conservative independently of the milling tool lookup')
assert.ok(operationAffectedByChange(footprint, previous, next, new Set(['far'])), 'neighbour changes beyond a milling margin invalidate plasma')
const milling = { ...p, operations: [defaultOperationForTarget(p, 'pocket', 'rough', { source: 'features', featureIds: ['part'] }, 0)] }
const convertedMilling = convertProjectUnits(milling, 'inch').operations[0]
for (const key of ['plasmaLeadInLength', 'plasmaLeadOutLength', 'plasmaStartPoint']) assert.equal(Object.hasOwn(convertedMilling, key), false, 'unit conversion does not add absent plasma keys to milling')
console.log('plasma profile: physical export direction, independent safety guards, fallback, cache, schema and UI policy passed')
