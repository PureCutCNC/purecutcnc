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
 * Simulation-open profile for issue #1112 rt2-e (item 21): where does the time
 * go when the Simulation tab opens on an Around setup, and how much of it is
 * square-blank specific?
 *
 * Frank: "simulation view for a square block seems to take some time". The
 * square blank is the round bar's radial heightfield whose cells start at the
 * blank's true cross section, so the replay kernel is the same code; the only
 * square-specific work is grid seeding plus whatever the higher corner cells
 * cost the kernel. This probe measures that rather than guessing.
 *
 * The fixture is the job the browser smoke test seeds (Turn, then Rotary rough
 * and finish on a 25 x 120 mm horizontal bar, radial stock left on the rough),
 * built twice: once on a 25 mm square blank and once on a Ø25 round bar. Both
 * unroll to the same sheet (pi·25 across), so the grids are the same size and
 * the toolpaths are the same target cylinder — the comparison isolates the
 * blank shape.
 *
 * Every stage is timed serially, in this one process, with a warm-up run and
 * the minimum of `--reps` (default 5) reported as the stage cost. The heightfield
 * digests are printed with the timings so a change can be shown to leave the
 * simulated result byte-identical.
 *
 * Usage:
 *   npx tsx scripts/issue-1112-rt2-e-simulation-profile.ts [--detail 280] [--reps 5]
 *     [--dump out.json]
 *
 * `--dump` writes the stage timings and heightfield digests as JSON, which is
 * how the before/after equality evidence is compared.
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

import { defaultRoundWorkholding } from '../src/store/helpers/roundWorkholding'
import { planRotarySolid } from '../src/store/helpers/rotarySolids'
import { useProjectStore } from '../src/store/projectStore'
import type { SelectionState } from '../src/store/types'
import { defaultTool, newProject, roundStock } from '../src/types/project'
import type { Operation, Project } from '../src/types/project'
import { squareStock } from '../src/types/barStock'
import { computeOperationToolpath } from '../src/engine/toolpaths/generateOperation'
import type { ToolpathResult } from '../src/engine/toolpaths/types'
import { buildSimulationSetupInput } from '../src/app/simulationSetup'
import type { SimulationSetupInput } from '../src/app/simulationSetup'
import {
  computeSimulationResult,
  priorReplayGrid,
  simulationBuildOptions,
} from '../src/app/simulationCompute'
import { createSimulationGrid } from '../src/engine/simulation/grid'
import { unrolledProject, unwrapToolpath } from '../src/engine/aroundFrame'
import { foldToolpath } from '../src/engine/aroundFold'
import { parseToolLibraryFile, type ToolLibraryEntry } from '../src/toolLibrary'
import * as THREE from 'three'
import { buildSimulationStockScene } from '../src/engine/simulation/simulationScene'
import { PlaybackController, cloneSimulationGrid } from '../src/engine/simulation/playback'
import type { PlaybackOptions } from '../src/engine/simulation/playback'
import type { SimulationGrid } from '../src/engine/simulation/types'

/** The dialog's write starts from a bare feature-mode selection. */
const EMPTY_SELECTION: SelectionState = {
  mode: 'feature',
  selectedFeatureId: null,
  selectedFeatureIds: [],
  selectedTabIds: [],
  selectedClampIds: [],
  selectedNode: null,
  hoveredFeatureId: null,
  sketchEditTool: null,
  activeControl: null,
  groupFolderId: null,
}

const SIDE = 25
const LENGTH = 120
const DEFAULT_DETAIL = 280
const DEFAULT_REPS = 5

