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
 * G-code conformance corpus (issue #450).
 *
 * Defines the export cases fed to real controller interpreters. Each case is
 * generated from the current exporter rather than committed as a fixture, so
 * the corpus always describes what we emit today.
 *
 * Move sets are hand-built rather than produced by toolpath generation: this
 * corpus tests the *export* stage, and hand-built geometry keeps each case
 * deterministic and pinned to the failure mode it is meant to cover.
 *
 * The trochoidal cases are the deliberate exception (issue #448). That strategy
 * emits thousands of small-radius orbits per level, and the interaction that
 * matters — whether a controller accepts the arcs fitted to *that* sampling —
 * cannot be reproduced by hand-picked chords without simply re-implementing the
 * sampler. It is generated from the real toolpath, which is still deterministic:
 * the sampler is pure and takes no clock or randomness.
 *
 * The corner-relief cases (issue #203) are generated for the same reason. A
 * relief excursion is an *exactly antiparallel* out-and-back, repeated once per
 * level and bracketed by a pure-Z plunge — a reversal is the run shape an arc
 * fitter can degenerate on, and the surrounding motion is what decides whether
 * the fitter sees the reversal at all. Hand-picking those points would be
 * asserting the emitted shape rather than exporting it.
 *
 * The Bottom-setup cases (issue #946) export an operation that belongs to a
 * setup which turns the stock over. Two things only a real interpreter can
 * settle ride on them: the setup header is written as comments in each
 * dialect's own syntax, with operator notes that are free text; and a Bottom
 * toolpath reaches the exporter through two half turns — into stock space
 * when it is generated, back out when it is exported — so every coordinate has
 * been through `2·pivot − value` twice. That round trip is exact only up to
 * floating-point rounding, and GRBL's arc tolerance is the tightest we know.
 * The hand-built Bottom cases take the same path a generated one does
 * (`toolpathInStockFrame`), and one case is generated end to end.
 *
 * The Around cases (issue #395) are generated end to end for the same reason:
 * a wrapped toolpath is not something a hand-built move set can imitate. It is
 * produced on the unrolled sheet and carried onto the bar by `wrapToolpath`,
 * so every point carries an angle and the tool sits over the centreline. The
 * cases check what only a real interpreter can settle for a wrapped program:
 * the Around header as comments, an angle word per change (under `A` on an own
 * axis, under the borrowed motor's letter otherwise), `G93`/`G94` around each
 * turning cut with its own inverse-time `F`, and the last toolpath angle kept
 * at the end (#1091: no closing unwind).
 */

import { newProject, defaultTool, getStockBounds, rectProfile, roundStock } from '../../src/types/project'
import type { MachiningSetup, Operation, Project, SetupOrientation, SketchFeature } from '../../src/types/project'
import type { Units } from '../../src/utils/units'
import { projectWithFeatures, withBottomSetup } from '../../src/test/projectFixtures'
import { rotaryOperationFixture } from '../../src/test/rotaryOperationFixture'
import { exportPlasma, PLASMA_EXPORT_SCENARIOS } from '../../src/test/plasmaExportFixtures'
import { syncProjectSetups } from '../../src/store/helpers/setups'
import { toolpathInStockFrame } from '../../src/engine/setupFrameProject'
import { setupFrame } from '../../src/engine/setupOrientation'
import { computeOperationToolpath } from '../../src/engine/toolpaths/generateOperation'
import { generateEdgeRouteToolpath } from '../../src/engine/toolpaths/edge'
import { generatePocketToolpath } from '../../src/engine/toolpaths/pocket'
import { normalizeToolForProject } from '../../src/engine/toolpaths/geometry'
import { runPostProcessor } from '../../src/engine/gcode/postprocessor'
import { BUNDLED_DEFINITIONS } from '../../src/engine/gcode/definitions'
import type { MachineDefinition } from '../../src/engine/gcode/types'
import type { DrillCycle, ToolpathMove, ToolpathPoint, ToolpathResult } from '../../src/engine/toolpaths/types'

export interface CorpusCase {
  /** File-safe identifier; uses the machine definition extension. */
  name: string
  /** Why this case exists — printed alongside failures. */
  covers: string
  units: Units
  /** Bundled machine definition id. */
  machineId: string
  /** Tweaks applied to the bundled definition — e.g. selecting the R arc
   *  dialect, which no bundled machine uses but users can configure. */
  definitionOverrides?: (base: MachineDefinition) => MachineDefinition
  moves: ToolpathMove[]
  operationOverrides?: Partial<Operation>
  /** SBP corpus also exercises two real tool numbers and macro syntax. */
  emitToolChanges?: boolean
  secondTool?: boolean
  drillCycles?: DrillCycle[]
  /**
   * Export the operation from a Bottom setup (issue #946). `moves` are then
   * the path as the machine runs it in that setup; they are carried into
   * stock space the way generation does, and the exporter turns them back.
   */
  bottomSetup?: BottomSetupCase
  /**
   * Build the whole export input instead of using `moves` — for a case whose
   * point is the real generated toolpath of a real project.
   */
  generated?: () => { project: Project; operation: Operation; toolpath: ToolpathResult }
  /**
   * Validator ids this case is fed to, when they are not all the validators
   * that claim its machine (issue #393). Absent means every claiming validator,
   * exactly as before the field existed. A restricted case still runs only
   * where the validator claims its machine.
   */
  validators?: readonly string[]
}

/**
 * Whether a case runs on a validator (issue #393).
 *
 * The machine claim always applies: a validator that cannot parse the dialect
 * would report a syntax error that says nothing about the case. On top of it,
 * a case with no `validators` list runs everywhere its machine is claimed —
 * the behaviour every pre-#393 case must keep — while a case that names ids
 * runs only on those. The own-axis `A` program uses the list to stay away from
 * Grbl, which rejects the `A` word outright.
 */
export function caseRunsOnValidator(
  entry: Pick<CorpusCase, 'machineId' | 'validators'>,
  validatorName: string,
  validatorMachines: readonly string[],
): boolean {
  if (!validatorMachines.includes(entry.machineId)) return false
  return entry.validators === undefined || entry.validators.includes(validatorName)
}

export interface BottomSetupCase {
  /** Stock axis the part is flipped about. */
  axis: SetupOrientation['axis']
  /** Operator notes for the setup header. Free text: whatever a user types. */
  notes?: string
  /**
   * Where the shared origin sits on the face that is up: `'centre'` puts it
   * on the flip centreline, where it stays put when the part is turned;
   * the default is the front-left corner, which lands on a different stock
   * corner after the flip.
   */
  origin?: 'frontLeft' | 'centre' | 'offCentre'
}

function pt(x: number, y: number, z = -1): ToolpathPoint {
  return { x, y, z }
}

/** A project point carrying the stock's angle (issue #393). */
function rotaryPt(x: number, y: number, z: number, a: number): ToolpathPoint {
  return { x, y, z, a }
}

/** Lead in from safe Z, then cut the given polyline. */
function leadInAndCut(points: ToolpathPoint[]): ToolpathMove[] {
  const moves: ToolpathMove[] = [
    { kind: 'rapid', from: pt(0, 0, 5), to: { ...points[0], z: 5 } },
    { kind: 'plunge', from: { ...points[0], z: 5 }, to: { ...points[0] } },
  ]
  for (let i = 0; i < points.length - 1; i++) {
    moves.push({ kind: 'cut', from: { ...points[i] }, to: { ...points[i + 1] } })
  }
  return moves
}

/** `count` chords sampling an arc of `sweepDeg` starting at `startDeg`. */
function arcChords(
  radius: number, startDeg: number, sweepDeg: number, count: number,
  cx = 0, cy = 0, z = -1,
): ToolpathPoint[] {
  const points: ToolpathPoint[] = []
  for (let i = 0; i <= count; i++) {
    const angle = ((startDeg + (sweepDeg * i) / count) * Math.PI) / 180
    points.push(pt(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle), z))
  }
  return points
}

/**
 * The span from issue #447: 14 contiguous cut moves whose fitted arcs GRBL
 * rejected with error 33 before the endpoint-continuity fix.
 */
function issue447Points(): ToolpathPoint[] {
  const xy: Array<[number, number]> = [
    [122.3941767939508, 167.17278330912177],
    [122.37556680190744, 167.10332987328752],
    [122.36930000002496, 167.0317],
    [122.36677898139465, 166.96007012671248],
    [122.37660115292522, 166.89061669087823],
    [122.3982010594255, 166.82545000000005],
    [122.43065538518721, 166.76655011100434],
    [122.4727110084653, 166.71570666721345],
    [122.52282307694827, 166.67446452093895],
    [122.57920194731366, 166.6440767939257],
    [122.63986756263506, 166.62546680188257],
    [122.7027096154099, 166.6192000000001],
    [122.76555166818474, 166.62546680188257],
    [122.82621728350614, 166.6440767939257],
    [122.88259615387153, 166.67446452093895],
  ]
  return xy.map(([x, y]) => pt(x, y))
}

/** Same geometry expressed in inches, for the 4-decimal output path. */
function issue447PointsInch(): ToolpathPoint[] {
  return issue447Points().map((p) => pt(p.x / 25.4, p.y / 25.4, p.z / 25.4))
}

/** Concentric arc passes, as a pocket produces. */
function concentricPasses(): ToolpathMove[] {
  const moves: ToolpathMove[] = []
  for (const radius of [20, 16, 12, 8]) {
    const ring = arcChords(radius, 0, 360, 32)
    moves.push({ kind: 'rapid', from: pt(0, 0, 5), to: { ...ring[0], z: 5 } })
    moves.push({ kind: 'plunge', from: { ...ring[0], z: 5 }, to: { ...ring[0] } })
    for (let i = 0; i < ring.length - 1; i++) {
      moves.push({ kind: 'cut', from: { ...ring[i] }, to: { ...ring[i + 1] } })
    }
  }
  return moves
}

/** A partial arc entered and left by straight cuts. */
function arcWithStraightLeads(): ToolpathMove[] {
  const arc = arcChords(15, 0, 120, 12)
  return leadInAndCut([
    pt(30, -10),
    pt(arc[0].x, arc[0].y),
    ...arc.slice(1),
    pt(arc[arc.length - 1].x - 12, arc[arc.length - 1].y + 6),
  ])
}

/**
 * Real trochoidal roughing motion around a 20 mm square (issue #448).
 *
 * Generated rather than hand-built: the point is the arcs the fitter derives
 * from this sampler's own chord spacing and seam closure, which hand-picked
 * chords cannot stand in for. Memoised because three corpus cases share it.
 */
let cachedTrochoidalMoves: ToolpathMove[] | null = null
function trochoidalEdgeMoves(): ToolpathMove[] {
  if (cachedTrochoidalMoves) return cachedTrochoidalMoves

  const size = 20
  const tool = { ...defaultTool('mm', 1), id: 't1', name: 'em6', diameter: 6, defaultStepdown: 2 }
  const target: SketchFeature = {
    id: 'target',
    name: 'target',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, size, size),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: 0,
    z_bottom: -2,
    visible: true,
    locked: false,
  }
  const project = projectWithFeatures(
    { ...newProject('Conformance trochoidal', 'mm'), tools: [tool] },
    [target] as never,
  )
  const operation: Operation = {
    id: 'op1',
    name: 'Trochoidal',
    kind: 'edge_route_outside',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['target'] },
    toolRef: 't1',
    stepdown: 2,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    roundOutsideCorners: false,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth: 1,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
    edgeStrategy: 'trochoidal',
    trochoidalCutWidth: 9,
    trochoidalAdvance: 0.1,
    entryStrategy: 'helix',
    entryRampAngle: 5,
  }

  const result = generateEdgeRouteToolpath(project, operation)
  if (result.moves.length === 0) {
    throw new Error(
      `trochoidal corpus fixture generated no motion: [${result.warnings.map((w) => w.code).join(', ')}]`,
    )
  }
  cachedTrochoidalMoves = result.moves
  return cachedTrochoidalMoves
}

/**
 * A pocket with corner relief on, generated from the real toolpath.
 *
 * Deliberately a pocket rather than an edge route: the relief pass is appended
 * after a main path full of fitted offset rings, so the export sees the
 * reversals in the company of arcs the fitter is already working on. Two levels,
 * so the plunge-between-levels pattern appears too. Memoised because the arcs-on
 * and arcs-off cases share it.
 */
let cachedCornerReliefMoves: ToolpathMove[] | null = null
function cornerReliefMoves(): ToolpathMove[] {
  if (cachedCornerReliefMoves) return cachedCornerReliefMoves

  const tool = { ...defaultTool('mm', 1), id: 't1', name: 'em6', diameter: 6, defaultStepdown: 2 }
  const target: SketchFeature = {
    id: 'target',
    name: 'target',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 40, 26),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: 0,
    z_bottom: -4,
    visible: true,
    locked: false,
  }
  const project = projectWithFeatures(
    { ...newProject('Conformance corner relief', 'mm'), tools: [tool] },
    [target] as never,
  )
  const operation: Operation = {
    id: 'op1',
    name: 'Corner relief',
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['target'] },
    toolRef: 't1',
    stepdown: 2,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    roundOutsideCorners: false,
    cornerRelief: 'dogbone',
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth: 1,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
  }

  const result = generatePocketToolpath(project, operation)
  if (result.moves.length === 0) {
    throw new Error(
      `corner relief corpus fixture generated no motion: [${result.warnings.map((w) => w.code).join(', ')}]`,
    )
  }
  const plain = generatePocketToolpath(project, { ...operation, cornerRelief: 'none' })
  if (result.moves.length <= plain.moves.length) {
    throw new Error('corner relief corpus fixture emitted no relief pass — the case would prove nothing')
  }
  cachedCornerReliefMoves = result.moves
  return cachedCornerReliefMoves
}

/** Expanded two-peck drill motion, including a retract between pecks. */
function drillMoves(units: Units): ToolpathMove[] {
  const scale = units === 'mm' ? 1 : 1 / 25.4
  const at = (z: number) => pt(10 * scale, 12 * scale, z * scale)
  return [
    { kind: 'rapid', from: pt(0, 0, 5 * scale), to: at(5) },
    { kind: 'plunge', from: at(5), to: at(-2) },
    { kind: 'rapid', from: at(-2), to: at(1) },
    { kind: 'plunge', from: at(1), to: at(-4) },
    { kind: 'rapid', from: at(-4), to: at(5) },
  ]
}

/** Notes a user could plausibly type, chosen to stress comment syntax. */
const AWKWARD_NOTES = 'Flip toward you (long edge first); seat on the dowels.\nClamp at X=10 / Y=20 - 50% torque, "snug" not tight'

let cachedBottomPocket: { project: Project; operation: Operation; toolpath: ToolpathResult } | null = null

/**
 * A pocket drawn on the bottom face, generated and exported from a Bottom
 * setup — the whole path a user's Bottom operation takes, with nothing
 * hand-built. The slot has round ends so the rings carry fitted arcs.
 */
function generatedBottomPocket(): { project: Project; operation: Operation; toolpath: ToolpathResult } {
  if (cachedBottomPocket) return cachedBottomPocket
  const base = newProject('Conformance bottom pocket', 'mm')
  base.stock = { ...base.stock, profile: rectProfile(0, 0, 120, 80), thickness: 18 }
  base.origin = { name: 'Origin', x: 0, y: 80, z: 18, visible: true }
  base.tools = [{ ...defaultTool('mm', 1), id: 't1', name: 'Conformance Tool', diameter: 6, maxCutDepth: 20 }]
  const slot: SketchFeature = {
    id: 'slot',
    name: 'slot',
    kind: 'composite',
    folderId: null,
    sketch: {
      profile: {
        start: { x: 30, y: 20 },
        segments: [
          { type: 'line', to: { x: 80, y: 20 } },
          { type: 'arc', to: { x: 80, y: 44 }, center: { x: 80, y: 32 }, clockwise: true },
          { type: 'line', to: { x: 30, y: 44 } },
          { type: 'arc', to: { x: 30, y: 20 }, center: { x: 30, y: 32 }, clockwise: true },
        ],
        closed: true,
      },
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    // 5 deep from the bottom face.
    z_top: 5,
    z_bottom: 0,
    authoringFace: 'bottom',
    visible: true,
    locked: false,
  }
  const { operation: template } = buildOperation(base, {
    target: { source: 'features', featureIds: ['slot'] },
    stepdown: 2.5,
    stepover: 0.4,
  })
  const project = withBottomSetup(
    syncProjectSetups({ ...projectWithFeatures(base, [slot]), operations: [template] }),
    {
      axis: 'x',
      operationIds: [template.id],
      setup: {
        notes: AWKWARD_NOTES,
        registration: [{ id: 'r1', kind: 'dowel', target: { type: 'point', point: { x: 100.5, y: 40.25 } } }],
      },
    },
  )
  const operation = project.operations[0]
  const envelope = computeOperationToolpath(project, operation)
  if (!envelope || envelope.result.moves.length === 0 || envelope.result.warnings.length > 0) {
    throw new Error(`bottom pocket corpus fixture did not generate cleanly: ${JSON.stringify(envelope?.result.warnings)}`)
  }
  // The point of the case: the stored path is under the stock, and it cuts.
  if (!envelope.result.bounds || envelope.result.bounds.minZ >= 0 || envelope.result.bounds.maxZ > 5 + 1e-9) {
    throw new Error('bottom pocket corpus fixture is not a Bottom toolpath in stock space — the case would prove nothing')
  }
  cachedBottomPocket = { project, operation, toolpath: envelope.result }
  return cachedBottomPocket
}

/**
 * A real #957 plasma toolpath over the QtPlasmaC reference shapes, exported to
 * the Grbl plasma machine (#983). Generated from the current exporter, so the
 * corpus describes what the G-code pierce path emits today.
 */
function generatedPlasma(
  name: keyof typeof PLASMA_EXPORT_SCENARIOS,
): () => { project: Project; operation: Operation; toolpath: ToolpathResult } {
  return () => {
    const { input } = exportPlasma({ ...PLASMA_EXPORT_SCENARIOS[name](), machineId: 'grbl-plasma' })
    const first = input.operations[0]
    return { project: input.project, operation: first.operation, toolpath: first.toolpath }
  }
}

/**
 * A hand-built turning toolpath on a round bar (issue #393), lying along
 * `axis`. The moves never change the across coordinate, so on a borrowed-motor
 * machine the operation is allowed: the motor that would drive that axis turns
 * the bar instead, the angle is written under its letter, and no linear word is
 * ever emitted for it. On an own-axis machine the angle is written under `A`.
 *
 * Since #1153 every rotary case runs on a bundled rotary machine, and those
 * follow the bar, so the same toolpath posts for a bar along X and one along Y
 * without a machine override. A borrowed-motor case runs on every validator
 * that claims its machine; an own-axis case writes `A`, which plain Grbl
 * rejects, so it carries a `validators` list. See the README's case table.
 */
function generatedRotaryTurning(
  axis: 'x' | 'y',
  title: string,
): () => { project: Project; operation: Operation; toolpath: ToolpathResult } {
  return () => {
    const project = newProject(title, 'mm')
    // The bar is a rotary project (issue #1028): the type is stored explicitly
    // now that `newProject` defaults to milling.
    project.meta.projectType = 'rotary'
    project.stock = roundStock(20, 100, axis)
    // The bar's centreline: across the bar at the stock centre, at Z = thickness/2.
    project.origin = axis === 'x'
      ? { name: 'Origin', x: 0, y: 10, z: 20, visible: true }
      : { name: 'Origin', x: 10, y: 0, z: 20, visible: true }
    const { operation } = buildOperation(project)
    // `along` runs down the bar; the across coordinate stays on the centreline.
    const at = (along: number, z: number, a: number): ToolpathPoint =>
      axis === 'x' ? rotaryPt(along, 10, z, a) : rotaryPt(10, along, z, a)
    const moves: ToolpathMove[] = [
      { kind: 'rapid', from: at(0, 30, 0), to: at(20, 30, 0) },
      { kind: 'plunge', from: at(20, 30, 0), to: at(20, 20, 0) },
      { kind: 'cut', from: at(20, 20, 0), to: at(40, 20, 90) },
      { kind: 'cut', from: at(40, 20, 90), to: at(50, 20, 90) },
    ]
    return {
      project,
      operation,
      toolpath: { operationId: operation.id, warnings: [], bounds: null, moves },
    }
  }
}

/** An Around setup on a round bar lying along `axis`, with no registration (a chuck locates it). */
function aroundSetup(axis: 'x' | 'y' = 'x'): MachiningSetup {
  return {
    id: 'around',
    name: 'Around',
    kind: 'around',
    orientation: { axis, angleDeg: 0 },
    indexing: 'manual',
    registration: [],
    notes: '',
    operationIds: [],
  }
}

/**
 * Build a real Around project (issue #395) and generate its one operation
 * through the seam, so the case exports a wrapped toolpath rather than a
 * hand-built one. `stock` is always a round bar along X, 20 mm across.
 */
function generatedAround(
  feature: SketchFeature,
  operation: Operation,
  tool: ReturnType<typeof defaultTool>,
  axis: 'x' | 'y' = 'x',
): { project: Project; operation: Operation; toolpath: ToolpathResult } {
  const base = newProject('Conformance around', 'mm')
  // A wrapped toolpath is Around work, which exists only in a rotary project
  // (issue #1028): the type is stored explicitly now that `newProject` defaults
  // to milling. Without it the generation gate refuses the Around face with
  // `aroundStockMismatch` and the case proves nothing.
  base.meta.projectType = 'rotary'
  base.stock = roundStock(20, 100, axis)
  // The bar's centreline: across the bar at the stock centre, at Z = thickness/2.
  base.origin = axis === 'x'
    ? { name: 'Origin', x: 0, y: 10, z: 20, visible: true }
    : { name: 'Origin', x: 10, y: 0, z: 20, visible: true }
  base.tools = [tool]
  // The unrolled sheet keeps the along-bar coordinate on the bar's own axis, so
  // a bar along Y draws the same feature with X and Y exchanged (#1153).
  const built = projectWithFeatures(base, [axis === 'x' ? feature : swapFeatureAxes(feature)])
  const project: Project = {
    ...built,
    features: built.features.map((row) => ({ ...row, authoringFace: 'around' as const })),
    setups: [aroundSetup(axis)],
    activeSetupId: 'around',
    operations: [operation],
  }
  const generated = project.operations[0]
  const envelope = computeOperationToolpath(project, generated)
  if (!envelope || envelope.result.moves.length === 0 || envelope.result.warnings.length > 0) {
    throw new Error(`around corpus fixture did not generate cleanly: ${JSON.stringify(envelope?.result.warnings)}`)
  }
  if (!envelope.result.moves.every((move) => move.from.a !== undefined && move.to.a !== undefined)) {
    throw new Error('around corpus fixture is not a wrapped toolpath — the case would prove nothing')
  }
  return { project, operation: generated, toolpath: envelope.result }
}

/**
 * The feature drawn with X and Y exchanged: the same Around sketch on a bar
 * along Y. Exchanging the axes mirrors the sketch, so an arc turns the other way.
 */
function swapFeatureAxes(feature: SketchFeature): SketchFeature {
  const swap = (point: { x: number; y: number }) => ({ x: point.y, y: point.x })
  const profile = feature.sketch.profile
  const segments = profile.segments.map((segment): (typeof profile.segments)[number] => {
    switch (segment.type) {
      case 'arc': return { ...segment, to: swap(segment.to), center: swap(segment.center), clockwise: !segment.clockwise }
      case 'bezier': return { ...segment, to: swap(segment.to), control1: swap(segment.control1), control2: swap(segment.control2) }
      default: return { ...segment, to: swap(segment.to) }
    }
  })
  return { ...feature, sketch: { ...feature.sketch, profile: { ...profile, start: swap(profile.start), segments } } }
}

function aroundFeature(id: string, kind: SketchFeature['kind'], profile: SketchFeature['sketch']['profile'], operation: SketchFeature['operation'], zTop: number, zBottom: number): SketchFeature {
  return {
    id,
    name: id,
    kind,
    folderId: null,
    sketch: { profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation,
    z_top: zTop,
    z_bottom: zBottom,
    authoringFace: 'around',
    visible: true,
    locked: false,
  }
}

function aroundOperation(kind: Operation['kind'], featureId: string, overrides: Partial<Operation> = {}): Operation {
  return {
    id: 'op1',
    name: 'Around op',
    kind,
    setupId: 'around',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: [featureId] },
    toolRef: 't1',
    stepdown: 2,
    stepover: 0.4,
    feed: 600,
    plungeFeed: 180,
    rpm: 12000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth: 1,
    entryStrategy: 'plunge',
    ...overrides,
  }
}

/**
 * A wrapped Engrave on a borrowed-Y rotary (issue #395). The operator's line
 * is a slanted straight cut, so the program must turn the bar while it travels
 * along it: `G93`, one inverse-time `F` on the turning block, the angle under
 * `Y` and never a linear `Y` word, ending on its last angle.
 */
function generatedAroundEngraveBorrowed(axis: 'x' | 'y'): { project: Project; operation: Operation; toolpath: ToolpathResult } {
  const feature = aroundFeature('line', 'polygon', {
    start: { x: 20, y: 13 },
    segments: [{ type: 'line', to: { x: 60, y: 21 } }],
    closed: false,
  }, 'line', 20, 19)
  return generatedAround(
    feature,
    aroundOperation('follow_line', 'line', { pass: 'finish', carveDepth: 1, maxCarveDepth: 1 }),
    { ...defaultTool('mm', 1), id: 't1', name: 'Conformance Tool', diameter: 3 },
    axis,
  )
}

/**
 * A wrapped pocket on an own-axis rotary (issue #395). A rectangle cleared in
 * rings: every ring turns the bar as it runs around it, so the program is
 * inverse time throughout, writes `A`, and keeps every across word on the
 * centreline.
 */
function generatedAroundPocketOwnAxis(axis: 'x' | 'y'): { project: Project; operation: Operation; toolpath: ToolpathResult } {
  const feature = aroundFeature('pocket', 'rect', rectProfile(40, 5, 20, 12), 'subtract', 20, 16)
  return generatedAround(
    feature,
    aroundOperation('pocket', 'pocket', { stepdown: 2, stepover: 0.4 }),
    { ...defaultTool('mm', 1), id: 't1', name: 'Conformance Tool', diameter: 3 },
    axis,
  )
}

/**
 * A real model-in-a-bar rotary toolpath (issue #1015). The finish and rough
 * generators' own output on the fixture's short bar, so the case exports the
 * program a rotary operation actually produces rather than a hand-built
 * turning path — the same reasoning as the Around cases above. The stepover is
 * widened so each program stays short enough to keep the corpus fast.
 */
function generatedRotaryModel(
  kind: 'rotary_rough' | 'rotary_finish',
  caseName: string,
  axis: 'x' | 'y' = 'x',
): () => { project: Project; operation: Operation; toolpath: ToolpathResult } {
  return () => {
    const fixture = rotaryOperationFixture(axis, kind)
    const operation: Operation = { ...fixture.operations[0], stepover: 1.5 }
    // A larger cutter than the fixture's: `sampleSpacing` and the angular pass
    // count both scale with the tool, so this keeps each program short.
    const project: Project = {
      ...fixture,
      tools: [{ ...fixture.tools[0], diameter: 6 }],
      operations: [operation],
    }
    const envelope = computeOperationToolpath(project, operation)
    // The finish case is a finish on its own by design, so the advisory
    // "no rough before this finish" note (#1045) is expected; any other
    // warning still fails the case.
    const warnings = (envelope?.result.warnings ?? []).filter((warning) =>
      !(kind === 'rotary_finish' && warning.code === 'rotaryFinishWithoutRough'))
    if (!envelope || envelope.result.moves.length === 0 || warnings.length > 0) {
      throw new Error(`${caseName} corpus fixture did not generate cleanly: ${JSON.stringify(envelope?.result.warnings)}`)
    }
    if (!envelope.result.moves.every((move) => move.from.a !== undefined && move.to.a !== undefined)) {
      throw new Error(`${caseName} corpus fixture is not a wrapped rotary toolpath — the case would prove nothing`)
    }
    return { project, operation, toolpath: envelope.result }
  }
}

/**
 * The rotary cases (issues #393, #395, #1015, #1153). Each runs on a bundled
 * rotary machine, which follows the bar, so every case is posted for a bar
 * along X and again for a bar along Y with no machine override:
 *
 * - the borrowed GRBL motor writes the angle under `Y` for a bar along X and
 *   under `X` for a bar along Y, and never that letter as a linear word; it
 *   runs on every validator that claims `grbl-rotary`;
 * - an own axis writes `A`, which plain Grbl rejects, so those cases name the
 *   LinuxCNC interpreter. grblHAL has no validator of its own; its dialect is
 *   read by the same interpreter, which proves syntax and `G93`, not grblHAL.
 * - Mach3, UCCNC and the GRBL fork with its own A have no interpreter that can
 *   read them (`%`/`O`/`N` line numbers, `A`), so they are exported and
 *   reported as not validated.
 *
 * The bar-along-X cases keep the names they had before #1153.
 */
const OWN_AXIS_VALIDATORS = ['linuxcnc-rs274'] as const

function rotaryCase(
  name: string,
  covers: string,
  machineId: string,
  generated: CorpusCase['generated'],
  validators?: readonly string[],
): CorpusCase {
  return { name, covers, units: 'mm', machineId, moves: [], generated, ...(validators ? { validators } : {}) }
}

const ROTARY_CASES: CorpusCase[] = [
  rotaryCase('rotary-borrowed-y-inverse-time',
    'issue #393 - a turning cut on the borrowed GRBL motor, bar along X: G93 before it, an '
      + 'inverse-time F word on the turning move, the angle written under Y and no linear Y word.',
    'grbl-rotary', generatedRotaryTurning('x', 'Conformance rotary borrowed Y')),
  rotaryCase('rotary-borrowed-x-bar-y-inverse-time',
    'issue #1153 - the same machine with the bar along Y: the X motor turns the bar, so the '
      + 'angle is written under X and no linear X word is.',
    'grbl-rotary', generatedRotaryTurning('y', 'Conformance rotary borrowed X')),
  rotaryCase('rotary-own-axis-inverse-time',
    'issue #393 - an own-axis program: the angle written under A, G93 before the turning move '
      + 'and an inverse-time F on it. Restricted to the LinuxCNC validator because plain Grbl '
      + 'rejects the A word, which is a dialect verdict, not an arc one.',
    'linuxcnc-rotary', generatedRotaryTurning('x', 'Conformance rotary own axis'), OWN_AXIS_VALIDATORS),
  rotaryCase('rotary-own-axis-bar-y-inverse-time',
    'issue #1153 - the same own-axis program with the bar along Y: still A, turning about Y.',
    'linuxcnc-rotary', generatedRotaryTurning('y', 'Conformance rotary own axis Y'), OWN_AXIS_VALIDATORS),
  rotaryCase('around-engrave-borrowed-y',
    'issue #395 - a wrapped Engrave on the borrowed motor, bar along X: the Around header, the '
      + 'angle written under Y once per change and never as a linear word, G93 with an '
      + 'inverse-time F on the turning cut, and the last angle kept at the end.',
    'grbl-rotary', () => generatedAroundEngraveBorrowed('x')),
  rotaryCase('around-engrave-borrowed-x-bar-y',
    'issue #1153 - the same wrapped Engrave on a bar along Y: the angle under X.',
    'grbl-rotary', () => generatedAroundEngraveBorrowed('y')),
  rotaryCase('around-pocket-own-axis',
    'issue #395 - a wrapped pocket on an own-axis rotary: every ring turns the bar, so the '
      + 'angle is written under A and the turning cuts run in inverse time.',
    'linuxcnc-rotary', () => generatedAroundPocketOwnAxis('x'), OWN_AXIS_VALIDATORS),
  rotaryCase('around-pocket-own-axis-bar-y',
    'issue #1153 - the same wrapped pocket on a bar along Y.',
    'linuxcnc-rotary', () => generatedAroundPocketOwnAxis('y'), OWN_AXIS_VALIDATORS),
  rotaryCase('rotary-model-finish-borrowed-y',
    'issue #1015 - a finish pass over an imported model inside a round bar on the borrowed '
      + 'motor: the Around header, the angle carried by the borrowed motor and never written as '
      + 'a linear Y, and inverse time around each turning link.',
    'grbl-rotary', generatedRotaryModel('rotary_finish', 'rotary-model-finish-borrowed-y')),
  rotaryCase('rotary-model-finish-borrowed-x-bar-y',
    'issue #1153 - the same model finish on a bar along Y: the angle carried by the X motor.',
    'grbl-rotary', generatedRotaryModel('rotary_finish', 'rotary-model-finish-borrowed-x-bar-y', 'y')),
  rotaryCase('rotary-model-rough-own-axis',
    'issue #1015 - a roughing pass over the same model on an own-axis rotary: the angle '
      + 'written under A over several layers.',
    'linuxcnc-rotary', generatedRotaryModel('rotary_rough', 'rotary-model-rough-own-axis'), OWN_AXIS_VALIDATORS),
  rotaryCase('rotary-model-rough-own-axis-bar-y',
    'issue #1153 - the same model rough on a bar along Y.',
    'linuxcnc-rotary', generatedRotaryModel('rotary_rough', 'rotary-model-rough-own-axis-bar-y', 'y'), OWN_AXIS_VALIDATORS),
  // The other bundled own-axis controllers (#1153), both bar axes.
  ...(['x', 'y'] as const).flatMap((axis): CorpusCase[] => {
    const suffix = axis === 'x' ? '' : '-bar-y'
    const bar = `bar along ${axis.toUpperCase()}`
    return [
      rotaryCase(`rotary-grblhal-own-axis${suffix}`,
        `issue #1153 - grblHAL + rotary A, ${bar}: A and G93, read by the LinuxCNC interpreter `
          + 'for syntax; no grblHAL validator exists.',
        'grblhal-rotary', generatedRotaryTurning(axis, `Conformance grblHAL rotary ${axis}`), OWN_AXIS_VALIDATORS),
      rotaryCase(`rotary-mach3-own-axis${suffix}`,
        `issue #1153 - Mach3 + rotary A, ${bar}. No interpreter here reads Mach3, so not validated.`,
        'mach3-rotary', generatedRotaryTurning(axis, `Conformance Mach3 rotary ${axis}`)),
      rotaryCase(`rotary-uccnc-own-axis${suffix}`,
        `issue #1153 - UCCNC + rotary A, ${bar}. No interpreter here reads UCCNC, so not validated.`,
        'uccnc-rotary', generatedRotaryTurning(axis, `Conformance UCCNC rotary ${axis}`)),
      rotaryCase(`rotary-grbl-fork-own-axis${suffix}`,
        `issue #1153 - GRBL 4-axis fork + rotary A, ${bar}. Plain Grbl rejects A, so not validated.`,
        'grbl-rotary-a', generatedRotaryTurning(axis, `Conformance Grbl fork rotary ${axis}`)),
    ]
  }),
]

export const CORPUS: CorpusCase[] = [
  {
    name: 'issue-447-small-radius-trochoidal',
    covers: 'the reported error-33 failure; ~0.3-0.5 mm fitted radii',
    units: 'mm',
    machineId: 'grbl',
    moves: leadInAndCut(issue447Points()),
  },
  {
    name: 'full-circle',
    covers: '360 deg run split into 4 x 90 deg, and the degenerate-bisector path',
    units: 'mm',
    machineId: 'grbl',
    moves: leadInAndCut(arcChords(10, 0, 360, 32)),
  },
  {
    name: 'arc-with-straight-leads',
    covers: 'fitted run boundaries adjacent to linear moves',
    units: 'mm',
    machineId: 'grbl',
    moves: arcWithStraightLeads(),
  },
  {
    name: 'ninety-degree-boundary',
    covers: 'sweeps landing exactly on the 90 deg split threshold',
    units: 'mm',
    machineId: 'grbl',
    moves: leadInAndCut(arcChords(25, 0, 90, 18)),
  },
  {
    name: 'just-over-ninety-degrees',
    covers: 'the ceil() epsilon in splitArc, just past the threshold',
    units: 'mm',
    machineId: 'grbl',
    moves: leadInAndCut(arcChords(25, 0, 91, 18)),
  },
  {
    name: 'inch-output',
    covers: 'inch at 4 dp - a coarser mm grid (0.00254) than mm at 3 dp (0.001)',
    units: 'inch',
    machineId: 'grbl',
    moves: leadInAndCut(issue447PointsInch()),
  },
  {
    name: 'r-format-arcs',
    covers: 'the R arc dialect and its rounding-repair path',
    units: 'mm',
    machineId: 'grbl',
    // No bundled machine uses R format, but the code path is reachable for
    // any user-authored definition, so the corpus must exercise it.
    definitionOverrides: (base) => ({
      ...base,
      motion: { ...base.motion, arcFormat: 'r' },
    }),
    moves: leadInAndCut(issue447Points()),
  },
  {
    name: 'grblhal-dialect',
    covers: 'grblHAL: grbl numerics with parenthesised comments',
    units: 'mm',
    machineId: 'grblhal',
    moves: leadInAndCut(issue447Points()),
  },
  {
    name: 'generic-trailing-zeros-stripped',
    covers: 'trailing-zero stripping, which rewrites every emitted arc word',
    units: 'mm',
    machineId: 'generic',
    moves: leadInAndCut(issue447Points()),
  },
  {
    name: 'mach3-dialect',
    covers: 'line numbers, program number and %% wrapper alongside fitted arcs',
    units: 'mm',
    machineId: 'mach3',
    moves: leadInAndCut(arcChords(10, 0, 360, 32)),
  },
  {
    name: 'linuxcnc-dialect',
    covers: 'a second I/J dialect with its own number format and header',
    units: 'mm',
    machineId: 'linuxcnc',
    moves: leadInAndCut(arcChords(10, 0, 360, 32)),
  },
  {
    name: 'pocket-many-arcs',
    covers: 'volume and modal state across many consecutive fitted runs',
    units: 'mm',
    machineId: 'grbl',
    moves: concentricPasses(),
  },
  {
    name: 'arc-fitting-disabled',
    covers: 'control case - pure G1 output must also be accepted',
    units: 'mm',
    machineId: 'grbl',
    moves: leadInAndCut(issue447Points()),
    operationOverrides: { arcFittingEnabled: false },
  },
  ...ROTARY_CASES,
  {
    name: 'trochoidal-edge-outside',
    covers: 'issue #448 - arcs fitted to real trochoidal orbit sampling; GRBL has '
      + 'the tightest measured arc tolerance, so it is the binding case',
    units: 'mm',
    machineId: 'grbl',
    moves: trochoidalEdgeMoves(),
  },
  {
    name: 'trochoidal-edge-outside-linuxcnc',
    covers: 'issue #448 - the same trochoidal output through a second arc dialect',
    units: 'mm',
    machineId: 'linuxcnc',
    moves: trochoidalEdgeMoves(),
  },
  {
    name: 'trochoidal-edge-outside-no-arcs',
    covers: 'issue #448 - the raw G1 fallback a controller without arc support receives',
    units: 'mm',
    machineId: 'grbl',
    moves: trochoidalEdgeMoves(),
    operationOverrides: { arcFittingEnabled: false },
  },
  {
    name: 'pocket-corner-relief',
    covers: 'issue #203 - exactly antiparallel relief excursions and their '
      + 'between-level plunges, among the fitted arcs of the pocket rings',
    units: 'mm',
    machineId: 'grbl',
    moves: cornerReliefMoves(),
  },
  {
    name: 'pocket-corner-relief-no-arcs',
    covers: 'issue #203 - the same relief motion as raw G1, for a controller without arcs',
    units: 'mm',
    machineId: 'grbl',
    moves: cornerReliefMoves(),
    operationOverrides: { arcFittingEnabled: false },
  },
  ...(['mm', 'inch'] as const).flatMap((units): CorpusCase[] => {
    const scale = units === 'mm' ? 1 : 1 / 25.4
    return [
      ...([90, -90] as const).map((sweep): CorpusCase => ({
        name: `sbp-${units}-${sweep > 0 ? 'cw' : 'ccw'}-arc`,
        covers: 'native CG arc syntax and direction, speeds, units guard, CRLF',
        units,
        machineId: 'shopbot',
        moves: leadInAndCut(arcChords(10 * scale, 0, sweep, 16, 0, 0, -scale)),
      })),
      {
        name: `sbp-${units}-tool-change`,
        covers: 'two tools: &Tool assignment, C9, TR, C6/C7 and speed restatement',
        units,
        machineId: 'shopbot',
        moves: leadInAndCut([pt(0, 0, -scale), pt(10 * scale, 10 * scale, -scale)]),
        emitToolChanges: true,
        secondTool: true,
      },
      {
        name: `sbp-${units}-drilling`,
        covers: 'drill cycles expand to MS/M3/JZ/J2 rather than canned G-code',
        units,
        machineId: 'shopbot',
        operationOverrides: { kind: 'drilling', drillType: 'peck', peckDepth: 2 * scale },
        moves: drillMoves(units),
        drillCycles: [{
          x: 10 * scale, y: 12 * scale, clearZ: 5 * scale,
          retractZ: scale, bottomZ: -4 * scale, drillType: 'peck', peckDepth: 2 * scale,
        }],
      },
    ]
  }),
  {
    name: 'bottom-setup-small-radius-arcs',
    covers: 'issue #946 - the #447 arcs after the Bottom round trip through stock space; '
      + 'GRBL has the tightest measured arc tolerance',
    units: 'mm',
    machineId: 'grbl',
    moves: leadInAndCut(issue447Points()),
    bottomSetup: { axis: 'x', notes: AWKWARD_NOTES },
  },
  {
    name: 'bottom-setup-full-circle-about-y',
    covers: 'issue #946 - a Bottom setup flipped about Y, origin on the flip centreline',
    units: 'mm',
    machineId: 'grbl',
    moves: leadInAndCut(arcChords(10, 0, 360, 32)),
    bottomSetup: { axis: 'y', origin: 'centre' },
  },
  {
    name: 'bottom-setup-off-centre-origin',
    covers: 'issue #946 - an off-centre origin: the touch-off line carries measurements, '
      + 'and machine coordinates go negative',
    units: 'mm',
    machineId: 'grbl',
    moves: concentricPasses(),
    bottomSetup: { axis: 'x', origin: 'offCentre' },
  },
  {
    name: 'bottom-setup-inch',
    covers: 'issue #946 - the Bottom round trip on the coarser inch grid',
    units: 'inch',
    machineId: 'grbl',
    moves: leadInAndCut(issue447PointsInch()),
    bottomSetup: { axis: 'x', notes: AWKWARD_NOTES },
  },
  {
    name: 'bottom-setup-linuxcnc',
    covers: 'issue #946 - the setup header and free-text notes as (parenthesised) comments',
    units: 'mm',
    machineId: 'linuxcnc',
    moves: leadInAndCut(arcChords(10, 0, 360, 32)),
    bottomSetup: { axis: 'x', notes: AWKWARD_NOTES },
  },
  {
    name: 'bottom-setup-grblhal',
    covers: 'issue #946 - the same header through grblHAL\'s parenthesised comments',
    units: 'mm',
    machineId: 'grblhal',
    moves: leadInAndCut(issue447Points()),
    bottomSetup: { axis: 'y', notes: AWKWARD_NOTES },
  },
  {
    name: 'bottom-setup-mach3',
    covers: 'issue #946 - the setup header under line numbers and the %% wrapper',
    units: 'mm',
    machineId: 'mach3',
    moves: leadInAndCut(arcChords(10, 0, 360, 32)),
    bottomSetup: { axis: 'x', notes: AWKWARD_NOTES },
  },
  {
    name: 'bottom-setup-generated-pocket',
    covers: 'issue #946 - a pocket drawn on the bottom face, generated through the setup '
      + 'transform and exported: mirrored coordinates, depth and safe-Z end to end',
    units: 'mm',
    machineId: 'grbl',
    moves: [],
    generated: generatedBottomPocket,
  },
  {
    name: 'bottom-setup-generated-pocket-linuxcnc',
    covers: 'issue #946 - the same generated Bottom pocket through a second arc dialect',
    units: 'mm',
    machineId: 'linuxcnc',
    moves: [],
    generated: generatedBottomPocket,
  },
  {
    name: 'bottom-setup-sbp',
    covers: 'issue #946 - the setup header and free-text notes as ShopBot part-file comments, '
      + 'and a Bottom program in the SBP dialect',
    units: 'mm',
    machineId: 'shopbot',
    moves: leadInAndCut(arcChords(10, 0, 360, 32)),
    bottomSetup: { axis: 'x', notes: AWKWARD_NOTES },
  },
  {
    name: 'bottom-setup-generated-pocket-sbp',
    covers: 'issue #946 - the generated Bottom pocket as a ShopBot part file',
    units: 'mm',
    machineId: 'shopbot',
    moves: [],
    generated: generatedBottomPocket,
  },
  {
    name: 'grbl-plasma-outline-mm',
    covers: 'issue #983 - a real plasma toolpath on the Grbl machine: probe, set zero, '
      + 'pierce, dwell and drop to cut height in millimetres',
    units: 'mm',
    machineId: 'grbl-plasma',
    moves: [],
    generated: generatedPlasma('single-outline'),
  },
  {
    name: 'grbl-plasma-outline-inch',
    covers: 'issue #983 - the millimetre touch-off converted to inch at emission, on the inch grid',
    units: 'inch',
    machineId: 'grbl-plasma',
    moves: [],
    generated: generatedPlasma('inch-output'),
  },
  {
    name: 'grbl-plasma-arc-leads',
    covers: 'issue #983 - arc lead-ins and lead-outs at cut height inside the torch pair',
    units: 'mm',
    machineId: 'grbl-plasma',
    moves: [],
    generated: generatedPlasma('arc-lead-ins'),
  },
  {
    name: 'grbl-plasma-nested',
    covers: 'issue #983 - three contours, each probed and zeroed again before its pierce',
    units: 'mm',
    machineId: 'grbl-plasma',
    moves: [],
    generated: generatedPlasma('nested-sheet'),
  },
]

function machineDefinition(entry: CorpusCase): MachineDefinition {
  const found = BUNDLED_DEFINITIONS.find((d) => d.id === entry.machineId)
  if (!found) {
    throw new Error(`corpus references unknown machine definition "${entry.machineId}"`)
  }
  return entry.definitionOverrides ? entry.definitionOverrides(found) : found
}

function buildOperation(project: Project, overrides?: Partial<Operation>): {
  operation: Operation
  tool: ReturnType<typeof normalizeToolForProject>
} {
  const toolRecord = { ...defaultTool(project.meta.units, 1), id: 't1', name: 'Conformance Tool' }
  project.tools = [toolRecord]
  const operation: Operation = {
    id: 'op1',
    name: 'Conformance Op',
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'stock' },
    toolRef: toolRecord.id,
    stepdown: 1,
    stepover: 0.4,
    feed: 600,
    plungeFeed: 180,
    rpm: 12000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth: 1,
    ...overrides,
  }
  return { operation, tool: normalizeToolForProject(toolRecord, project) }
}

/**
 * Put a case's operation in a Bottom setup and carry its moves into stock
 * space, exactly as a generated Bottom toolpath arrives at the exporter.
 */
function inBottomSetup(
  project: Project,
  operation: Operation,
  moves: ToolpathMove[],
  bottom: BottomSetupCase,
): { project: Project; operation: Operation; moves: ToolpathMove[] } {
  const bounds = getStockBounds(project.stock)
  const centre = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }
  const origin = bottom.origin === 'centre'
    ? { ...project.origin, ...centre }
    : bottom.origin === 'offCentre'
      // Off both centrelines and off every corner, on a 3-decimal fraction.
      ? { ...project.origin, x: bounds.minX + (bounds.maxX - bounds.minX) * 0.3125, y: bounds.minY + (bounds.maxY - bounds.minY) * 0.6875 }
      : project.origin
  const turned = withBottomSetup(
    syncProjectSetups({ ...project, origin, operations: [operation] }),
    {
      axis: bottom.axis,
      operationIds: [operation.id],
      setup: {
        notes: bottom.notes ?? '',
        // A declared reference, so the header's registration line carries
        // real content and the export raises no missing-registration warning.
        registration: [
          { id: 'r1', kind: 'corner', target: { type: 'point', point: { x: bounds.minX, y: bounds.maxY } } },
          { id: 'r2', kind: 'fence', target: { type: 'edge', start: { x: bounds.minX, y: bounds.maxY }, end: { x: bounds.maxX, y: bounds.maxY } } },
        ],
      },
    },
  )
  const frame = setupFrame({ axis: bottom.axis, angleDeg: 180 }, turned.stock)
  const stockSpace = toolpathInStockFrame({ operationId: operation.id, warnings: [], bounds: null, moves }, frame)
  return { project: turned, operation: turned.operations[0], moves: stockSpace.moves }
}

/** Export one corpus case to G-code text. */
export function renderCase(entry: CorpusCase): { gcode: string; warnings: string[] } {
  const definition = machineDefinition(entry)
  const options = {
    // Tool changes emit M0, a genuine program pause that a controller
    // interpreter blocks on forever. Only SBP cases opt into macro syntax.
    emitToolChanges: entry.emitToolChanges ?? false,
    emitCoolant: false,
    programName: entry.name,
  }

  if (entry.generated) {
    const generated = entry.generated()
    const toolRecord = generated.project.tools.find((tool) => tool.id === generated.operation.toolRef)
    if (!toolRecord) throw new Error(`corpus case "${entry.name}" generated an operation without a tool`)
    const result = runPostProcessor({
      project: generated.project,
      definition,
      operations: [{
        operation: generated.operation,
        tool: normalizeToolForProject(toolRecord, generated.project),
        toolpath: generated.toolpath,
      }],
      options,
    })
    return { gcode: result.gcode, warnings: result.warnings.map((w) => w.code) }
  }

  const base = newProject(`Conformance ${entry.name}`, entry.units)
  const built = buildOperation(base, entry.operationOverrides)
  const { project, operation, moves } = entry.bottomSetup
    ? inBottomSetup(base, built.operation, entry.moves, entry.bottomSetup)
    : { project: base, operation: built.operation, moves: entry.moves }
  const tool = built.tool
  const toolpath: ToolpathResult = {
    operationId: operation.id,
    warnings: [],
    bounds: null,
    moves,
    ...(entry.drillCycles ? { drillCycles: entry.drillCycles } : null),
  }

  const operations = [{ operation, tool, toolpath }]
  if (entry.secondTool) {
    const secondTool = { ...defaultTool(entry.units, 2), id: 't2', name: 'Second Tool' }
    project.tools.push(secondTool)
    const secondOp = { ...operation, id: 'op2', toolRef: secondTool.id, name: 'Second Tool Op' }
    operations.push({
      operation: secondOp,
      tool: normalizeToolForProject(secondTool, project),
      toolpath: { ...toolpath, operationId: secondOp.id },
    })
  }

  const result = runPostProcessor({
    project,
    definition,
    operations,
    options,
  })

  return {
    gcode: result.gcode,
    warnings: result.warnings.map((w) => w.code),
  }
}

/** File extension the case's machine definition asks for. */
export function caseExtension(entry: CorpusCase): string {
  return machineDefinition(entry).fileExtension || 'nc'
}
