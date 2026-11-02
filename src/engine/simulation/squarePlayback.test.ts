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
 * Playback cost of the square-to-round job the browser smoke test seeds
 * (issue #1048 correction 3).
 *
 * `e2e/rotaryModel.smoke.spec.ts` seeds a 25 × 120 mm square blank with the
 * app's own Square-to-round dialog, updates the rough's radial stock through the
 * operation, and plays the finish from the prior rough. On CI's 2-vCPU runner
 * that spec sits at the 60 s / 2 % margin, so the playback's per-frame cost is
 * guarded here (docs/PERF_ASSERTIONS.md).
 *
 * The default guard is a **count of schedule derivations** (issue #1111): the
 * wrapped kernel caches every source move's ramp sample schedule, and the count
 * of real derivations is a property of the path, not of the machine, so it cannot
 * fail because the build pool is busy. The CPU-time ratio against the flat kernel
 * is still measured here for now; issue #1111 slice pg-b moves that behind an
 * explicit environment flag and decides when it runs. A small explicit ramp is
 * replayed across many frames as well, because the square job's passes may not
 * exercise a non-empty ramp schedule.
 *
 * The subject is the real job: the sheet the app builds for the finish, the
 * prior-rough replay as its starting stock, and every frame the viewport's
 * `PlaybackController` would run. A second case builds the same job the way CAM
 * Add does — with the bundled library, so rough keeps the seeded flat cutter
 * and finish imports a ball endmill — and checks that playback result, because
 * that finer ball stepover is the motion the browser actually plays. The
 * reference is the **same** source moves
 * through the same playback code on the same starting stock with the periodic
 * wrap removed, so it takes the flat kernel and never enters the wrapped
 * kernel. Both lanes are therefore identical outside the code under guard:
 * the controller, subdivision, pose bookkeeping and the job build cancel.
 *
 * Measured on this machine (2026-10-19, `cpuRatio`, subject 5 reps / reference
 * 3): 4.31–4.35 after correction 3, 3.87–3.99 on `integration/0.6.0`, and
 * 5.91–5.92 on the pre-correction branch (every frame called the 17-argument
 * interval helper and rewrote five per-image scratch arrays for every cell).
 * Limit 5 sits between the fixed cost and the old one; the geometric midpoint
 * of 4.33 and 5.92 is 5.06.
 *
 * Run with: npx tsx src/engine/simulation/squarePlayback.test.ts
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { squareStock } from '../../types/barStock'
import { defaultTool, newProject } from '../../types/project'
import type { Operation, Project } from '../../types/project'
import { planRotarySolid } from '../../store/helpers/rotarySolids'
import { useProjectStore } from '../../store/projectStore'
import { defaultRoundWorkholding } from '../../store/helpers/roundWorkholding'
import type { SelectionState } from '../../store/types'
import { parseToolLibraryFile, type ToolLibraryEntry } from '../../toolLibrary'
import { computeOperationToolpath } from '../toolpaths/generateOperation'
import { buildSimulationSetupInput } from '../../app/simulationSetup'
import type { SimulationSetupInput } from '../../app/simulationSetup'
import {
  computeSimulationResult,
  priorReplayGrid,
  simulationBuildOptions,
} from '../../app/simulationCompute'
import { cpuRatio } from '../../test/cpuRatio'
import { PlaybackController, cloneSimulationGrid } from './playback'
import type { PlaybackOptions, PlaybackToolInfo } from './playback'
import {
  setSweepScheduleObserver,
  wrappedNeedsSweep,
  wrappedSweepSampleFractions,
} from './replay'
import type { SweepScheduleDerivation } from './replay'
import type { ToolpathMove, ToolpathResult } from '../toolpaths/types'
import type { SimulationGrid } from './types'

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

/**
 * The e2e seed: a 25 × 120 mm square blank, one 6 mm flat cutter that steps
 * over 0.4 × its diameter, the app's default round workholding, and an Around
 * setup about X. The dialog then creates the round target and both operations.
 */
function seededSquareProject(): Project {
  const base = newProject('Rotary square', 'mm')
  base.meta.created = base.meta.modified = '2026-01-01T00:00:00.000Z'
  base.meta.maxTravelZ = 60
  base.meta.projectType = 'rotary'
  const blank = squareStock(25, 120, 'x')
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

interface SquareJob {
  project: Project
  setupInput: SimulationSetupInput
  finish: Operation
  finishPath: ToolpathResult
  tool: PlaybackToolInfo
  options: PlaybackOptions
}

/** The bundled library, parsed from disk because this test has no `fetch`. */
function bundledLibraryTools(): ToolLibraryEntry[] {
  const payload = JSON.parse(readFileSync(new URL('../../../public/tool-library.json', import.meta.url), 'utf8'))
  return parseToolLibraryFile(payload).tools
}

/**
 * The exact job the browser smoke test seeds, through the app's own code.
 *
 * `withLibrary` is the CAM Add path: the panel loads the bundled library and
 * `addOperation` picks from it. Rotary rough prefers the project's existing
 * flat cutter; rotary finish prefers a ball endmill, so it imports one from the
 * library. That imported ball — with its much finer library stepover — is the
 * workload the browser actually replays, and the case this fixture used to
 * miss.
 */
function squareToRoundJob(withLibrary = false): SquareJob {
  const seeded = seededSquareProject()
  const plan = planRotarySolid(seeded, EMPTY_SELECTION, {
    kind: 'turn',
    start: 10,
    length: 30,
    diameter: 20,
  })
  assert(plan.ok, 'fixture: the Turn dialog must create the model')
  if (!plan.ok) throw new Error('fixture: the Turn was refused')
  // Creation adds no operation (issue #1112 G), so the fixture adds the two
  // rotary operations through the store exactly as the user does from CAM.
  useProjectStore.getState().loadProject(plan.project)
  const target = { source: 'features' as const, featureIds: [plan.created.featureId] }
  const libraryTools = withLibrary ? bundledLibraryTools() : undefined
  assert(useProjectStore.getState().addOperation('rotary_rough', 'rough', target, libraryTools), 'fixture: rough added')
  assert(useProjectStore.getState().addOperation('rotary_finish', 'finish', target, libraryTools), 'fixture: finish added')
  const project = useProjectStore.getState().project
  const around = project.setups.find((setup) => setup.kind === 'around')
  const rough = project.operations.find((operation) => operation.kind === 'rotary_rough')
  const finish = project.operations.find((operation) => operation.kind === 'rotary_finish')
  assert(around && rough && finish, 'fixture: the job has an Around rough and finish')

  // The spec leaves the operator's radial stock so the rough and finished
  // surfaces genuinely differ; that is the playback base the panel builds.
  rough.stockToLeaveRadial = 0.4

  const paths = new Map<string, ToolpathResult>()
  for (const operation of project.operations) {
    if (operation.setupId !== around.id) continue
    const envelope = computeOperationToolpath(project, operation)
    if (envelope) paths.set(operation.id, envelope.result)
  }
  const setupInput = buildSimulationSetupInput(project, around, paths)
  assert(setupInput, 'fixture: the Around setup yields a simulation input')
  const finishPath = setupInput.toolpaths.get(finish.id)
  assert(finishPath && finishPath.moves.length > 0, 'fixture: the finish has a toolpath')
  const toolRecord = project.tools.find((tool) => tool.id === finish.toolRef)
  assert(toolRecord, 'fixture: the finish has a tool')
  if (withLibrary) {
    assert(toolRecord.type === 'ball_endmill', 'fixture: CAM Add imports the library ball finish')
    assert(toolRecord.id !== 't1', 'fixture: the ball finish is not the seeded flat cutter')
  } else {
    assert(toolRecord.type === 'flat_endmill', 'fixture: the finish uses the seeded flat cutter')
  }

  return {
    project,
    setupInput,
    finish,
    finishPath,
    tool: {
      toolType: toolRecord.type,
      toolRadius: toolRecord.diameter / 2,
      vBitAngle: null,
    },
    options: {
      // The viewport's own subdivision and feed anchor.
      maxSegmentLength: toolRecord.diameter,
      referenceFeedPerSecond: finish.feed > 0 ? finish.feed / 60 : undefined,
      plungeFeedPerSecond: finish.plungeFeed > 0 ? finish.plungeFeed / 60 : undefined,
    },
  }
}

const DETAIL_CELLS = 280

/** Cells this grid has lowered below a reference grid's starting surface. */
function removedAgainst(grid: SimulationGrid, baseline: SimulationGrid): number {
  let removed = 0
  for (let index = 0; index < grid.topZ.length; index += 1) {
    if (grid.topZ[index] < baseline.topZ[index] - 1e-9) removed += 1
  }
  return removed
}

/** Cells a replayed grid has lowered below its own immutable virgin baseline. */
function removedFromVirgin(grid: SimulationGrid): number {
  const baseline = grid.initialTopZ
  if (!baseline) return 0
  let removed = 0
  for (let index = 0; index < grid.topZ.length; index += 1) {
    if (grid.topZ[index] < baseline[index] - 1e-9) removed += 1
  }
  return removed
}

/**
 * Fails if one `(source move, cell size, cutter radius)` schedule was ever
 * derived twice. That is the whole guard: the kernel may meet a combination many
 * times (once per frame of a long move), but only the first may build it.
 */
function assertSingleDerivations(
  derivations: readonly SweepScheduleDerivation[],
  label: string,
): void {
  const combinations = new Map<ToolpathMove, Map<string, number>>()
  for (const derivation of derivations) {
    const key = `${derivation.cellSize}@${derivation.toolRadius}`
    const forMove = combinations.get(derivation.move) ?? new Map<string, number>()
    const count = (forMove.get(key) ?? 0) + 1
    forMove.set(key, count)
    combinations.set(derivation.move, forMove)
    assert.equal(
      count,
      1,
      `${label}: the schedule for one source move at cell size ${derivation.cellSize} and cutter `
      + `radius ${derivation.toolRadius} was derived ${count} times — a repeated piece of the `
      + 'same move must reuse the cached schedule',
    )
  }
}

interface RampFixture {
  grid: SimulationGrid
  move: ToolpathMove
  tool: PlaybackToolInfo
}

/**
 * A small explicit ramp (issue #1111): one source move that descends 6 mm over
 * 10 mm, more than one cell of Z per cutter diameter at this cell size, so the
 * wrapped kernel really builds a non-empty sample schedule. The square-to-round
 * finish is mostly constant-Z passes, so it must not be assumed to exercise the
 * schedule itself.
 */
function rampFixture(): RampFixture {
  const frameRadius = 10
  const period = 2 * Math.PI * frameRadius
  const cellSize = 0.25
  const alongCells = 80
  const acrossCells = Math.round(period / cellSize)
  const grid: SimulationGrid = {
    cols: alongCells,
    rows: acrossCells,
    cellSize,
    originX: 0,
    originY: -period / 2,
    stockBottomZ: 0,
    stockTopZ: frameRadius,
    wrap: { axis: 'y', period },
    topZ: new Float32Array(alongCells * acrossCells).fill(frameRadius),
  }
  return {
    grid,
    // Slope 0.6: 0.6 × 2 × 3 mm = 3.6 mm of Z per cutter diameter > 0.25 mm cell.
    move: { kind: 'cut', from: { x: 4, y: 0, z: 12 }, to: { x: 14, y: 0, z: 6 } },
    tool: { toolType: 'flat_endmill', toolRadius: 3, vBitAngle: null },
  }
}

/** Plays the whole ramp at a fixed frame budget; subdivision is off so every frame is a piece. */
function playRamp(fixture: RampFixture): { grid: SimulationGrid; frames: number } {
  const controller = new PlaybackController(fixture.grid, [fixture.move], fixture.tool, {
    maxSegmentLength: 0,
  })
  let frames = 0
  while (!controller.isFinished()) {
    controller.advance(0.5)
    controller.clearDirtyRegion()
    frames += 1
  }
  return { grid: controller.liveGrid, frames }
}

interface PlaybackLane {
  /** Restores the starting stock and constructs the controller outside the measured region. */
  setup: () => void
  /** Every frame the viewport would tick, to the end of the program. */
  run: () => void
  /** The controller's live grid, for the "it actually cut" check after the measurement. */
  liveGrid: () => SimulationGrid | null
}

/**
 * One playback lane over the job's own source moves. A forward-only run never
 * seeks, so the lane is exactly the smoke test's play phase; the controller
 * rebinds to a fresh grid on every rep while the grid's `topZ` is restored from
 * the pristine base, so allocation stays outside the measured region (except
 * the controller the viewport also builds once).
 */
function playbackLane(
  job: SquareJob,
  baseGrid: SimulationGrid,
  wrap: boolean,
): PlaybackLane {
  const grid = cloneSimulationGrid(baseGrid)
  if (!wrap) delete grid.wrap
  let controller: PlaybackController | null = null
  const pace = (job.finish.feed > 0 ? job.finish.feed / 60 : 50) * 2
  const perFrame = Math.min(pace * (1 / 60), 2.5)
  return {
    liveGrid: () => controller?.liveGrid ?? null,
    setup: () => {
      grid.topZ.set(baseGrid.topZ)
      controller = new PlaybackController(grid, job.finishPath.moves, job.tool, job.options)
    },
    run: () => {
      const active = controller
      assert(active, 'lane: setup must run first')
      // The viewport's 1× pace clamped by the default 2.5 mm step. A slow frame
      // is bounded the same way, which is what makes this frame count the play
      // phase rather than a wall-clock duration.
      while (!active.isFinished()) {
        active.advance(perFrame)
        active.clearDirtyRegion()
      }
    },
  }
}

function testSquarePlaybackTiming(): void {
  console.log('Testing square-to-round playback cost against the flat kernel...')
  const job = squareToRoundJob()
  const buildOptions = simulationBuildOptions(job.setupInput, DETAIL_CELLS)
  // The playback base grid is the prior rough replayed into fresh stock, exactly
  // as `priorReplayGrid` supplies the viewport.
  const baseGrid = priorReplayGrid(
    job.project,
    job.setupInput.operations,
    job.setupInput.toolpaths,
    job.finish.id,
    buildOptions,
  )

  const wrapped = playbackLane(job, baseGrid, true)
  // No wrap means `applyMoveToGrid` takes the untouched flat kernel, so the
  // reference cannot benefit from anything the wrapped kernel does.
  const flat = playbackLane(job, baseGrid, false)

  // The default, load-independent guard (issue #1111): count real schedule
  // derivations over one complete playback of the real job. The JIT warm-up is
  // also the counted run, so the timing measurement below is unchanged.
  const derivations: SweepScheduleDerivation[] = []
  setSweepScheduleObserver((derivation) => derivations.push(derivation))
  // Warm the JIT outside the measured region.
  wrapped.setup()
  wrapped.run()
  setSweepScheduleObserver(null)
  flat.setup()
  flat.run()

  assert(
    derivations.length > 0,
    'the wrapped playback must derive at least one schedule or the count guards nothing',
  )
  // The controller replays a long source move frame by frame, so a per-frame
  // derivation would exceed the path's own move count at once.
  assert(
    derivations.length <= job.finishPath.moves.length,
    `the wrapped playback derived ${derivations.length} schedules for a `
    + `${job.finishPath.moves.length}-move path — every piece of one source move must reuse `
    + 'the cached schedule',
  )
  assertSingleDerivations(derivations, 'square-to-round playback')
  console.log(
    `  schedule derivations: ${derivations.length} for ${job.finishPath.moves.length} source moves`,
  )

  const { ratio, subjectMs, referenceMs } = cpuRatio(wrapped, flat)
  console.log(
    `  square-to-round playback: wrapped ${subjectMs.toFixed(1)} ms vs flat reference `
    + `${referenceMs.toFixed(1)} ms CPU (ratio ${ratio.toFixed(2)})`,
  )
  assert(referenceMs > 0, 'reference must do measurable work or the ratio is meaningless')
  assert(
    ratio < 5,
    `square-to-round playback cost ${ratio.toFixed(2)}x the flat-kernel reference `
    + `(limit 5x; ${subjectMs.toFixed(1)} ms vs ${referenceMs.toFixed(1)} ms CPU) — check that `
    + 'the wrapped kernel keeps the horizontal interval test inline, caches the ramp '
    + 'sample schedule per source move instead of deriving it per frame, and never '
    + 'evaluates the batch ceiling an axial constant-Z flat cut cannot need',
  )

  // The lanes must actually cut, or the ratio compares nothing.
  const wrappedGrid = wrapped.liveGrid()
  const flatGrid = flat.liveGrid()
  assert(wrappedGrid && flatGrid, 'lanes: the measured runs left a live grid')
  const wrappedCut = removedAgainst(wrappedGrid, baseGrid)
  const flatCut = removedAgainst(flatGrid, baseGrid)
  assert(wrappedCut > 0, 'fixture: the wrapped playback must remove material')
  assert(flatCut > 0, 'fixture: the flat reference playback must remove material')

  console.log(`square-to-round playback timing: PASSED (${wrappedCut} cells removed)`)
}

/**
 * The schedule cache itself, counted (issue #1111). A ramp is played across many
 * frames of one source move: the first piece derives the schedule and every later
 * piece must reuse it. Then cell size and cutter radius must each be part of the
 * cache key, and collection must leave the grid untouched.
 */
function testRampScheduleGuard(): void {
  console.log('Testing wrapped ramp schedule derivations...')
  const played = rampFixture()
  assert(
    wrappedNeedsSweep(played.grid, played.move, played.tool.toolRadius),
    'fixture: the ramp must need the swept schedule or nothing here is guarded',
  )

  const derivations: SweepScheduleDerivation[] = []
  setSweepScheduleObserver((derivation) => derivations.push(derivation))
  const playback = playRamp(played)
  setSweepScheduleObserver(null)

  assert(playback.frames >= 8, `fixture: the ramp must span several frames (played ${playback.frames})`)
  assert.equal(
    derivations.length,
    1,
    `the ramp derived its schedule ${derivations.length} times across ${playback.frames} frames — `
    + 'every piece of one source move must reuse the cached schedule',
  )
  const derived = derivations[0]
  assert(derived.move === played.move, 'the derivation reports the source move it belongs to')
  assert.equal(derived.cellSize, played.grid.cellSize, 'the derivation reports the grid cell size')
  assert.equal(derived.toolRadius, played.tool.toolRadius, 'the derivation reports the cutter radius')
  assert(derived.sampleCount > 1, 'the ramp schedule is non-empty')
  const rampRemoved = removedAgainst(playback.grid, played.grid)
  assert(rampRemoved > 0, 'the guarded ramp playback removes material')

  // Cell size and cutter radius are cache-key dimensions: each change derives its
  // own schedule instead of reusing a neighbouring one.
  const sizing = rampFixture()
  const resized: SweepScheduleDerivation[] = []
  setSweepScheduleObserver((derivation) => resized.push(derivation))
  const fine = wrappedSweepSampleFractions(sizing.grid, sizing.move, sizing.tool.toolRadius)
  const repeat = wrappedSweepSampleFractions(sizing.grid, sizing.move, sizing.tool.toolRadius)
  assert.equal(resized.length, 1, 're-deriving the same combination is a cache hit')
  assert.deepEqual(repeat, fine, 'a cache hit returns the same schedule')

  const coarse = wrappedSweepSampleFractions(
    { ...sizing.grid, cellSize: sizing.grid.cellSize * 2 },
    sizing.move,
    sizing.tool.toolRadius,
  )
  assert.equal(resized.length, 2, 'a different cell size must derive a new schedule')
  assert(coarse.length < fine.length, 'a coarser grid samples the ramp less often')

  // Too small to need the sweep: this derives an empty schedule. If the radius
  // were dropped from the cache key it would be handed the fine ramp's fractions.
  const blunt = wrappedSweepSampleFractions(sizing.grid, sizing.move, 0.2)
  assert.equal(resized.length, 3, 'a different cutter radius must derive a new schedule')
  assert.equal(blunt.length, 0, 'a cutter that needs no sweep derives an empty schedule')
  setSweepScheduleObserver(null)

  // Collection is passive: the same job played with it on and off leaves the grid
  // byte-identical. The two runs use distinct source-move identities so each
  // derives its own schedule rather than sharing a warmed cache entry.
  const collected = rampFixture()
  const plain = rampFixture()
  assert.notEqual(collected.move, plain.move, 'fixture: the two runs must not share a cache entry')
  setSweepScheduleObserver(() => { /* presence is all this run needs */ })
  const collectedGrid = playRamp(collected).grid
  setSweepScheduleObserver(null)
  const plainGrid = playRamp(plain).grid
  assert.equal(
    Buffer.compare(Buffer.from(collectedGrid.topZ.buffer), Buffer.from(plainGrid.topZ.buffer)),
    0,
    'collecting schedule derivations must leave the simulation grid byte-identical',
  )

  console.log(
    `ramp schedule derivations: PASSED (1 derivation across ${playback.frames} frames, `
    + `${rampRemoved} cells removed)`,
  )
}

/**
 * The CAM Add workload (issue #1112 review P2): rough keeps the seeded flat
 * cutter, finish imports a ball endmill from the bundled library. Its library
 * stepover is far finer than the seeded flat's, so this is the motion the
 * browser smoke test actually plays — and it must still produce a real
 * playback result: the prior rough as the starting stock, then more removal by
 * the finish, with the batch result agreeing that material was cut.
 */
function testLibraryAddedPlayback(): void {
  console.log('Testing the CAM Add library ball-finish playback result...')
  const job = squareToRoundJob(true)
  const buildOptions = simulationBuildOptions(job.setupInput, DETAIL_CELLS)
  const baseGrid = priorReplayGrid(
    job.project,
    job.setupInput.operations,
    job.setupInput.toolpaths,
    job.finish.id,
    buildOptions,
  )
  assert(
    removedFromVirgin(baseGrid) > 0,
    'the playback starting grid carries the prior rough, not virgin stock',
  )
  const startingTopZ = baseGrid.topZ.slice()

  const lane = playbackLane(job, baseGrid, true)
  lane.setup()
  lane.run()
  const live = lane.liveGrid()
  assert(live, 'the library ball finish leaves a live playback grid')
  assert(
    removedAgainst(live, baseGrid) > 0,
    'the library ball finish playback removes material from the prior rough',
  )
  // The starting stock itself is untouched: a lane mutates a clone.
  assert(
    baseGrid.topZ.every((value, index) => value === startingTopZ[index]),
    'playback did not consume the starting grid',
  )

  // The batch selected result the panel shows must agree that the job cuts.
  const batch = computeSimulationResult({
    setupInput: job.setupInput,
    project: job.project,
    simulationMode: 'selected',
    simulationDetailCells: DETAIL_CELLS,
    selectedInSetup: job.finish,
    paths: job.setupInput.toolpaths,
  })
  assert(batch.stats.removedCellCount > 0, 'the selected library ball finish removes material')

  console.log(`library ball-finish playback: PASSED (${removedAgainst(live, baseGrid)} cells removed)`)
}

// The deterministic guard runs first: its counts must be printed even when the
// load-sensitive timing assertion (still on until issue #1111 slice pg-b puts it
// behind an explicit flag) ends the run.
testRampScheduleGuard()
testSquarePlaybackTiming()
testLibraryAddedPlayback()
console.log('\nAll square playback cost tests PASSED.')
