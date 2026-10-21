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
 * guarded here as a ratio against invariant work, never a millisecond budget
 * (docs/PERF_ASSERTIONS.md).
 *
 * The subject is the real job: the sheet the app builds for the finish, the
 * prior-rough replay as its starting stock, and every frame the viewport's
 * `PlaybackController` would run. The reference is the **same** source moves
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
import { squareStock } from '../../types/barStock'
import { defaultTool, newProject } from '../../types/project'
import type { Operation, Project } from '../../types/project'
import { planRotarySolid } from '../../store/helpers/rotarySolids'
import { defaultRoundWorkholding } from '../../store/helpers/roundWorkholding'
import type { SelectionState } from '../../store/types'
import { computeOperationToolpath } from '../toolpaths/generateOperation'
import { buildSimulationSetupInput } from '../../app/simulationSetup'
import type { SimulationSetupInput } from '../../app/simulationSetup'
import {
  priorReplayGrid,
  simulationBuildOptions,
} from '../../app/simulationCompute'
import { cpuRatio } from '../../test/cpuRatio'
import { PlaybackController, cloneSimulationGrid } from './playback'
import type { PlaybackOptions, PlaybackToolInfo } from './playback'
import type { ToolpathResult } from '../toolpaths/types'
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

/** The exact job the browser smoke test seeds, through the app's own code. */
function squareToRoundJob(): SquareJob {
  const seeded = seededSquareProject()
  const plan = planRotarySolid(seeded, EMPTY_SELECTION, {
    kind: 'square-to-round',
    diameter: 20,
    alongStart: 10,
    alongEnd: 40,
    toolRef: 't1',
  })
  assert(plan.ok, 'fixture: the Square-to-round dialog must create the job')
  const project = plan.project
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
  assert(toolRecord && toolRecord.type === 'flat_endmill', 'fixture: the finish uses the flat cutter')

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

  // Warm the JIT outside the measured region.
  wrapped.setup()
  wrapped.run()
  flat.setup()
  flat.run()

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
  const countCut = (grid: SimulationGrid): number => {
    let cut = 0
    for (let index = 0; index < grid.topZ.length; index += 1) {
      if (grid.topZ[index] < baseGrid.topZ[index] - 1e-9) cut += 1
    }
    return cut
  }
  const wrappedGrid = wrapped.liveGrid()
  const flatGrid = flat.liveGrid()
  assert(wrappedGrid && flatGrid, 'lanes: the measured runs left a live grid')
  const wrappedCut = countCut(wrappedGrid)
  const flatCut = countCut(flatGrid)
  assert(wrappedCut > 0, 'fixture: the wrapped playback must remove material')
  assert(flatCut > 0, 'fixture: the flat reference playback must remove material')

  console.log(`square-to-round playback timing: PASSED (${wrappedCut} cells removed)`)
}

testSquarePlaybackTiming()
console.log('\nAll square playback cost tests PASSED.')
