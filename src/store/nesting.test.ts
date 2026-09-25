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
 * Sheet nesting, project side (issue #846, step 2 of #741): part resolution,
 * gap from the tool, apply/discard as single history steps, save/load, and an
 * end-to-end check measured on the resolved world geometry of every copy.
 *
 * Run with: npx tsx src/store/nesting.test.ts
 */

import ClipperLib from 'clipper-lib'
import { flattenProfileWithin, nest } from '../engine/nesting'
import { generateEdgeRouteToolpath } from '../engine/toolpaths/edge'
import { NEST_SCALE, ringToPath } from '../engine/nesting/clipperOps'
import {
  circleProfile,
  defaultStock,
  defaultTool,
  newProject,
  rectProfile,
  type LocalConstraint,
  type NestSettings,
  type Point,
  type Project,
  type SketchFeature,
} from '../types/project'
import { projectWithFeatures } from '../test/projectFixtures'
import { defaultOperationForTarget } from './helpers/operationDefaults'
import { normalizeProject, type ProjectFormatInput } from './helpers/projectFormat'
import { discardNestFromProject } from './helpers/nestApply'
import { buildNestRequest, nestGapForPart, resolveNestParts, type NestPartSpec } from './helpers/nestPart'
import { resolveFeatureInstance } from './helpers/resolveFeatures'
import { useProjectStore } from './projectStore'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

type Row = SketchFeature & { id: string }

function row(id: string, operation: SketchFeature['operation'], profile: SketchFeature['sketch']['profile'], extra: Partial<SketchFeature> = {}): Row {
  return {
    id, name: id, kind: profile.segments.some((segment) => segment.type === 'circle') ? 'circle' : 'rect',
    operation, visible: true, locked: false, z_top: 10, z_bottom: operation === 'subtract' ? 4 : 0,
    folderId: null, text: null, stl: null,
    sketch: { origin: { ...profile.start }, orientationAngle: 0, dimensions: [], constraints: [], profile },
    ...extra,
  }
}

const TOOL_DIAMETER = 6
const STOCK_TO_LEAVE = 0.5
const GAP = TOOL_DIAMETER + 2 * STOCK_TO_LEAVE

function makeProject(options: { lockHole?: boolean; slotConstraint?: LocalConstraint; grouped?: boolean } = {}): Project {
  const base = newProject()
  base.meta = { ...base.meta, units: 'mm' }
  base.stock = defaultStock(300, 200, 12, 'mm')
  const tool = { ...defaultTool('mm', 1), id: 'tool-6', diameter: TOOL_DIAMETER }
  base.tools = [tool]
  if (options.grouped) {
    base.featureFolders = [{ id: 'part-folder', name: 'Part', collapsed: false, section: 'features', grouped: true }]
  }
  const project = projectWithFeatures(base, [
    row('plate', 'add', rectProfile(10, 10, 40, 30), { folderId: options.grouped ? 'part-folder' : null }),
    row('hole', 'subtract', circleProfile(20, 25, 5), {
      locked: options.lockHole ?? false,
      folderId: options.grouped ? 'part-folder' : null,
    }),
    row('slot', 'subtract', rectProfile(32, 18, 12, 14), {
      sketch: {
        origin: { x: 32, y: 18 }, orientationAngle: 0, dimensions: [],
        constraints: options.slotConstraint ? [options.slotConstraint] : [],
        profile: rectProfile(32, 18, 12, 14),
      },
    }),
    row('other', 'add', rectProfile(200, 140, 60, 50)),
  ])
  const edge = defaultOperationForTarget(project, 'edge_route_outside', 'finish', { source: 'features', featureIds: ['plate'] }, 0)
  const pocket = defaultOperationForTarget(project, 'pocket', 'rough', { source: 'features', featureIds: ['hole', 'slot'] }, 1)
  project.operations = [
    { ...edge, id: 'op-edge', toolRef: 'tool-6', stockToLeaveRadial: STOCK_TO_LEAVE },
    { ...pocket, id: 'op-pocket', toolRef: 'tool-6' },
  ]
  return normalizeProject(JSON.parse(JSON.stringify(project)) as ProjectFormatInput)
}

function resetStore(project: Project): void {
  useProjectStore.setState({ project, history: { past: [], future: [], transactionStart: null }, dirty: false })
}

/** Nest settings plus the quantity every part in the selection gets. */
type TestRun = NestSettings & { quantity: number | number[] }

function settings(overrides: Partial<TestRun> = {}): TestRun {
  return { quantity: 6, rotations: [0, 90, 180, 270], minimumGap: GAP, keepOriginals: false, ...overrides }
}

function onePart(project: Project, selected: string[]): NestPartSpec {
  const resolution = resolveNestParts(project, selected)
  assert(resolution.ok && resolution.parts.length === 1, `one part expected, got ${JSON.stringify(resolution)}`)
  return resolution.parts[0]
}

/** Runs the whole pipeline the UI will: resolve, request, pack, commit. */
function nestIntoStore(selected: string[], run: TestRun, replaceNestId?: string, amend = false): { nestId: string; placed: number; unplaced: number } {
  const current = useProjectStore.getState().project
  const project = replaceNestId ? discardNestFromProject(current, replaceNestId)! : current
  const resolution = resolveNestParts(project, selected)
  assert(resolution.ok, 'parts resolve')
  const quantities = resolution.parts.map((_, index) => (Array.isArray(run.quantity) ? run.quantity[index] : run.quantity))
  const { quantity: _quantity, ...nestSettings } = run
  void _quantity
  const request = buildNestRequest(project, resolution.parts, quantities, nestSettings)
  assert(request, 'request builds')
  const result = nest(request)
  const nestId = useProjectStore.getState().applyNest({
    parts: resolution.parts.map((part, index) => ({ featureIds: part.featureIds, quantity: quantities[index] })),
    placements: result.placements,
    settings: nestSettings,
    replaceNestId,
    amend,
  })
  assert(nestId, 'nest applied')
  return { nestId, placed: result.placements.length, unplaced: result.unplaced.reduce((sum, entry) => sum + entry.count, 0) }
}

function worldRing(project: Project, id: string): Point[] {
  const feature = resolveFeatureInstance(project, id)
  assert(feature, `feature ${id} resolves`)
  return flattenProfileWithin(feature.sketch.profile, 0.001)
}

function overlapArea(a: Point[], b: Point[]): number {
  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths([ringToPath(a)], ClipperLib.PolyType.ptSubject, true)
  clipper.AddPaths([ringToPath(b)], ClipperLib.PolyType.ptClip, true)
  const solution = new ClipperLib.Paths()
  clipper.Execute(ClipperLib.ClipType.ctIntersection, solution, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
  return solution.reduce((sum, path) => sum + Math.abs(ClipperLib.Clipper.Area(path)), 0) / NEST_SCALE ** 2
}

function ringDistance(a: Point[], b: Point[]): number {
  if (overlapArea(a, b) > 0) return 0
  let best = Infinity
  const scan = (from: Point[], to: Point[]) => {
    for (const p of from) {
      for (let i = 0; i < to.length; i += 1) {
        const s = to[i]
        const e = to[(i + 1) % to.length]
        const dx = e.x - s.x
        const dy = e.y - s.y
        const t = Math.max(0, Math.min(1, ((p.x - s.x) * dx + (p.y - s.y) * dy) / (dx * dx + dy * dy || 1)))
        best = Math.min(best, Math.hypot(p.x - (s.x + t * dx), p.y - (s.y + t * dy)))
      }
    }
  }
  scan(a, b)
  scan(b, a)
  return best
}

function plateInstances(project: Project): string[] {
  const plate = project.features.find((feature) => feature.id === 'plate')!
  return project.features.filter((feature) => feature.definitionId === plate.definitionId).map((feature) => feature.id)
}

function testPartResolution(): void {
  const project = makeProject()
  const part = onePart(project, ['plate'])
  assert(part.featureIds.join() === 'plate,hole,slot', `containment pulls the hole and slot in, got ${part.featureIds.join()}`)
  assert(part.footprint.length === 1, 'one outer footprint ring')

  const grouped = onePart(makeProject({ grouped: true }), ['hole'])
  assert(grouped.featureIds.join() === 'plate,hole,slot', 'a grouped folder is one part, then containment applies')

  const locked = resolveNestParts(makeProject({ lockHole: true }), ['plate'])
  assert(!locked.ok && locked.refusal === 'locked' && locked.featureId === 'hole', 'a locked member refuses the part')

  const externalConstraint: LocalConstraint = {
    id: 'c1', type: 'fixed_distance', segment_ids: ['other'], reference_feature_id: 'other', value: 5,
  }
  const external = resolveNestParts(makeProject({ slotConstraint: externalConstraint }), ['plate'])
  assert(!external.ok && external.refusal === 'external-constraint' && external.featureId === 'slot', 'an outside reference refuses the part')

  const internal = resolveNestParts(makeProject({
    slotConstraint: { ...externalConstraint, segment_ids: ['plate'], reference_feature_id: 'plate' },
  }), ['plate'])
  assert(internal.ok, 'a reference inside the part is fine')

  assert(!resolveNestParts(project, []).ok, 'an empty selection is refused')
  const gap = nestGapForPart(project, ['plate', 'hole', 'slot'])
  assert(gap !== null && Math.abs(gap - GAP) < 1e-9, `gap = cutter diameter + 2 × radial stock to leave, got ${gap} (${JSON.stringify(project.operations.map((o) => o.target))})`)
  assert(nestGapForPart(project, ['hole']) === null, 'no outside edge route → no gap')
  console.log('part resolution and gap: PASSED')
}

function testApplyIsOneStepAndMachinesEveryCopy(): void {
  const before = makeProject()
  resetStore(before)
  const { nestId, placed } = nestIntoStore(['plate'], settings())
  const state = useProjectStore.getState()
  const project = state.project

  assert(placed === 6, `all six parts fit, got ${placed}`)
  const record = project.nests?.find((entry) => entry.id === nestId)
  assert(record, 'nest recorded')
  assert(record.copyIds.length === 5 * 3, `five copies of three features, got ${record.copyIds.length}`)
  assert(record.movedOriginals.length === 3, 'the three originals were moved and remembered')
  const folderRows = project.features.filter((feature) => feature.folderId === record.folderId)
  assert(folderRows.length === record.copyIds.length, 'copies live in the nest folder')
  for (const id of record.copyIds) {
    const copy = project.features.find((feature) => feature.id === id)!
    assert(Object.values(project.featureDefinitions).some((definition) => definition.id === copy.definitionId), 'copy definition exists')
    assert(['plate', 'hole', 'slot'].some((sourceId) => project.features.find((f) => f.id === sourceId)!.definitionId === copy.definitionId), 'copies are linked to the source definitions')
  }
  const edge = project.operations.find((operation) => operation.id === 'op-edge')!
  const pocket = project.operations.find((operation) => operation.id === 'op-pocket')!
  assert(edge.target.source === 'features' && edge.target.featureIds.length === 6, 'the edge route cuts all six plates')
  assert(pocket.target.source === 'features' && pocket.target.featureIds.length === 12, 'the pocket clears all twelve holes and slots')
  assert(state.history.past.length === 1, 'apply is exactly one history entry')

  // Measured on resolved world geometry, not on packer output.
  const plates = plateInstances(project)
  const stock = flattenProfileWithin(project.stock.profile, 0.001)
  const other = worldRing(project, 'other')
  for (let i = 0; i < plates.length; i += 1) {
    const a = worldRing(project, plates[i])
    assert(Math.abs(overlapArea(a, stock) - 40 * 30) < 1e-3, `${plates[i]} lies on the stock`)
    assert(ringDistance(a, other) >= GAP - 1e-6, `${plates[i]} keeps the gap from the other part`)
    for (let j = i + 1; j < plates.length; j += 1) {
      const distance = ringDistance(a, worldRing(project, plates[j]))
      assert(distance >= GAP - 1e-6, `${plates[i]} and ${plates[j]} are ${distance} apart, need ${GAP}`)
    }
  }
  // Holes travel with their plate: every hole copy lies inside some plate.
  const hole = project.features.find((feature) => feature.id === 'hole')!
  for (const holeId of project.features.filter((f) => f.definitionId === hole.definitionId).map((f) => f.id)) {
    const ring = worldRing(project, holeId)
    assert(plates.some((plateId) => Math.abs(overlapArea(ring, worldRing(project, plateId)) - Math.PI * 25) < 0.05), `${holeId} sits inside a plate`)
  }

  state.undo()
  assert(JSON.stringify(useProjectStore.getState().project.features) === JSON.stringify(before.features), 'one undo restores every instance')
  assert(JSON.stringify(useProjectStore.getState().project.operations) === JSON.stringify(before.operations), 'one undo restores operation targets')
  assert(!useProjectStore.getState().project.nests, 'one undo drops the record')
  console.log('apply nest: PASSED')
}

function testDiscardRestoresTheDesign(): void {
  const before = makeProject()
  resetStore(before)
  const { nestId } = nestIntoStore(['plate'], settings({ quantity: 4 }))
  const nested = useProjectStore.getState().project
  useProjectStore.getState().discardNest(nestId)
  const after = useProjectStore.getState()

  assert(JSON.stringify(after.project.features) === JSON.stringify(before.features), 'discard restores the original instances and transforms')
  assert(JSON.stringify(after.project.operations) === JSON.stringify(before.operations), 'discard strips copies from operations')
  assert(JSON.stringify(after.project.featureFolders) === JSON.stringify(before.featureFolders), 'the empty nest folder goes')
  assert(Object.keys(after.project.featureDefinitions).sort().join() === Object.keys(before.featureDefinitions).sort().join(), 'no definition added or lost')
  assert(!after.project.nests, 'record removed')
  assert(after.history.past.length === 2, 'discard is one more history entry')
  after.undo()
  assert(JSON.stringify(useProjectStore.getState().project) === JSON.stringify(nested), 'undo brings the whole nest back')
  console.log('discard nest: PASSED')
}

function testKeepOriginalsNestsAround(): void {
  const before = makeProject()
  resetStore(before)
  const { nestId } = nestIntoStore(['plate'], settings({ quantity: 4, keepOriginals: true }))
  const project = useProjectStore.getState().project
  const record = project.nests!.find((entry) => entry.id === nestId)!
  assert(record.movedOriginals.length === 0, 'nothing moved')
  for (const id of ['plate', 'hole', 'slot']) {
    const now = project.features.find((feature) => feature.id === id)!
    const was = before.features.find((feature) => feature.id === id)!
    assert(JSON.stringify(now.transform) === JSON.stringify(was.transform), `${id} stays in place`)
  }
  const plates = plateInstances(project)
  assert(plates.length === 4, 'three copies plus the original')
  const original = worldRing(project, 'plate')
  for (const id of plates.filter((plateId) => plateId !== 'plate')) {
    assert(ringDistance(worldRing(project, id), original) >= GAP - 1e-6, `${id} keeps the gap from the original`)
  }
  console.log('keep originals: PASSED')
}

function testConstraintReferencesFollowTheCopy(): void {
  const constraint: LocalConstraint = {
    id: 'c1', type: 'fixed_distance', segment_ids: ['plate'], reference_feature_id: 'plate', value: 5,
  }
  resetStore(makeProject({ slotConstraint: constraint }))
  const { nestId } = nestIntoStore(['plate'], settings({ quantity: 3 }))
  const project = useProjectStore.getState().project
  const record = project.nests!.find((entry) => entry.id === nestId)!
  const plateCopies = new Set(plateInstances(project).filter((id) => id !== 'plate'))
  const slotDefinition = project.features.find((feature) => feature.id === 'slot')!.definitionId
  const slotCopies = project.features.filter((f) => record.copyIds.includes(f.id) && f.definitionId === slotDefinition)
  assert(slotCopies.length === 2, 'two slot copies')
  const referenced = slotCopies.map((f) => f.constraints[0]?.reference_feature_id)
  assert(referenced.every((id) => id && plateCopies.has(id)), 'each slot copy measures from a plate copy')
  assert(new Set(referenced).size === 2, 'and each from its own plate')
  console.log('constraint references follow the copy: PASSED')
}

function testSaveLoadRoundTrip(): void {
  resetStore(makeProject())
  const { nestId } = nestIntoStore(['plate'], settings({ quantity: 3 }))
  const saved = useProjectStore.getState().project
  const loaded = normalizeProject(JSON.parse(JSON.stringify(saved)) as ProjectFormatInput)
  assert(JSON.stringify(loaded.nests) === JSON.stringify(saved.nests), 'nests survive save and load')
  resetStore(loaded)
  useProjectStore.getState().discardNest(nestId)
  assert(!useProjectStore.getState().project.nests, 'a loaded nest can be discarded')

  const plain = makeProject()
  assert(!('nests' in normalizeProject(JSON.parse(JSON.stringify(plain)) as ProjectFormatInput)), 'files that never nested gain no field')
  const malformed = normalizeProject({ ...JSON.parse(JSON.stringify(plain)), nests: [{ id: 'x' }, 'junk'] } as ProjectFormatInput)
  assert(!('nests' in malformed), 'malformed records are dropped, not fatal')
  console.log('nest save/load: PASSED')
}

function testCurvedPartsKeepTheGap(): void {
  // Curves are flattened for packing; the chord error must not eat the gap.
  const base = newProject()
  base.meta = { ...base.meta, units: 'mm' }
  base.stock = defaultStock(120, 90, 12, 'mm')
  base.tools = [{ ...defaultTool('mm', 1), id: 'tool-6', diameter: TOOL_DIAMETER }]
  const project = projectWithFeatures(base, [row('disc', 'add', circleProfile(20, 20, 15))])
  const edge = defaultOperationForTarget(project, 'edge_route_outside', 'finish', { source: 'features', featureIds: ['disc'] }, 0)
  project.operations = [{ ...edge, id: 'op-edge', toolRef: 'tool-6', stockToLeaveRadial: 0 }]
  resetStore(normalizeProject(JSON.parse(JSON.stringify(project)) as ProjectFormatInput))
  const { placed } = nestIntoStore(['disc'], settings({ quantity: 12, minimumGap: TOOL_DIAMETER, rotations: [0] }))
  const nested = useProjectStore.getState().project
  const disc = nested.features.find((feature) => feature.id === 'disc')!
  const discs = nested.features.filter((feature) => feature.definitionId === disc.definitionId).map((feature) => feature.id)
  assert(placed === discs.length && placed >= 4, `discs placed: ${placed}`)
  let closest = Infinity
  for (let i = 0; i < discs.length; i += 1) {
    for (let j = i + 1; j < discs.length; j += 1) {
      // Fine inscribed flattening can only over-state the true distance.
      closest = Math.min(closest, ringDistance(worldRing(nested, discs[i]), worldRing(nested, discs[j])))
    }
  }
  assert(closest >= TOOL_DIAMETER - 1e-6, `curved parts keep the gap: closest ${closest}`)
  // Tight up to the footprint simplification, which pads each part by 0.05 mm (#855).
  assert(closest <= TOOL_DIAMETER + 0.15, `and are packed tight: closest ${closest}`)
  console.log('curved parts keep the gap: PASSED')
}

function testClampsAreAvoided(): void {
  const project = makeProject()
  project.clamps = [{ id: 'clamp-1', name: 'Clamp', type: 'step_clamp', x: 60, y: 0, w: 20, h: 60, height: 20, visible: true }]
  resetStore(project)
  nestIntoStore(['plate'], settings({ quantity: 8 }))
  const nested = useProjectStore.getState().project
  const c = nested.meta.clampClearanceXY
  const clamp = project.clamps[0]
  const keepOut: Point[] = [
    { x: clamp.x - c, y: clamp.y - c }, { x: clamp.x + clamp.w + c, y: clamp.y - c },
    { x: clamp.x + clamp.w + c, y: clamp.y + clamp.h + c }, { x: clamp.x - c, y: clamp.y + clamp.h + c },
  ]
  for (const id of plateInstances(nested)) {
    const distance = ringDistance(worldRing(nested, id), keepOut)
    assert(distance >= GAP - 1e-6, `${id} is ${distance} from the clamp keep-out, need ${GAP}`)
  }
  console.log('clamps are avoided: PASSED')
}

function testClampCornersKeepTheRouteWhole(): void {
  // The toolpaths' clamp keep-out has square corners (#882): discs packed
  // around a clamp's corner must still leave the outside route uncut by it.
  // Without the corner pad, each of these clamp positions warns.
  for (const [x, y] of [[34, 34], [55, 55], [69, 20]]) {
    const base = newProject()
    base.meta = { ...base.meta, units: 'mm' }
    base.stock = defaultStock(120, 90, 12, 'mm')
    base.tools = [{ ...defaultTool('mm', 1), id: 'tool-6', diameter: TOOL_DIAMETER }]
    const project = projectWithFeatures(base, [row('disc', 'add', circleProfile(20, 20, 15))])
    const edge = defaultOperationForTarget(project, 'edge_route_outside', 'finish', { source: 'features', featureIds: ['disc'] }, 0)
    project.operations = [{ ...edge, id: 'op-edge', toolRef: 'tool-6', stockToLeaveRadial: 0 }]
    project.clamps = [{ id: 'clamp-1', name: 'Clamp', type: 'step_clamp', x, y, w: 10, h: 10, height: 20, visible: true }]
    resetStore(normalizeProject(JSON.parse(JSON.stringify(project)) as ProjectFormatInput))
    const { placed } = nestIntoStore(['disc'], settings({ quantity: 12, minimumGap: TOOL_DIAMETER, rotations: [0] }))
    assert(placed >= 4, `clamp at ${x},${y}: discs placed: ${placed}`)
    const nested = useProjectStore.getState().project
    const warnings = generateEdgeRouteToolpath(nested, nested.operations[0]).warnings
    assert(
      !warnings.some((warning) => warning.code === 'clampBlockedCut'),
      `clamp at ${x},${y}: the route is cut short by the clamp`,
    )
  }
  console.log('clamp corners keep the route whole: PASSED')
}

function testReplaceNestIsOneStep(): void {
  const before = makeProject()
  resetStore(before)
  const { nestId } = nestIntoStore(['plate'], settings({ quantity: 3 }))
  const first = useProjectStore.getState().project
  // Re-nest: compute on the project with the old nest discarded, commit as a replacement.
  const { nestId: replacedId } = nestIntoStore(first.nests![0].parts[0].sourceIds, settings({ quantity: 5 }), nestId)
  const after = useProjectStore.getState()
  assert(replacedId && replacedId !== nestId, 'a new nest replaces the old one')
  assert(after.project.nests?.length === 1, 'exactly one nest remains')
  assert(plateInstances(after.project).length === 5, 'five plates after re-nesting')
  assert(after.project.featureFolders.length === 1, 'the old nest folder is gone, the new one exists')
  assert(after.history.past.length === 2, 'replacing is one history entry')
  after.undo()
  assert(JSON.stringify(useProjectStore.getState().project) === JSON.stringify(first), 'one undo returns to the first nest')
  useProjectStore.getState().discardNest(nestId)
  assert(JSON.stringify(useProjectStore.getState().project.features) === JSON.stringify(before.features), 'discarding the first nest restores the design')
  console.log('replace nest: PASSED')
}

function testAmendedNestStaysOneStep(): void {
  const before = makeProject()
  resetStore(before)
  const { nestId } = nestIntoStore(['plate'], settings({ quantity: 3 }))
  // The keep-improving search swaps in a better layout of the same nest (#862).
  const sources = useProjectStore.getState().project.nests![0].parts[0].sourceIds
  const { nestId: amendedId } = nestIntoStore(sources, settings({ quantity: 3 }), nestId, true)
  const after = useProjectStore.getState()
  assert(amendedId !== nestId && after.project.nests?.length === 1, 'the amended layout replaces the nest')
  assert(after.history.past.length === 1, 'amending adds no history entry')
  after.undo()
  const undone = useProjectStore.getState().project
  assert(JSON.stringify(undone.features) === JSON.stringify(before.features), 'one undo restores the design')
  assert(!undone.nests, 'one undo drops the nest')
  console.log('amended nest stays one step: PASSED')
}

function testSearchFlagClearsWithThePanel(): void {
  resetStore(makeProject())
  const store = () => useProjectStore.getState()
  assert(store().nestSearching === false, 'no search by default')
  store().setNestSearching(true)
  assert(store().nestSearching, 'the panel marks a running search')
  // Closing the panel ends the search; toolpaths must not stay deferred.
  store().cancelNest()
  assert(store().nestSearching === false, 'closing the panel clears it')
  console.log('search flag clears with the panel: PASSED')
}

testPartResolution()
testApplyIsOneStepAndMachinesEveryCopy()
testDiscardRestoresTheDesign()
testKeepOriginalsNestsAround()
testConstraintReferencesFollowTheCopy()
testSaveLoadRoundTrip()
testCurvedPartsKeepTheGap()
testClampsAreAvoided()
testClampCornersKeepTheRouteWhole()
testReplaceNestIsOneStep()
testAmendedNestStaysOneStep()
testSearchFlagClearsWithThePanel()
console.log('All nesting store tests passed')
