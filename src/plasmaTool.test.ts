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
 * All nine failed this test; no survivors.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { defaultTool, newProject, rectProfile } from './types/project'
import type { OperationKind, Project, Tool } from './types/project'
import { normalizeProject, decodeProjectFormat } from './store/helpers/projectFormat'
import { normalizeTool } from './store/helpers/normalize'
import { defaultOperationForTarget, toolMatchesTemplate } from './store/helpers/operationDefaults'
import { useProjectStore } from './store/projectStore'
import { projectWithFeatures } from './test/projectFixtures'
import { convertToolUnits, convertProjectUnits } from './utils/units'
import { findOperationTool, isToolCompatibleWithOperation, plasmaToolDefaults } from './toolPolicy'
import { parseToolLibraryFile } from './toolLibrary'
import { toolMatchesLibraryEntry } from './components/cam/toolLibraryDialogModel'
import { normalizeToolForProject } from './engine/toolpaths/geometry'
import { generatePocketToolpath, generateEdgeRouteToolpath, generateFollowLineToolpath,
  generateDrillingToolpath, generateVCarveToolpath, generateVCarveMedialToolpath,
  generateSurfaceCleanToolpath, generateRoughSurfaceToolpath, generateFinishSurfaceToolpath,
  generateFinishSurfaceCleanupToolpath } from './engine/toolpaths'
import { selectToolForOperation } from './engine/operations/toolSelection'
import { cutterSurfaceZ } from './engine/simulation/tools'

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
for (const invalid of [-1, 1.5, NaN, Infinity, null, '12']) {
  assert.throws(() => normalizeTool({ ...plasma, qtplasmacMaterialNumber: invalid } as Tool, 'mm', 0), /material number/)
}
assert.equal(normalizeTool({ ...plasma, qtplasmacMaterialNumber: 0 }, 'mm', 0).qtplasmacMaterialNumber, 0)

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
for (const field of ['flutes', 'defaultRpm', 'defaultStepdown', 'defaultPlungeFeed', 'defaultStepover', 'maxCutDepth'] as const) {
  assert.equal(normalized[field], 0, 'normalized plasma ignores milling field ' + field)
}
assert.equal(normalized.defaultFeed, 2200)
assert.equal(normalized.pierceHeight, 3.8)
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
