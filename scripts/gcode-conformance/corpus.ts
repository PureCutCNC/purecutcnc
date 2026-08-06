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
 */

import { newProject, defaultTool, rectProfile } from '../../src/types/project'
import type { Operation, Project, SketchFeature, Units } from '../../src/types/project'
import { projectWithFeatures } from '../../src/test/projectFixtures'
import { generateEdgeRouteToolpath } from '../../src/engine/toolpaths/edge'
import { normalizeToolForProject } from '../../src/engine/toolpaths/geometry'
import { runPostProcessor } from '../../src/engine/gcode/postprocessor'
import { BUNDLED_DEFINITIONS } from '../../src/engine/gcode/definitions'
import type { MachineDefinition } from '../../src/engine/gcode/types'
import type { ToolpathMove, ToolpathPoint, ToolpathResult } from '../../src/engine/toolpaths/types'

export interface CorpusCase {
  /** File-safe identifier; becomes `<name>.nc`. */
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
}

function pt(x: number, y: number, z = -1): ToolpathPoint {
  return { x, y, z }
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

/** Export one corpus case to G-code text. */
export function renderCase(entry: CorpusCase): { gcode: string; warnings: string[] } {
  const project = newProject(`Conformance ${entry.name}`, entry.units)
  const { operation, tool } = buildOperation(project, entry.operationOverrides)
  const toolpath: ToolpathResult = {
    operationId: operation.id,
    warnings: [],
    bounds: null,
    moves: entry.moves,
  }

  const result = runPostProcessor({
    project,
    definition: machineDefinition(entry),
    operations: [{ operation, tool, toolpath }],
    options: {
      // Tool changes emit M0, a genuine program pause that a controller
      // interpreter blocks on forever. They are not what this corpus tests.
      emitToolChanges: false,
      emitCoolant: false,
      programName: entry.name,
    },
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
