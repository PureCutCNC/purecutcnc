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

/** #955. Persistence, missing-field migration, unit boundaries and real generator refusal.
 * Mutation checked: bypass either family guard, skip missing-field migration,
 * lose delay on normalization, omit height unit conversion, ignore delay in
 * deduplication, drop the half-kerf, bypass the engraving lookup, or leak RPM.
 * Follow-up regressions cover creation/import/history, normalized delay/material
 * number, default/library settings, and all reviewed cutter-only readers.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { useSimulationModel } from './app/useSimulationModel'
import { readFileSync, readdirSync } from 'node:fs'
import { defaultTool, newProject, rectProfile } from './types/project'
import type { OperationKind, Project, Tool } from './types/project'
import { normalizeProject, decodeProjectFormat } from './store/helpers/projectFormat'
import { normalizeTool } from './store/helpers/normalize'
import { defaultOperationForTarget, toolMatchesTemplate } from './store/helpers/operationDefaults'
import { useProjectStore } from './store/projectStore'
import { projectWithFeatures } from './test/projectFixtures'
import { convertToolUnits, convertProjectUnits } from './utils/units'
import { defaultPlasmaTool, findMillingOperationTool, findOperationTool, isToolCompatibleWithOperation, plasmaToolDefaults } from './toolPolicy'
import { parseToolLibraryFile } from './toolLibrary'
import { toolMatchesLibraryEntry } from './components/cam/toolLibraryDialogModel'
import { normalizeToolForProject } from './engine/toolpaths/geometry'
import { generatePocketToolpath, generateEdgeRouteToolpath, generateFollowLineToolpath,
  generateDrillingToolpath, generateVCarveToolpath, generateVCarveMedialToolpath,
  generateSurfaceCleanToolpath, generateRoughSurfaceToolpath, generateFinishSurfaceToolpath,
  generateFinishSurfaceCleanupToolpath } from './engine/toolpaths'
import { selectToolForOperation } from './engine/operations/toolSelection'
import { cutterSurfaceZ } from './engine/simulation/tools'
import { mergeCamjFolders } from './import/camj'
import { buildToolMesh, disposeToolMesh } from './engine/simulation/toolMesh'
import { THEME_PALETTES } from './theme/palette'
import { applyMoveToGrid, simulateOperationHeightfield, simulateReplayItemsHeightfield } from './engine/simulation/replay'
import { createSimulationGrid } from './engine/simulation/grid'
import type { ToolpathMove } from './engine/toolpaths/types'
import { buildOperationBookletReport } from './engine/operationBooklet/report'
import { clampCheckToolRadius } from './engine/toolpaths/clamps'
import { operationFootprint } from './engine/toolpaths/toolpathDependencies'
import { buildAutoTabsForFeature } from './engine/operations/autoTabs'
import { resolveFeatureInstance } from './store/helpers/resolveFeatures'
import { nestGapForPart, nestEdgeClearance } from './store/helpers/nestPart'

const plasma: Tool = {
  ...plasmaToolDefaults('mm'), id: 'p1', name: '45 A consumables',
  diameter: 1.2, defaultFeed: 2200, pierceHeight: 3.8, cutHeight: 1.5,
  pierceDelay: 0.65, qtplasmacMaterialNumber: 12,
}
const milling = defaultTool('mm')
function fixture(): Project {
  return normalizeProject(projectWithFeatures({ ...newProject('Plasma tools', 'mm'), tools: [plasma, milling] }, [{
    id: 'f1', name: 'Pocket', kind: 'rect', folderId: null, visible: true, locked: false,
    operation: 'subtract', z_top: 10, z_bottom: 8,
    sketch: { profile: rectProfile(10, 10, 30, 20), origin: { x: 0, y: 0 },
      orientationAngle: 0, dimensions: [], constraints: [] },
  }]))
}
function seed(project: Project): void {
  useProjectStore.setState({ project, dirty: false, history: { past: [], future: [], transactionStart: null } })
}
const store = () => useProjectStore.getState()
const project = fixture()
assert.deepEqual(project.tools[0], plasma, 'configured plasma values survive initial normalization')
seed(project)
const file = JSON.parse(store().saveProject()) as Project
assert.equal(file.version, '3.3', 'format stays 3.3')
assert.deepEqual(file.tools, project.tools, 'save preserves all plasma parameters and milling tools')
store().openProjectFromText(JSON.stringify(file), null)
assert.deepEqual(store().project.tools, project.tools, 'real store save/open round trip')
assert.deepEqual(JSON.parse(store().saveProject()).tools, file.tools, 'second save is stable')

for (const version of ['3.2', '3.3'] as const) {
  const partial = structuredClone(file)
  partial.version = version
  delete partial.tools[0].pierceHeight
  delete partial.tools[0].cutHeight
  delete partial.tools[0].pierceDelay
  delete partial.tools[0].qtplasmacMaterialNumber
  const migrated = decodeProjectFormat(partial).project
  const expected = { ...plasma, pierceHeight: 0, cutHeight: 0, pierceDelay: 0 }
  delete expected.qtplasmacMaterialNumber
  assert.deepEqual(migrated.tools[0], expected, 'missing plasma fields migrate without a version gate')
  assert.deepEqual(migrated.tools[1], milling, 'no plasma fields backfilled on milling')
  assert.deepEqual(normalizeProject(migrated), migrated, 'migration is idempotent')
}
for (const field of ['diameter', 'defaultFeed', 'pierceHeight', 'cutHeight', 'pierceDelay'] as const) {
  for (const invalid of [-1, NaN, Infinity, null, '3']) {
    assert.throws(() => normalizeTool({ ...plasma, [field]: invalid } as Tool, 'mm', 0), /Invalid plasma tool/)
  }
}
// A material number outside the selectable range is cleared, never thrown: a
// project file carrying one must still open, and the export then blocks with
// `postPlasmaMaterialMissing`. 0 is the simulator's "nothing selected"
// sentinel; 1000000+ belongs to QtPlasmaC's own temporary materials.
for (const invalid of [-1, 0, 1.5, NaN, Infinity, null, '12', 1000000, 1000001, Number.MAX_SAFE_INTEGER + 1]) {
  assert.equal(normalizeTool({ ...plasma, qtplasmacMaterialNumber: invalid } as Tool, 'mm', 0).qtplasmacMaterialNumber, undefined,
    `material ${String(invalid)} is not selectable and is cleared`)
}
for (const valid of [1, 12, 999999]) {
  assert.equal(normalizeTool({ ...plasma, qtplasmacMaterialNumber: valid }, 'mm', 0).qtplasmacMaterialNumber, valid,
    `material ${valid} is selectable`)
}
// The real open path recovers too: a stored reserved number opens the project
// with the material unset instead of failing the load.
for (const material of [0, 1000000]) {
  const stored = structuredClone(file)
  stored.tools[0].qtplasmacMaterialNumber = material
  const opened = decodeProjectFormat(stored).project
  assert.equal(opened.tools[0].qtplasmacMaterialNumber, undefined, `a saved material ${material} is cleared on open`)
  assert.deepEqual(opened.tools[1], milling, 'the milling tool is untouched')
  seed(project)
  store().openProjectFromText(JSON.stringify(stored), null)
  assert.equal(store().project.tools[0].qtplasmacMaterialNumber, undefined, `the store opens a saved material ${material}`)
}

const inch = convertToolUnits(plasma, 'inch')
for (const field of ['diameter', 'defaultFeed', 'pierceHeight', 'cutHeight'] as const) {
  assert.ok(Math.abs(inch[field]! - plasma[field]! / 25.4) < 1e-9, field + ' scales to inches')
  assert.ok(Math.abs(convertToolUnits(inch, 'mm')[field]! - plasma[field]!) < 1e-9, field + ' converts back')
}
assert.equal(inch.pierceDelay, plasma.pierceDelay, 'seconds are not lengths')
assert.equal(inch.qtplasmacMaterialNumber, 12, 'material id is not a length')
const inchProject = convertProjectUnits(project, 'inch')
assert.deepEqual(inchProject.tools, project.tools, 'project conversion preserves native tool units')
assert.equal(normalizeToolForProject(plasma, inchProject).cutHeight, inch.cutHeight)
const staleMilling = { ...plasma, flutes: 17, defaultRpm: 19000, defaultStepdown: 7,
  defaultPlungeFeed: 800, defaultStepover: 0.8, maxCutDepth: 90 }
const normalized = normalizeToolForProject(staleMilling, project)
assert.equal(normalized.radius, 0.6, 'offset radius is half the full kerf')
for (const field of ['flutes', 'defaultRpm', 'defaultStepdown', 'defaultStepover', 'maxCutDepth'] as const) {
  assert.equal(normalized[field], 0, 'normalized plasma ignores milling field ' + field)
}
// The plunge feed is not a milling-only field on a plasma tool: it is the drop
// feed a G-code pierce writes (#983), so it survives normalization instead of
// being zeroed. Zero still means unconfigured and blocks the export.
assert.equal(normalized.defaultPlungeFeed, 800, 'the plasma drop feed is preserved, not zeroed')
assert.equal(normalized.defaultFeed, 2200)
assert.equal(normalized.pierceHeight, 3.8)
assert.equal(normalized.cutHeight, 1.5)
assert.equal(normalized.pierceDelay, 0.65, 'generation retains seconds delay')
assert.equal(normalized.qtplasmacMaterialNumber, 12, 'generation retains material table number')
assert.equal(normalizeToolForProject(plasma, inchProject).pierceDelay, 0.65)
assert.equal(normalizeToolForProject(plasma, inchProject).qtplasmacMaterialNumber, 12)
assert.equal(cutterSurfaceZ('plasma', 0.6, 1.5, 0), null, 'torch is not simulated as a milling cutter')

const kinds: OperationKind[] = ['pocket', 'v_carve', 'v_carve_medial', 'edge_route_inside', 'edge_route_outside',
  'surface_clean', 'rough_surface', 'finish_surface', 'finish_surface_cleanup', 'follow_line', 'drilling']
for (const kind of kinds) {
  assert.equal(isToolCompatibleWithOperation(plasma, kind), false, kind + ' refuses plasma')
  assert.equal(isToolCompatibleWithOperation(milling, 'plasma_profile'), false, 'plasma refuses milling')
  const operation = defaultOperationForTarget(project, kind, 'rough', { source: 'features', featureIds: ['f1'] }, 0)
  assert.equal(operation.toolRef, milling.id, 'default never assigns the first plasma tool')
  assert.equal(findOperationTool(project, { ...operation, toolRef: plasma.id }), null)
  const selected = selectToolForOperation(project, kind, operation.target, [])
  assert.ok(selected === null || selected.source !== 'existing' || selected.toolId !== plasma.id)
  seed({ ...project, operations: [operation] })
  store().updateOperation(operation.id, { toolRef: plasma.id })
  assert.equal(store().project.operations[0].toolRef, milling.id, 'store rejects incompatible assignment')
  assert.equal(store().history.past.length, 0, 'refused assignment is not an undo step')
}
assert.equal(isToolCompatibleWithOperation(plasma, 'plasma_profile'), true)
for (const type of ['flat_endmill', 'ball_endmill', 'v_bit', 'drill'] as const) {
  assert.equal(isToolCompatibleWithOperation({ type }, 'plasma_profile'), false)
}
// Direct generator calls must also refuse malformed loaded references, beyond the UI/store gate.
const generators = [
  ['pocket', generatePocketToolpath], ['edge_route_inside', generateEdgeRouteToolpath],
  ['edge_route_outside', generateEdgeRouteToolpath], ['follow_line', generateFollowLineToolpath],
  ['drilling', generateDrillingToolpath], ['v_carve', generateVCarveToolpath],
  ['v_carve_medial', generateVCarveMedialToolpath], ['surface_clean', generateSurfaceCleanToolpath],
  ['rough_surface', generateRoughSurfaceToolpath], ['finish_surface', generateFinishSurfaceToolpath],
  ['finish_surface_cleanup', generateFinishSurfaceCleanupToolpath],
] as const
const meshProject = decodeProjectFormat(JSON.parse(readFileSync(new URL('./engine/test-fixtures/issue-401-cone-finish.camj', import.meta.url), 'utf8'))).project
meshProject.tools.push(plasma)
const meshFeature = meshProject.features.find((feature) => meshProject.featureDefinitions[feature.definitionId].kind === 'stl')!
assert.ok(meshFeature, 'real cone fixture supplies a model target')
for (const [kind, generate] of generators) {
  const usesMesh = kind === 'rough_surface' || kind === 'finish_surface' || kind === 'finish_surface_cleanup'
  const source = usesMesh ? meshProject : project
  const target = { source: 'features' as const, featureIds: [usesMesh ? meshFeature.id : 'f1'] }
  const operation = { ...defaultOperationForTarget(source, kind, 'rough', target, 0), toolRef: plasma.id }
  const result = generate(source, operation)
  assert.equal(result.moves.length, 0, kind + ' cannot mill with a plasma consumable')
  assert.ok(result.warnings.some((warning) => warning.code === 'noToolAssigned'), kind + ' reports the missing compatible tool')
}
const operation = defaultOperationForTarget(project, 'pocket', 'rough', { source: 'features', featureIds: ['f1'] }, 0)
seed({ ...project, operations: [operation] })
store().updateTool(milling.id, { type: 'plasma' })
assert.equal(store().project.operations[0].toolRef, null, 'type switch detaches incompatible operation')
store().undo()
assert.equal(store().project.operations[0].toolRef, milling.id, 'type switch and detachment undo together')
assert.equal(store().project.tools[1].type, 'flat_endmill')

const minimalLibrary = parseToolLibraryFile({ tools: [{
  key: 'minimal-plasma', name: plasma.name, units: 'mm', type: 'plasma', diameter: 1.2, defaultFeed: 2200,
  pierceHeight: 3.8, cutHeight: 1.5, pierceDelay: 0.65, qtplasmacMaterialNumber: 12,
}] })
assert.equal(minimalLibrary.tools.length, 1, 'plasma library entry needs no milling-only fields')
assert.equal(minimalLibrary.tools[0].defaultRpm, 0)
assert.equal(parseToolLibraryFile({ tools: [{ ...plasma, key: 'bad-plasma', pierceDelay: -1 }] }).tools.length, 0)

const library = parseToolLibraryFile({ tools: [{ ...plasma, key: 'plasma-45' }] })
assert.equal(library.tools.length, 1, 'library parser accepts plasma without positive milling values')
assert.ok(toolMatchesTemplate(plasma, library.tools[0]))
assert.ok(toolMatchesLibraryEntry(plasma, library.tools[0]))
for (const field of ['pierceHeight', 'cutHeight', 'pierceDelay', 'qtplasmacMaterialNumber'] as const) {
  const changed = { ...library.tools[0], [field]: plasma[field]! + 1 }
  assert.equal(toolMatchesTemplate(plasma, changed), false, field + ' prevents wrong consumable reuse')
  assert.equal(toolMatchesLibraryEntry(plasma, changed), false, field + ' remains importable')
}
seed(project)
assert.equal(store().importTools(library.tools).length, 0, 'same consumable is not duplicated')
assert.equal(store().importTools([{ ...library.tools[0], pierceDelay: 1.1 }]).length, 1, 'different pierce settings import separately')

// New tools use a named manufacturer's example; legacy missing fields still migrate to zero.
const starting = defaultPlasmaTool('mm')
assert.equal(starting.diameter, 1.4)
assert.equal(starting.defaultFeed, 5560)
assert.equal(starting.pierceHeight, 3.8)
assert.equal(starting.cutHeight, 1.5)
assert.equal(starting.pierceDelay, 0.2)
assert.equal(starting.qtplasmacMaterialNumber, undefined)
const startingInch = defaultPlasmaTool('inch')
for (const field of ['diameter', 'defaultFeed', 'pierceHeight', 'cutHeight'] as const) {
  assert.equal(startingInch[field], starting[field]! / 25.4, 'new defaults honor tool units')
}
assert.equal(startingInch.pierceDelay, 0.2)
const bundledRaw = JSON.parse(readFileSync(new URL('../public/tool-library.json', import.meta.url), 'utf8'))
const bundled = parseToolLibraryFile(bundledRaw)
const bundledPlasma = bundled.tools.find((tool) => tool.type === 'plasma' && tool.units === 'mm')
assert.ok(bundledPlasma, 'bundled library includes a plasma consumable')
assert.deepEqual({ ...bundledPlasma, key: undefined, name: undefined }, { ...starting, key: undefined, name: undefined })
const bundledInch = bundled.tools.find((tool) => tool.type === 'plasma' && tool.units === 'inch')
assert.ok(bundledInch, 'the default inch filter also offers a plasma consumable')
assert.deepEqual({ ...bundledInch, key: undefined, name: undefined }, { ...startingInch, key: undefined, name: undefined })
assert.equal(bundled.tools.filter((tool) => tool.type !== 'plasma').length, 34, 'all bundled milling tools remain')

// Exercise the public creation action, including an unavailable/empty library.
for (const kind of ['pocket', 'v_carve', 'v_carve_medial', 'follow_line', 'edge_route_outside'] as const) {
  for (const available of [undefined, [], [bundledPlasma]]) {
    const creationProject = kind === 'edge_route_outside' ? {
      ...project, featureDefinitions: Object.fromEntries(Object.entries(project.featureDefinitions)
        .map(([id, definition]) => [id, { ...definition, operation: 'add' as const }])),
    } : project
    seed({ ...creationProject, tools: [plasma], operations: [] })
    const id = store().addOperation(kind, 'rough', { source: 'features', featureIds: ['f1'] }, available)
    assert.ok(id, kind + ' creates a visible operation')
    const created = store().project.operations.find((op) => op.id === id)!
    assert.equal(created.toolRef, null, kind + ' creation cannot fall back to a torch')
    assert.equal(created.feed, defaultTool('mm').defaultFeed, 'unassigned operation uses milling defaults')
    store().undo()
    assert.equal(store().project.operations.length, 0)
    store().redo()
    assert.equal(store().project.operations[0].toolRef, null, 'creation redo remains detached')
  }
}

const malformed = { ...project, operations: [{ ...operation, toolRef: plasma.id }] }
for (const version of ['3.2', '3.3'] as const) {
  seed(project)
  store().openProjectFromText(JSON.stringify({ ...malformed, version }), null)
  assert.equal(store().project.operations[0].toolRef, null, 'open detaches a plasma-assigned milling operation')
  assert.equal(JSON.parse(store().saveProject()).operations[0].toolRef, null, 'save keeps repaired reference')
  const id = store().project.operations[0].id
  store().updateOperation(id, { name: 'Editable after repair' })
  assert.equal(store().project.operations[0].name, 'Editable after repair')
  const duplicateId = store().duplicateOperation(id)
  assert.ok(duplicateId)
  assert.equal(store().project.operations.at(-1)!.toolRef, null)
  store().undo(); store().redo()
  assert.ok(store().project.operations.every((op) => op.toolRef === null), 'history never restores incompatible tools')
}
// Old in-memory snapshots and raw duplicate callers are protected as well.
seed(malformed)
assert.ok(store().duplicateOperation(operation.id))
assert.equal(store().project.operations.at(-1)!.toolRef, null, 'raw duplicate detaches the torch')
store().undo(); store().redo()
assert.ok(store().project.operations.every((op) => op.toolRef === null))
seed(malformed)
store().updateOperation(operation.id, { name: 'Unrelated edit works' })
assert.equal(store().project.operations[0].name, 'Unrelated edit works')
assert.equal(store().project.operations[0].toolRef, null)

const folderSource: Project = { ...malformed,
  featureFolders: [{ id: 'plasma-folder', name: 'Imported', collapsed: false, section: 'features' }],
  features: malformed.features.map((feature) => ({ ...feature, folderId: 'plasma-folder' })),
}
const merged = mergeCamjFolders({ currentProject: newProject('Import', 'mm'), sourceProject: folderSource,
  selectedFolderIds: ['plasma-folder'], importStock: false })
assert.equal(merged.project.operations.length, 1)
assert.equal(merged.project.operations[0].toolRef, null, 'pure folder merge detaches incompatible source references')
seed(newProject('Store import', 'mm'))
assert.equal(store().importCamjFolders({ fileName: 'plasma-source.camj', sourceProject: folderSource, selectedFolderIds: ['plasma-folder'], importStock: false }).length, 1)
assert.equal(store().project.operations[0].toolRef, null, 'actual folder import action remains detached')
store().undo(); store().redo()
assert.equal(store().project.operations[0].toolRef, null, 'folder import history remains detached')

// Cutter-only readers must also fail closed for raw projects bypassing normalization.
const badOperation = malformed.operations[0]
assert.equal(findMillingOperationTool(malformed, badOperation), null)
assert.equal(clampCheckToolRadius(malformed, badOperation), 0)
assert.equal(operationFootprint(malformed, badOperation).bounds, null)
const feature = resolveFeatureInstance(project, 'f1')!
assert.deepEqual(buildAutoTabsForFeature(feature, { ...malformed, tools: [{ ...plasma, diameter: 20 }] }, badOperation, []).map((tab) => ({ ...tab, id: undefined })),
  buildAutoTabsForFeature(feature, { ...malformed, tools: [] }, { ...badOperation, toolRef: null }, []).map((tab) => ({ ...tab, id: undefined })),
  'auto-tabs never use plasma kerf as milling diameter')
const outside = { ...badOperation, kind: 'edge_route_outside' as const }
assert.equal(nestGapForPart({ ...malformed, operations: [outside] }, ['f1']), null, 'nesting ignores invalid plasma cutter gap')
assert.equal(nestEdgeClearance({ ...malformed, operations: [outside] }, ['f1']), null, 'nesting ignores invalid plasma cutter clearance')
const threePalette = THEME_PALETTES.dark.three
const mesh = buildToolMesh({ toolType: 'plasma', toolRadius: 0.6, vBitAngle: null, threePalette })
assert.equal(mesh.children.length, 0, 'plasma produces no milling cutter/shank mesh')
disposeToolMesh(mesh)
const millMesh = buildToolMesh({ toolType: 'flat_endmill', toolRadius: 2, vBitAngle: null, threePalette })
assert.equal(millMesh.children.length, 2, 'milling mesh remains intact')
disposeToolMesh(millMesh)
const grid = createSimulationGrid(project, { targetLongAxisCells: 30 })
const x = grid.originX + 5.5 * grid.cellSize
const y = grid.originY + 5.5 * grid.cellSize
const move: ToolpathMove = { kind: 'cut', from: { x, y, z: 5 }, to: { x: x + grid.cellSize, y, z: 5 } }
const before = grid.topZ.slice()
assert.equal(applyMoveToGrid(grid, move, 2, 'plasma', null).changedCount, 0, 'direct optimized simulation kernel skips plasma')
assert.deepEqual(grid.topZ, before)
assert.ok(applyMoveToGrid(grid, move, 2, 'flat_endmill', null).changedCount > 0, 'control: the same move cuts with a mill')
const emptyPath = generatePocketToolpath(malformed, badOperation)
const cachedPath = { ...emptyPath, moves: [move] }
const rejectedSimulation = simulateOperationHeightfield(malformed, badOperation, cachedPath, { targetLongAxisCells: 30 })
assert.equal(rejectedSimulation.stats.processedMoveCount, 0)
assert.deepEqual(rejectedSimulation.warnings, [{ code: 'replayNoTool' }],
  'static simulation rejects an incompatible tool at lookup, before the replay guard')
assert.deepEqual(rejectedSimulation.grid.topZ, before, 'rejected static simulation preserves the stock')
assert.equal(simulateReplayItemsHeightfield(malformed, [{ operationId: badOperation.id, operationName: badOperation.name,
  toolRef: plasma.id, toolType: 'plasma', toolRadius: 2, vBitAngle: null, toolpath: cachedPath }],
{ targetLongAxisCells: 30 }).stats.processedMoveCount, 0, 'replay refuses stale plasma cutter moves')
function simulationProbe(source: Project): string {
  function Probe() {
    const result = useSimulationModel({ project: source, centerTab: 'simulation', simulationMode: 'selected',
      simulationDetailCells: 30, selectedOperation: source.operations[0], selectedToolpath: cachedPath,
      requestToolpath: async () => null })
    return createElement('span', null, JSON.stringify({ count: result.simulationOperationCount,
      playback: result.simulationPlaybackInput !== null, moves: result.simulationResult?.stats.processedMoveCount }))
  }
  return renderToString(createElement(Probe))
}
assert.equal(simulationProbe(malformed), '<span>{&quot;count&quot;:0,&quot;playback&quot;:false,&quot;moves&quot;:0}</span>',
  'real simulation hook excludes plasma playback even with a cached path')
assert.ok(simulationProbe({ ...project, operations: [operation] }).includes('&quot;playback&quot;:true'),
  'milling playback remains available')
// Isolate the independent lookup boundaries: outer preflight/acquisition guards
// otherwise hide a broken lookup behind another rejection. Module mocks live in
// a child process, so neither the real hook above nor other tests are affected.
function assertPlaybackLookupBoundary(boundary: 'selected' | 'prior', source: Project): void {
  const probe = `
    import assert from 'node:assert/strict'
    import { mock } from 'node:test'
    import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { pathToFileURL } from 'node:url'
    import ts from 'typescript'
    import * as React from 'react'
    import { renderToString } from 'react-dom/server'
    const { boundary, project, cachedPath, root } = JSON.parse(process.argv[1])
    const policyUrl = new URL('src/toolPolicy.ts', root).href
    const geometryUrl = new URL('src/engine/toolpaths/geometry.ts', root).href
    const policy = await import(policyUrl)
    const geometry = await import(geometryUrl)
    // Keep static simulation's dependencies real; isolate only the hook boundary.
    await import(new URL('src/engine/simulation/index.ts', root).href)
    // Fresh dependency aliases avoid Node 20's already-loaded ESM cache. The
    // hook's source is unchanged apart from import paths and type erasure.
    const directory = mkdtempSync(join(tmpdir(), 'purecut-plasma-lookup-'))
    const aliases = Object.fromEntries(['policy', 'react', 'geometry'].map((name) => {
      const path = join(directory, name + '.mjs')
      writeFileSync(path, 'export {}')
      return [name, pathToFileURL(path).href]
    }))
    const selected = project.operations.at(-1)
    const normalizedTools = []
    const exportsFor = (namespace) => Object.fromEntries(Object.entries(namespace)
      .filter(([name]) => name !== 'default' && name !== 'module.exports'))
    // Assume the two outer selected-operation preflights already passed. The
    // selected-tool lookup must still independently refuse the plasma record.
    let preflightPasses = boundary === 'selected' ? 2 : 0
    mock.module(aliases.policy, { cache: true, namedExports: { ...exportsFor(policy),
      findMillingOperationTool(project, operation) {
        if (operation.id === selected.id && preflightPasses > 0) {
          preflightPasses--
          return project.tools.find((tool) => tool.id === operation.toolRef)
        }
        return policy.findMillingOperationTool(project, operation)
      },
    } })
    // Seed already-acquired paths, including a stale incompatible prior path.
    // This exercises deferred replay's own guard rather than acquisition's.
    // The seed carries the requirement stamp the hook computes (#947): the
    // eligible operations before the selected one, all in its one setup.
    const requiredKey = project.operations.slice(0, -1)
      .filter((operation) => operation.enabled && operation.showToolpath
        && policy.findMillingOperationTool(project, operation) !== null)
      .map((operation) => operation.id).join(',')
    mock.module(aliases.react, { cache: true, namedExports: { ...exportsFor(React),
      useState(initial) {
        return React.useState(initial === null ? { project, requiredKey,
          paths: new Map(project.operations.map((operation) => [operation.id,
            { ...cachedPath, operationId: operation.id }])) } : initial)
      },
    } })
    mock.module(aliases.geometry, { cache: true, namedExports: { ...exportsFor(geometry),
      normalizeToolForProject(tool, project) {
        assert.notEqual(tool.type, 'plasma', boundary + ' playback must reject plasma before cutter normalization')
        normalizedTools.push(tool.id)
        return geometry.normalizeToolForProject(tool, project)
      },
    } })
    const hookUrl = new URL('src/app/useSimulationModel.ts', root)
    const source = ts.transpileModule(readFileSync(hookUrl, 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
    } }).outputText
      .replace("'../toolPolicy'", JSON.stringify(aliases.policy))
      .replace("'react'", JSON.stringify(aliases.react))
      .replace("'../engine/simulation'", JSON.stringify(new URL('src/engine/simulation/index.ts', root).href))
      .replace("'../engine/toolpaths/geometry'", JSON.stringify(aliases.geometry))
      // Any other relative import resolves where the hook really lives.
      .replace(/from '(\\.\\.?\\/[^']+)'/g, (_, specifier) => 'from ' + JSON.stringify(new URL(specifier + '.ts', hookUrl).href))
    const hookPath = join(directory, 'hook.mjs')
    writeFileSync(hookPath, source)
    try {
      const { useSimulationModel } = await import(pathToFileURL(hookPath).href)
      let result
      function Probe() {
        result = useSimulationModel({ project, centerTab: 'simulation', simulationMode: 'selected',
          simulationDetailCells: 30, selectedOperation: selected, selectedToolpath: cachedPath,
          requestToolpath: async () => { throw new Error('deferred playback must not generate paths') } })
        return null
      }
      renderToString(React.createElement(Probe))
      if (boundary === 'selected') {
        assert.equal(preflightPasses, 0, 'selected boundary probe must pass both outer preflights')
        assert.equal(result.simulationPlaybackInput, null, 'selected lookup rejects plasma even after a passed preflight')
        assert.deepEqual(normalizedTools, [], 'rejected selected tool never reaches cutter normalization')
      } else {
        const playback = result.simulationPlaybackInput
        assert.ok(playback, 'control: a selected milling tool still has playback')
        const beforeReplay = normalizedTools.length
        const grid = playback.getBaseGrid()
        assert.ok(normalizedTools.length > beforeReplay, 'calling deferred getBaseGrid actually replays the prior mill')
        assert.ok(grid.topZ.some((z) => z < project.stock.thickness), 'prior mill removes material from the base grid')
        assert.equal(playback.getBaseGrid(), grid, 'deferred base grid is cached')
      }
    } finally {
      mock.restoreAll()
      rmSync(directory, { recursive: true, force: true })
    }
  `
  const run = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx',
    '--input-type=module', '--eval', probe, JSON.stringify({ boundary, project: source, cachedPath,
      root: new URL('../', import.meta.url).href })], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 30000,
  })
  assert.equal(run.status, 0, boundary + ' playback lookup boundary: ' + (run.error?.message ?? '') + run.stdout + run.stderr)
}
assertPlaybackLookupBoundary('selected', malformed)
assertPlaybackLookupBoundary('prior', { ...project, operations: [
  { ...operation, id: 'prior-mill' },
  { ...badOperation, id: 'prior-plasma' },
  { ...operation, id: 'selected-mill' },
] })

const report = buildOperationBookletReport({ project: malformed, operation: badOperation,
  tool: normalized, toolpath: cachedPath, generatedAt: new Date('2026-10-04T00:00:00Z') })
const noToolReport = buildOperationBookletReport({ project: malformed, operation: badOperation,
  tool: null, toolpath: cachedPath, generatedAt: new Date('2026-10-04T00:00:00Z') })
assert.deepEqual(report, noToolReport, 'booklet never prints a plasma consumable as a milling cutter')

// Every existing checked-in milling tool keeps exactly the former normalization.
let files = 0
for (const dir of [new URL('./engine/test-fixtures/', import.meta.url), new URL('../public/examples/', import.meta.url)]) {
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.camj'))) {
    const raw = JSON.parse(readFileSync(new URL(name, dir), 'utf8')) as Project
    const loaded = decodeProjectFormat(raw).project
    assert.deepEqual(loaded.tools, raw.tools.map((tool, index) => ({
      ...defaultTool(raw.meta.units, index + 1), ...tool,
      vBitAngle: tool.type === 'v_bit' ? tool.vBitAngle ?? 60 : null,
    })), name + ': existing tools load unchanged')
    files++
  }
}
assert.ok(files >= 15, 'checked-in compatibility corpus exercised')
console.log('Plasma tool persistence, units, compatibility, direct generators, library and legacy corpus passed (' + files + ' files).')
