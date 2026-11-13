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
 * The #395 review fixes at the generation seam (slice H1).
 *
 * Three rules, each proved on real `computeOperationToolpath` output rather
 * than on a hand-built toolpath:
 *
 * 1. A chuck or tailstock band covers every turn the job can reach, so an
 *    engraving one turn above or below the sheet is kept out exactly as the
 *    same engraving inside the first circumference is.
 * 2. A cutting move the operation works out for itself — an Engrave's carve
 *    depth, a countersink's derived plunge — that reaches the bar's centreline
 *    refuses the operation (`aroundCutReachesCentreline`), while the same
 *    operation one step shallower generates.
 * 3. A flat face and Around exchange nothing: a Top pocket's toolpath and
 *    exported program are identical whether or not the project holds an
 *    overlapping Around subtract and add, and `flatFaceProject` returns the
 *    project itself when it has no Around feature.
 *
 * Mutations checked one at a time against these assertions:
 * - the band limited to one circumference again: testBandCoversEveryReachableTurn
 * - the motion centreline check removed: testCutReachingCentreline
 * - Around features left in a flat operation's project: testFlatFacesExchangeNothing
 * - the helper copying a project that has no Around feature: testFlatFacesExchangeNothing
 *
 * Run with: npx tsx src/engine/aroundReview.test.ts
 */

import assert from 'node:assert/strict'
import { circleProfile, defaultTool, newProject, rectProfile, roundStock } from '../types/project'
import type {
  Clamp, MachiningSetup, Operation, Project, SetupFace, SketchFeature, SketchProfile, Stock, Tool,
} from '../types/project'
import { projectWithFeatures } from '../test/projectFixtures'
import { flatFaceProject } from './aroundFrame'
import { computeOperationToolpath } from './toolpaths/generateOperation'
import { normalizeToolForProject } from './toolpaths/geometry'
import type { ToolpathResult } from './toolpaths/types'
import { BUNDLED_DEFINITIONS } from './gcode/definitions'
import { validateMachineDefinition } from './gcode/types'
import { runPostProcessor } from './gcode/postprocessor'

const BAR = roundStock(40, 200, 'x', { x: 10, y: 30 })
const SHEET_START = 30
const CIRCUMFERENCE = Math.PI * BAR.thickness

function aroundSetup(axis: 'x' | 'y' = 'x'): MachiningSetup {
  return {
    id: 'around', name: 'Around', kind: 'around', orientation: { axis, angleDeg: 0 },
    indexing: 'manual', registration: [], notes: '', operationIds: [],
  }
}

function line(from: { x: number; y: number }, to: { x: number; y: number }): SketchProfile {
  return { start: from, segments: [{ type: 'line', to }], closed: false }
}

function tool(id: string, type: Tool['type'], diameter: number, over: Partial<Tool> = {}): Tool {
  return { ...defaultTool('mm', 1), id, name: id, diameter, type, maxCutDepth: 60, ...over }
}

interface Draft {
  id: string
  profile: SketchProfile
  kind?: SketchFeature['kind']
  operation: NonNullable<SketchFeature['operation']>
  zTop: number
  zBottom: number
  authoringFace?: SetupFace
}