function argument(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return fallback
  const value = Number(process.argv[index + 1])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function argumentString(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null
}

// ---------------------------------------------------------------------------
// Fixture: the smoke test's Turn + Rotary rough + finish, on either blank
// ---------------------------------------------------------------------------

interface Job {
  shape: 'square' | 'round'
  /** Whether CAM Add picked its tools from the bundled library (the dialogs' own path). */
  library: boolean
  project: Project
  /** The canonical stock-space paths the app holds before the setup turn. */
  canonicalPaths: Map<string, ToolpathResult>
  setupInput: SimulationSetupInput
  setupId: string
  rough: Operation
  finish: Operation
  roughPath: ToolpathResult
  finishPath: ToolpathResult
  toolpathGenerationMs: number
}

function seededProject(shape: 'square' | 'round'): Project {
  const base = newProject(`Rotary ${shape}`, 'mm')
  base.meta.created = base.meta.modified = '2026-01-01T00:00:00.000Z'
  base.meta.maxTravelZ = 60
  base.meta.projectType = 'rotary'
  const blank = shape === 'square' ? squareStock(SIDE, LENGTH, 'x') : roundStock(SIDE, LENGTH, 'x')
  base.stock = blank
  base.tools = [{
    ...defaultTool('mm', 1),
    id: 't1',
    name: 'Flat 6',
    type: 'flat_endmill',
    diameter: 6,
    defaultStepover: 0.4,
    defaultStepdown: 2,
  }]
  base.clamps = [{ id: 'chuck', name: 'Chuck', visible: true, ...defaultRoundWorkholding('chuck', blank, 'mm') }]
  base.setups = [
    ...base.setups,
    { ...base.setups[0], id: 'around', name: 'Around', kind: 'around', orientation: { axis: 'x', angleDeg: 0 } },
  ]
  base.activeSetupId = 'around'
  return base
}

/** The bundled library, parsed from disk because a script has no `fetch`. */
function bundledLibraryTools(): ToolLibraryEntry[] {
  const payload = JSON.parse(readFileSync(new URL('../public/tool-library.json', import.meta.url), 'utf8'))
  return parseToolLibraryFile(payload).tools
}

function rotaryJob(shape: 'square' | 'round', library: boolean): Job {
  const seeded = seededProject(shape)
  const plan = planRotarySolid(seeded, EMPTY_SELECTION, { kind: 'turn', start: 10, length: 30, diameter: 20 })
  if (!plan.ok) throw new Error(`fixture: the Turn dialog was refused (${plan.reason})`)
  useProjectStore.getState().loadProject(plan.project)
  const target = { source: 'features' as const, featureIds: [plan.created.featureId] }
  const libraryTools = library ? bundledLibraryTools() : undefined
  const store = useProjectStore.getState()
  if (!store.addOperation('rotary_rough', 'rough', target, libraryTools)) throw new Error('fixture: rough was refused')
  if (!useProjectStore.getState().addOperation('rotary_finish', 'finish', target, libraryTools)) throw new Error('fixture: finish was refused')
  const project = useProjectStore.getState().project
  const around = project.setups.find((setup) => setup.kind === 'around')
  const rough = project.operations.find((operation) => operation.kind === 'rotary_rough')
  const finish = project.operations.find((operation) => operation.kind === 'rotary_finish')
  if (!around || !rough || !finish) throw new Error('fixture: the job is missing an Around rough and finish')
  rough.stockToLeaveRadial = 0.4

  const generationStart = process.hrtime.bigint()
  const paths = new Map<string, ToolpathResult>()
  for (const operation of project.operations) {
    if (operation.setupId !== around.id) continue
    const envelope = computeOperationToolpath(project, operation)
    if (envelope) paths.set(operation.id, envelope.result)
  }
  const toolpathGenerationMs = Number(process.hrtime.bigint() - generationStart) / 1e6

  const setupInput = buildSimulationSetupInput(project, around, paths)
  if (!setupInput) throw new Error('fixture: the Around setup yields no simulation input')
  const roughPath = setupInput.toolpaths.get(rough.id)
  const finishPath = setupInput.toolpaths.get(finish.id)
  if (!roughPath || !finishPath) throw new Error('fixture: the job is missing a turned path')
  return {
    shape, library, project, canonicalPaths: paths, setupInput, setupId: around.id, rough, finish,
    roughPath, finishPath, toolpathGenerationMs,
  }
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

const timings: { shape: string; stage: string; min: number; median: number }[] = []

function measure(stage: string, shape: string, run: () => void, reps: number): void {
  run() // warm-up: JIT, caches, first-touch page faults
  const samples: number[] = []
  for (let rep = 0; rep < reps; rep += 1) {
    const start = process.hrtime.bigint()
    run()
    samples.push(Number(process.hrtime.bigint() - start) / 1e6)
  }
  samples.sort((a, b) => a - b)
  timings.push({ shape, stage, min: samples[0], median: samples[Math.floor(samples.length / 2)] })
}

/** sha256 over the grid's float32 bytes, plus the statistics a change must keep. */
function digest(grid: SimulationGrid): string {
  const bytes = new Uint8Array(grid.topZ.buffer, grid.topZ.byteOffset, grid.topZ.byteLength)
  return createHash('sha256').update(bytes).digest('hex')
}

function profileJob(job: Job, detail: number, reps: number): Record<string, unknown> {
  const label = job.library ? `${job.shape} +lib` : job.shape
  const localProject = job.setupInput.project
  const setupInput = job.setupInput
  const options = simulationBuildOptions(setupInput, detail)
  const toolRecord = job.project.tools.find((tool) => tool.id === job.finish.toolRef)
  if (!toolRecord) throw new Error('fixture: the finish has no tool')
  const playbackTool = {
    toolType: toolRecord.type,
    toolRadius: toolRecord.diameter / 2,
    vBitAngle: null,
  }
  const playbackOptions: PlaybackOptions = {
    maxSegmentLength: toolRecord.diameter,
    referenceFeedPerSecond: job.finish.feed > 0 ? job.finish.feed / 60 : undefined,
    plungeFeedPerSecond: job.finish.plungeFeed > 0 ? job.finish.plungeFeed / 60 : undefined,
  }

  // The stages of opening the panel, in the order the app runs them.
  const setup = job.project.setups.find((entry) => entry.id === job.setupId)
  if (!setup) throw new Error('fixture: the Around setup is not on the project')
  measure('setup input (unwrap + fold every path)', label, () => {
    buildSimulationSetupInput(job.project, setup, job.canonicalPaths)
  }, reps)

  measure('  of which foldToolpath (canonical paths)', label, () => {
    for (const path of job.canonicalPaths.values()) foldToolpath(unwrapToolpath(path, setupInput.bar!.frame), setupInput.bar!.frame)
  }, reps)

  measure('  of which unrolledSimulationProject', label, () => {
    unrolledProject(job.project, setupInput.bar!.frame)
  }, reps)

  measure('grid init (one createSimulationGrid)', label, () => {
    createSimulationGrid(localProject, options)
  }, reps)

  measure('selected result (grid + finish replay + stats)', label, () => {
    computeSimulationResult({
      setupInput,
      project: job.project,
      simulationMode: 'selected',
      simulationDetailCells: detail,
      selectedInSetup: job.finish,
      paths: setupInput.toolpaths,
    })
  }, reps)

  measure('visible result (grid + rough + finish + stats)', label, () => {
    computeSimulationResult({
      setupInput,
      project: job.project,
      simulationMode: 'visible',
      simulationDetailCells: detail,
      selectedInSetup: job.finish,
      paths: setupInput.toolpaths,
    })
  }, reps)

  measure('playback base (grid + rough replay)', label, () => {
    priorReplayGrid(localProject, setupInput.operations, setupInput.toolpaths, job.finish.id, options)
  }, reps)

  // The static view's CPU half of mounting the scene: texture + surface
  // geometry + instanced walls. The GPU upload and the shader compile that
  // follow are browser-side and cannot be timed here.
  const frame = setupInput.bar?.frame
  const stockColor = new THREE.Color('#9aa4b2')
  const sceneGrid = createSimulationGrid(localProject, options)
  measure('scene mount (texture + surface + wall meshes)', label, () => {
    const built = buildSimulationStockScene(sceneGrid, stockColor, frame)
    built.heightfieldTexture.dispose()
    built.group.traverse((child) => {
      const mesh = child as THREE.Mesh
      mesh.geometry?.dispose()
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose())
      else material?.dispose()
    })
  }, reps)

  // The playback controller's own construction plus a whole play-through: what
  // the viewport pays after the base grid exists.
  let controller: PlaybackController | null = null
  const baseGrid = priorReplayGrid(localProject, setupInput.operations, setupInput.toolpaths, job.finish.id, options)
  const pace = (job.finish.feed > 0 ? job.finish.feed / 60 : 50) * 2
  const perFrame = Math.min(pace * (1 / 60), 2.5)
  measure('playback frames (whole finish, 1x pace)', label, () => {
    controller = new PlaybackController(cloneSimulationGrid(baseGrid), job.finishPath.moves, playbackTool, playbackOptions)
    while (!controller.isFinished()) {
      controller.advance(perFrame)
      controller.clearDirtyRegion()
    }
  }, Math.max(1, Math.floor(reps / 2)))

  const selected = computeSimulationResult({
    setupInput,
    project: job.project,
    simulationMode: 'selected',
    simulationDetailCells: detail,
    selectedInSetup: job.finish,
    paths: setupInput.toolpaths,
  })
  const visible = computeSimulationResult({
    setupInput,
    project: job.project,
    simulationMode: 'visible',
    simulationDetailCells: detail,
    selectedInSetup: job.finish,
    paths: setupInput.toolpaths,
  })
  const empty = createSimulationGrid(localProject, options)

  return {
    shape: job.shape,
    library: job.library,
    grid: { cols: selected.grid.cols, rows: selected.grid.rows, cellSize: selected.grid.cellSize, cells: selected.grid.cols * selected.grid.rows },
    squareSpecific: {
      hasInitialTopZ: selected.grid.initialTopZ !== undefined,
      stockTopZ: selected.grid.stockTopZ,
    },
    toolpathGenerationMs: job.toolpathGenerationMs,
    moves: { rough: job.roughPath.moves.length, finish: job.finishPath.moves.length },
    canonicalMoves: [...job.canonicalPaths.values()].map((path) => path.moves.length),
    processedMoves: {
      selected: selected.stats.processedMoveCount,
      visible: visible.stats.processedMoveCount,
    },
    timings: timings.filter((entry) => entry.shape === label).map((entry) => ({ stage: entry.stage, min: entry.min, median: entry.median })),
    digests: {
      empty: digest(empty),
      selected: digest(selected.grid),
      visible: digest(visible.grid),
      playbackBase: digest(baseGrid),
      played: controller ? digest((controller as PlaybackController).liveGrid) : null,
    },
    stats: {
      selectedRemoved: selected.stats.removedCellCount,
      selectedMinTopZ: selected.stats.minTopZ,
      selectedMaxRemovedDepth: selected.stats.maxRemovedDepth,
      visibleRemoved: visible.stats.removedCellCount,
      visibleMinTopZ: visible.stats.minTopZ,
    },
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const detail = argument('detail', DEFAULT_DETAIL)
const reps = argument('reps', DEFAULT_REPS)
const dumpPath = argumentString('dump')

const library = process.argv.includes('--library')
const labels = library
  ? (['square +lib', 'round +lib'] as const)
  : (['square', 'round'] as const)
const summary: Record<string, unknown> = { detail, reps, library, shapes: {} }
for (const label of labels) {
  const shape = label.startsWith('square') ? 'square' as const : 'round' as const
  const job = rotaryJob(shape, library)
  ;(summary.shapes as Record<string, unknown>)[label] = profileJob(job, detail, reps)
}

const pad = (text: string, width: number): string => text.padEnd(width)
const fixed = (value: number): string => value.toFixed(1).padStart(8)

console.log(`\nSimulation-open profile (issue #1112 rt2-e, item 21) — detail ${detail} cells, best of ${reps}\n`)
const stages = [...new Set(timings.map((entry) => entry.stage))]
const byStage = new Map<string, Map<string, { min: number; median: number }>>()
for (const entry of timings) {
  if (!byStage.has(entry.stage)) byStage.set(entry.stage, new Map())
  byStage.get(entry.stage)!.set(entry.shape, { min: entry.min, median: entry.median })
}
const column = (text: string): string => text.padStart(18)
console.log(`${pad('stage (ms, min / median)', 48)}${labels.map(column).join('')}`)
for (const stage of stages) {
  const cells = labels.map((label) => {
    const entry = byStage.get(stage)!.get(label)
    return entry ? `${fixed(entry.min)} /${fixed(entry.median)}`.padStart(18) : column('')
  })
  console.log(`${pad(stage, 48)}${cells.join('')}`)
}

console.log('')
for (const shape of labels) {
  const entry = (summary.shapes as Record<string, Record<string, unknown>>)[shape]
  const grid = entry.grid as { cols: number; rows: number; cells: number; cellSize: number }
  const moves = entry.moves as { rough: number; finish: number }
  const digests = entry.digests as Record<string, string | null>
  console.log(
    `${pad(shape, 8)} grid ${grid.cols}x${grid.rows} (${grid.cells} cells, ${grid.cellSize.toFixed(4)} mm) `
    + `moves rough ${moves.rough} / finish ${moves.finish} — toolpaths generated in ${(entry.toolpathGenerationMs as number).toFixed(0)} ms`,
  )
  const stagesFor = byStage
  const stageMin = (stage: string): number => stagesFor.get(stage)?.get(shape)?.min ?? NaN
  const openSequence = stageMin('setup input (unwrap + fold every path)')
    + stageMin('grid init (one createSimulationGrid)')
    + stageMin('selected result (grid + finish replay + stats)')
  console.log(
    `         opens in ${openSequence.toFixed(1)} ms of engine work (setup input + grid init + selected result); `
    + `playback adds ${stageMin('playback base (grid + rough replay)').toFixed(1)} ms for the base grid`,
  )
  console.log(`         digests empty ${digests.empty!.slice(0, 16)} selected ${digests.selected!.slice(0, 16)} visible ${digests.visible!.slice(0, 16)}`)
  console.log(`                 base ${digests.playbackBase!.slice(0, 16)} played ${String(digests.played).slice(0, 16)}`)
}

if (dumpPath) {
  writeFileSync(dumpPath, `${JSON.stringify(summary, null, 2)}\n`)
  console.log(`\nWrote ${dumpPath}`)
}