function draftFeature(draft: Draft): SketchFeature {
  return {
    id: draft.id,
    name: draft.id,
    kind: draft.kind ?? 'rect',
    folderId: null,
    sketch: { profile: draft.profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: draft.operation,
    z_top: draft.zTop,
    z_bottom: draft.zBottom,
    authoringFace: draft.authoringFace ?? 'top',
    visible: true,
    locked: false,
  }
}

function operation(id: string, kind: Operation['kind'], featureIds: string[], over: Partial<Operation> = {}): Operation {
  return {
    id, name: id, kind, setupId: 'around', pass: 'rough', enabled: true, showToolpath: true, debugToolpath: false,
    target: { source: 'features', featureIds }, toolRef: 't1', stepdown: 2, stepover: 0.4, feed: 600,
    plungeFeed: 180, rpm: 12000, pocketPattern: 'offset', pocketAngle: 0, stockToLeaveRadial: 0,
    stockToLeaveAxial: 0, finishWalls: true, finishFloor: true, carveDepth: 1, maxCarveDepth: 1,
    entryStrategy: 'plunge', ...over,
  }
}

function buildProject(input: {
  stock: Stock
  drafts: Draft[]
  operations: Operation[]
  tools: Tool[]
  clamps?: Clamp[]
  setups?: MachiningSetup[]
}): Project {
  const base = newProject('review', 'mm')
  base.stock = input.stock
  // This review is of Around work, which exists only in a rotary project (issue #1028).
  base.meta.projectType = 'rotary'
  base.tools = input.tools
  const built = projectWithFeatures(base, input.drafts.map(draftFeature))
  const setups = input.setups ?? built.setups
  return {
    ...built,
    features: built.features.map((feature) => {
      const draft = input.drafts.find((entry) => entry.id === feature.id)
      return draft?.authoringFace ? { ...feature, authoringFace: draft.authoringFace } : feature
    }),
    clamps: input.clamps ?? [],
    setups,
    activeSetupId: setups[0].id,
    operations: input.operations,
  }
}

function warningCodes(result: ToolpathResult): string[] {
  return result.warnings.map((warning) => warning.code)
}

// ── 1. a fixture band covers every turn the job can reach ─────

console.log('Testing a fixture band across every reachable turn...')

{
  const TAILSTOCK: Clamp = {
    id: 'tail', name: 'Tailstock', type: 'tailstock', x: 150, y: 20, w: 20, h: 60, height: 42, visible: true,
  }

  /** The same Engrave over the tailstock, at a chosen across coordinate. */
  function engraveAcross(across: number): { result: ToolpathResult; warnings: string } {
    const project = buildProject({
      stock: BAR,
      drafts: [{
        id: 'line', kind: 'polygon', profile: line({ x: 155, y: across }, { x: 165, y: across }),
        operation: 'line', zTop: 40, zBottom: 39, authoringFace: 'around',
      }],
      operations: [operation('Engrave', 'follow_line', ['line'], { pass: 'finish', carveDepth: 1, maxCarveDepth: 1 })],
      tools: [tool('t1', 'flat_endmill', 3)],
      clamps: [TAILSTOCK],
      setups: [aroundSetup('x')],
    })
    const envelope = computeOperationToolpath(project, project.operations[0])
    assert.ok(envelope, 'the engrave generates an envelope')
    return { result: envelope.result, warnings: JSON.stringify(envelope.result.warnings) }
  }

  // The sheet's own first turn, one turn above it and one turn below it: the
  // same physical place on the bar, so the same tailstock blocks all three.
  const inside = engraveAcross(SHEET_START + 15)
  const above = engraveAcross(SHEET_START + CIRCUMFERENCE + 15)
  const below = engraveAcross(SHEET_START - CIRCUMFERENCE + 15)

  assert.notEqual(inside.warnings, '[]', 'the inside engraving really is blocked by the tailstock')
  assert.equal(above.warnings, inside.warnings, 'one turn above the first circumference is kept out exactly as inside it')
  assert.equal(below.warnings, inside.warnings, 'one turn below the first circumference is kept out exactly as inside it')
  assert.deepEqual(
    [inside.result.moves.length, above.result.moves.length, below.result.moves.length],
    [0, 0, 0],
    'and none of the three emits motion over the tailstock',
  )

  // A control: the same engraving beside the tailstock, along the bar, cuts.
  const beside = (() => {
    const project = buildProject({
      stock: BAR,
      drafts: [{
        id: 'line', kind: 'polygon', profile: line({ x: 60, y: SHEET_START + CIRCUMFERENCE + 15 }, { x: 70, y: SHEET_START + CIRCUMFERENCE + 15 }),
        operation: 'line', zTop: 40, zBottom: 39, authoringFace: 'around',
      }],
      operations: [operation('Engrave', 'follow_line', ['line'], { pass: 'finish', carveDepth: 1, maxCarveDepth: 1 })],
      tools: [tool('t1', 'flat_endmill', 3)],
      clamps: [TAILSTOCK],
      setups: [aroundSetup('x')],
    })
    return computeOperationToolpath(project, project.operations[0])!.result
  })()
  assert.ok(beside.moves.length > 0, 'the case is not vacuous: the same engraving beside the tailstock cuts')
}

// ── 2. a cut the operation works out itself can reach the centreline ──

console.log('Testing the centreline refusal for a depth the operation works out...')

{
  const engrave = (carveDepth: number, zBottom: number): ToolpathResult => {
    const project = buildProject({
      stock: BAR,
      drafts: [{
        id: 'line', kind: 'polygon', profile: line({ x: 55, y: 45 }, { x: 75, y: 55 }),
        operation: 'line', zTop: 40, zBottom, authoringFace: 'around',
      }],
      operations: [operation('Engrave', 'follow_line', ['line'], { pass: 'finish', carveDepth, maxCarveDepth: carveDepth })],
      tools: [tool('t1', 'flat_endmill', 3)],
      setups: [aroundSetup('x')],
    })
    return computeOperationToolpath(project, project.operations[0])!.result
  }

  // The line is stored 5 deep (surface-relative), but carveDepth 20 on a 40 mm
  // bar reaches the centreline the operation computed for itself.
  const deep = engrave(20, 35)
  assert.deepEqual(deep.moves, [], 'a carve depth reaching the centreline emits no motion')
  assert.deepEqual(deep.warnings, [
    { code: 'aroundCutReachesCentreline', params: { operation: 'Engrave' } },
  ], 'and says so once, naming the operation')
  assert.equal(deep.bounds, null, 'with no bounds')

  const shallower = engrave(19, 35)
  assert.ok(shallower.moves.length > 0, 'the same engrave one step shallower generates')
  assert.ok(!warningCodes(shallower).includes('aroundCutReachesCentreline'), 'and is not refused')

  // The refusal also reaches the traced raw path: nothing is handed back.
  const traced = (() => {
    const project = buildProject({
      stock: BAR,
      drafts: [{
        id: 'line', kind: 'polygon', profile: line({ x: 55, y: 45 }, { x: 75, y: 55 }),
        operation: 'line', zTop: 40, zBottom: 35, authoringFace: 'around',
      }],
      operations: [operation('Engrave', 'follow_line', ['line'], { pass: 'finish', carveDepth: 20, maxCarveDepth: 20 })],
      tools: [tool('t1', 'flat_endmill', 3)],
      setups: [aroundSetup('x')],
    })
    return computeOperationToolpath(project, project.operations[0], { trace: true })!
  })()
  assert.equal(traced.raw, null, 'a refused operation has no raw path either')

  // The stored-bottom refusal still fires first, with its own message: a
  // target whose stored span already reaches the centreline never reaches the
  // generated-motion check.
  const stored = engrave(20, 20)
  assert.deepEqual(stored.warnings, [
    { code: 'aroundCentreline', params: { operation: 'Engrave', feature: 'line' } },
  ], 'the stored-bottom refusal keeps its own message and wins')
  assert.deepEqual(stored.moves, [], 'and still emits no motion')
}

{
  // A 90° countersink with a 12 mm mouth plunges 6 mm below the surface of a
  // 10 mm bar: past its centreline, although the circle is stored 2 deep.
  const SMALL_BAR = roundStock(10, 60, 'x', { x: 0, y: 0 })
  const countersink = (mouthDiameter: number): ToolpathResult => {
    const project = buildProject({
      stock: SMALL_BAR,
      drafts: [{
        id: 'hole', kind: 'circle', profile: circleProfile(30, 5, 1),
        operation: 'subtract', zTop: 10, zBottom: 8, authoringFace: 'around',
      }],
      operations: [operation('Countersink', 'drilling', ['hole'], { drillType: 'countersink', countersinkDiameter: mouthDiameter })],
      tools: [tool('t1', 'v_bit', 12, { vBitAngle: 90, maxCutDepth: 6 })],
      setups: [aroundSetup('x')],
    })
    return computeOperationToolpath(project, project.operations[0])!.result
  }

  const deep = countersink(12)
  assert.deepEqual(deep.warnings, [
    { code: 'aroundCutReachesCentreline', params: { operation: 'Countersink' } },
  ], 'a countersink whose derived plunge passes the centreline is refused')
  assert.deepEqual(deep.moves, [], 'with no motion')

  const shallower = countersink(8)
  assert.ok(shallower.moves.length > 0, 'a countersink that stops short of the centreline generates')
  assert.ok(!warningCodes(shallower).includes('aroundCutReachesCentreline'), 'and is not refused')
}

// ── 3. a flat face and Around exchange nothing ────────────────

console.log('Testing that a flat operation never sees an Around feature...')

{
  const FLAT_STOCK: Stock = {
    profile: rectProfile(0, 0, 120, 120), thickness: 20, material: 'aluminum_6061', color: '#888',
    visible: true, origin: { x: 0, y: 0 },
  }
  const topSetup: MachiningSetup = {
    id: 'top', name: 'Top', orientation: { axis: 'x', angleDeg: 0 }, indexing: 'manual',
    registration: [], notes: '', operationIds: [],
  }
  const projectWith = (aroundDrafts: Draft[]): Project => buildProject({
    stock: FLAT_STOCK,
    drafts: [
      { id: 'pocket-shape', profile: rectProfile(20, 20, 60, 60), operation: 'subtract', zTop: 20, zBottom: 10, authoringFace: 'top' },
      ...aroundDrafts,
    ],
    operations: [{ ...operation('Top pocket', 'pocket', ['pocket-shape']), setupId: 'top' }],
    tools: [tool('t1', 'flat_endmill', 3)],
    setups: [topSetup],
  })

  // An Around subtract and an Around add sit inside the Top pocket's own
  // region: without the flat-face filter they would be folded into its islands
  // and voids.
  const aroundDrafts: Draft[] = [
    {
      id: 'around-cut', profile: rectProfile(30, 30, 15, 15), operation: 'subtract',
      zTop: 20, zBottom: 5, authoringFace: 'around',
    },
    {
      id: 'around-add', profile: rectProfile(55, 40, 10, 10), operation: 'add',
      zTop: 20, zBottom: 0, authoringFace: 'around',
    },
  ]

  const clean = projectWith([])
  const contaminated = projectWith(aroundDrafts)
  const cleanPath = computeOperationToolpath(clean, clean.operations[0], { trace: true })!
  const dirtyPath = computeOperationToolpath(contaminated, contaminated.operations[0], { trace: true })!
  assert.notEqual(cleanPath.result.moves.length, 0, 'the fixture pocket generates motion')
  assert.deepEqual(dirtyPath.result, cleanPath.result, "an Around subtract and add leave a Top pocket's toolpath identical")
  assert.deepEqual(dirtyPath.raw, cleanPath.raw, 'and its raw path too')

  // The exported program is the same as well.
  const definition = validateMachineDefinition(structuredClone(BUNDLED_DEFINITIONS.find((entry) => entry.id === 'grbl')!))
  const program = (project: Project): string => runPostProcessor({
    project,
    definition,
    operations: [{
      operation: project.operations[0],
      tool: normalizeToolForProject(project.tools[0], project),
      toolpath: computeOperationToolpath(project, project.operations[0])!.result,
    }],
    options: { emitToolChanges: false, emitCoolant: false, programName: 'review' },
  }).gcode
  assert.equal(program(contaminated), program(clean), "an Around feature cannot change a Top program's G-code")

  // The helper returns the input object itself when there is no Around feature.
  assert.equal(flatFaceProject(clean), clean, 'no Around feature: the project passes through')
  assert.notEqual(flatFaceProject(contaminated), contaminated, 'an Around feature: the project is copied without it')
  assert.deepEqual(flatFaceProject(contaminated).features.map((feature) => feature.id), ['pocket-shape'], 'and only the flat features remain')
}

console.log('aroundReview: all assertions passed')
