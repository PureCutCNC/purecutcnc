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

import { findOperationTool } from '../toolPolicy'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { SimulationPlaybackInput, SimulationSetupPicker } from '../components/simulation/SimulationViewport'
import type { FlatRoundBarDescriptor, SimulationGrid, SimulationResult } from '../engine/simulation'
import type { ToolpathResult } from '../engine/toolpaths'
import { normalizeToolForProject } from '../engine/toolpaths/geometry'
import { setupFace } from '../engine/setupOrientation'
import type { Clamp, Operation, Project, Stock } from '../types/project'
import { isSquareStock } from '../types/barStock'
import {
  computeSimulationResultAsync,
  priorReplayGrid,
  simulationBuildOptions,
  type SimulationResultInput,
} from './simulationCompute'
import {
  applySimulationBuild,
  simulationResultForInput,
  type SimulationBuild,
} from './simulationBuild'
import {
  buildSimulationSetupInput,
  resolveSimulationSetup,
  setupOperations,
  simulationSetups,
  type SimulationSetupInput,
  type SimulationBar,
} from './simulationSetup'

// The pure computation lives in `simulationCompute.ts` so the focused wiring
// tests can call it without rendering the hook. It is re-exported here because
// this hook is where every simulation consumer and its test already look for
// it.
export { computeSimulationResult } from './simulationCompute'
export type { SimulationResultInput } from './simulationCompute'

/** Stable empty set, so "nothing to acquire" does not churn the memos below. */
const NO_PATHS: ReadonlyMap<string, ToolpathResult> = new Map()

/** Defer a computation to first call and cache the result for later calls. */
function lazyOnce<T>(compute: () => T): () => T {
  let cached: { value: T } | null = null
  return () => {
    if (cached === null) {
      cached = { value: compute() }
    }
    return cached.value
  }
}

/**
 * A setup's operations, or none when an operation names a setup the project
 * does not define. The export refuses such a project; the simulation shows
 * nothing for it rather than taking the workspace down.
 */
function scopedOperations(project: Project, setup: Parameters<typeof setupOperations>[1]): Operation[] {
  try {
    return setupOperations(project, setup)
  } catch {
    return []
  }
}

interface UseSimulationModelArgs {
  project: Project
  centerTab: 'sketch' | 'preview3d' | 'simulation'
  simulationMode: 'selected' | 'visible'
  simulationDetailCells: number
  selectedOperation: Operation | null
  selectedToolpath: ToolpathResult | null
  /** Async acquisition (issue #675). Resolves null when the path cannot be produced. */
  requestToolpath: (
    operationId: string,
    purpose: 'simulation',
    signal?: AbortSignal,
  ) => Promise<ToolpathResult | null>
}

export function useSimulationModel({
  project,
  centerTab,
  simulationMode,
  simulationDetailCells,
  selectedOperation,
  selectedToolpath,
  requestToolpath,
}: UseSimulationModelArgs): {
  simulationResult: SimulationResult | null
  simulationOperationCount: number
  simulationPlaybackInput: SimulationPlaybackInput | null
  /** True while the paths simulation needs are still being produced. */
  simulationInputPending: boolean
  /** The setups the simulation can show, and which one it shows (issue #947). */
  simulationSetupPicker: SimulationSetupPicker
  /** Visible clamps, placed where they sit in the simulated setup's frame. */
  simulationClamps: Clamp[]
  /**
   * The stock a flat setup draws. An Around setup's heightfield still replays
   * on the unrolled sheet's block, but the viewport draws the real round bar
   * for it, through `simulationBar` (issue #395).
   */
  simulationStock: Stock
  simulationBar?: SimulationBar
  /**
   * A flat Top/Bottom setup's round-bar profile (issue #1049). The viewport
   * mounts its static lower half below the heightfield's machinable upper
   * half. Absent for a block, a square blank and an Around setup.
   */
  simulationFlatRoundBar?: FlatRoundBarDescriptor
} {
  /**
   * The simulated setup (issue #947). A pick from the panel holds while the
   * same operation stays selected; selecting another operation hands the
   * choice back to `resolveSimulationSetup`, which follows that operation's
   * setup — so selecting a Bottom operation never shows it on Top stock.
   */
  const [choice, setChoice] = useState<{ setupId: string; operationId: string | null } | null>(null)
  const selectedOperationId = selectedOperation?.id ?? null
  // Dropped, not just ignored, once the selection moves on: reselecting the
  // operation the pick was made with must not bring a stale pick back.
  if (choice !== null && choice.operationId !== selectedOperationId) setChoice(null)
  const chosenSetupId = choice !== null && choice.operationId === selectedOperationId ? choice.setupId : null
  const simulationSetup = useMemo(
    () => resolveSimulationSetup(project, chosenSetupId, selectedOperation),
    [chosenSetupId, project, selectedOperation],
  )
  const setupScopedOperations = useMemo(
    () => scopedOperations(project, simulationSetup),
    [project, simulationSetup],
  )
  // The selected operation takes part only when it is cut in the simulated
  // setup. One from another setup would be simulated on the wrong face.
  const selectedInSetup = selectedOperation && setupScopedOperations.some((operation) => operation.id === selectedOperation.id)
    ? selectedOperation
    : null
  const selectedCanonicalToolpath = selectedInSetup ? selectedToolpath : null

  /**
   * The toolpaths simulation needs, acquired in an effect (issue #675).
   *
   * Simulation used to generate during render, which is exactly what a worker
   * boundary makes impossible: the answer no longer arrives in the same tick as
   * the question. Acquiring here keeps generation out of render *and* out of the
   * playback callback — the base-grid supplier below closes over what has
   * already been resolved and can never start work of its own.
   *
   * Each set is stamped with the project revision and the requirement it
   * answers, so a set acquired for an older revision — or for another setup or
   * selection of the same revision (issue #947: the picker changes the
   * requirement without changing the project) — is never mixed into the
   * simulation now asked for.
   */
  const [acquired, setAcquired] = useState<{ project: Project; requiredKey: string; paths: Map<string, ToolpathResult> } | null>(null)

  // Every operation simulation may need: the visible set for 'visible' mode,
  // and the prior operations for 'selected' playback's starting stock.
  const requiredOperationIds = useMemo(() => {
    if (centerTab !== 'simulation') return []
    const eligible = (operation: Operation): boolean =>
      operation.enabled && operation.showToolpath && findOperationTool(project, operation) !== null
    // Only the simulated setup's operations: each setup starts from fresh
    // stock, so another setup's cuts are never part of its starting state.
    if (simulationMode === 'visible') {
      return setupScopedOperations.filter(eligible).map((operation) => operation.id)
    }
    if (!selectedInSetup) return []
    const selectedIndex = setupScopedOperations.findIndex((operation) => operation.id === selectedInSetup.id)
    const prior = selectedIndex >= 0 ? setupScopedOperations.slice(0, selectedIndex) : []
    return prior.filter(eligible).map((operation) => operation.id)
  }, [centerTab, project, selectedInSetup, setupScopedOperations, simulationMode])

  const requiredKey = requiredOperationIds.join(',')

  useEffect(() => {
    if (centerTab !== 'simulation') {
      setAcquired(null)
      return
    }
    const controller = new AbortController()
    let cancelled = false
    void (async () => {
      const entries = await Promise.all(requiredOperationIds.map(async (operationId) => ({
        operationId,
        toolpath: await requestToolpath(operationId, 'simulation', controller.signal),
      })))
      if (cancelled) return
      const paths = new Map<string, ToolpathResult>()
      for (const { operationId, toolpath } of entries) {
        if (toolpath) paths.set(operationId, toolpath)
      }
      setAcquired({ project, requiredKey, paths })
    })()
    return () => {
      cancelled = true
      controller.abort()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- requiredKey stands in for the id list; `project` identity is what a re-acquire keys on
  }, [centerTab, requiredKey, project, requestToolpath])

  // Only paths acquired for *this* project revision and requirement may be used. A pending or
  // superseded acquisition leaves this null, which is what stops a playback
  // starting on a mixed input set.
  //
  // An empty requirement is already satisfied: a selected operation with no
  // prior operations has nothing to wait for, and making it wait for an effect
  // would delay playback for the commonest case in the name of a dependency
  // that does not exist.
  const paths: ReadonlyMap<string, ToolpathResult> | null = requiredOperationIds.length === 0
    ? NO_PATHS
    : acquired && acquired.project === project && acquired.requiredKey === requiredKey ? acquired.paths : null

  /**
   * Everything below reads the simulated setup's frame (issue #947): the
   * acquired stock-space paths, and the selected operation's path, are turned
   * into it once here and nowhere else. Paths still being acquired are simply
   * absent, as they were before setups.
   */
  const setupInput = useMemo<SimulationSetupInput | null>(() => {
    if (centerTab !== 'simulation') return null
    const canonical = new Map(paths ?? NO_PATHS)
    // The selected path is the preview's; an acquired one always wins over it.
    if (selectedInSetup && selectedCanonicalToolpath && !canonical.has(selectedInSetup.id)) {
      canonical.set(selectedInSetup.id, selectedCanonicalToolpath)
    }
    try {
      return buildSimulationSetupInput(project, simulationSetup, canonical)
    } catch (error) {
      // A square blank's actual material has no flat fallback: propagating
      // here reaches the app's existing error surface instead of drawing a
      // successful uncut sheet. Round keeps its established null result.
      if (isSquareStock(project.stock)) throw error
      return null
    }
  }, [centerTab, paths, project, selectedCanonicalToolpath, selectedInSetup, simulationSetup])

  // The render that opens the tab must be the one that commits it. The result
  // is built in an effect, in yielding slices (issue #1112 review P1), so a
  // heavy selected operation never runs inside a render; the panel shows its
  // loading overlay until the build for *these* inputs lands.
  const simulationBuildInput = useMemo<SimulationResultInput | null>(() => {
    if (centerTab !== 'simulation' || paths === null) {
      return null
    }
    return {
      setupInput,
      project,
      simulationMode,
      simulationDetailCells,
      selectedInSetup,
      paths,
    }
  }, [centerTab, paths, project, selectedInSetup, setupInput, simulationDetailCells, simulationMode])

  const [simulationBuild, setSimulationBuild] = useState<SimulationBuild | null>(null)
  /**
   * The inputs a completion is judged against. Written in a layout effect, not
   * during render: a render React discards must not move the target. A
   * completion that lands between commit and this line is judged against the
   * previous request and dropped, which is the conservative direction — it can
   * never install a result the current selection no longer describes.
   */
  const requestedBuildInput = useRef<SimulationResultInput | null>(simulationBuildInput)
  useLayoutEffect(() => {
    requestedBuildInput.current = simulationBuildInput
  }, [simulationBuildInput])

  useEffect(() => {
    if (simulationBuildInput === null) return
    if (simulationBuild !== null && simulationBuild.input === simulationBuildInput) return
    const controller = new AbortController()
    let cancelled = false
    void computeSimulationResultAsync(simulationBuildInput, { signal: controller.signal })
      .then((result) => {
        if (cancelled || result === null) return
        setSimulationBuild((previous) => applySimulationBuild(
          previous,
          requestedBuildInput.current,
          simulationBuildInput,
          result,
        ))
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [simulationBuild, simulationBuildInput])

  const simulationResult = simulationResultForInput(simulationBuild, simulationBuildInput)

  // A path acquisition and a build that has not produced this input's result
  // are both waits; the panel shows one spinner for either.
  const simulationInputPending = centerTab === 'simulation' && simulationResult === null

  const simulationOperationCount = useMemo(() => {
    if (simulationMode === 'selected') {
      return selectedInSetup && selectedCanonicalToolpath ? 1 : 0
    }

    return setupScopedOperations.filter((operation) => operation.enabled && operation.showToolpath).length
  }, [selectedCanonicalToolpath, selectedInSetup, setupScopedOperations, simulationMode])

  const simulationPlaybackInput = useMemo<SimulationPlaybackInput | null>(() => {
    if (centerTab !== 'simulation' || simulationMode !== 'selected' || !setupInput) {
      return null
    }
    const localProject = setupInput.project
    const selectedLocalToolpath = selectedInSetup ? setupInput.toolpaths.get(selectedInSetup.id) ?? null : null
    if (!selectedInSetup || !selectedLocalToolpath || !findOperationTool(localProject, selectedInSetup)) {
      return null
    }
    const toolRecord = findOperationTool(localProject, selectedInSetup)
    if (!toolRecord || toolRecord.type === 'drill') {
      return null
    }

    // No playback until every prior operation's path is in hand. Handing the
    // viewport a supplier that would have to generate is what put generation on
    // the playback path in the first place.
    if (paths === null) {
      return null
    }

    const normalizedSelectedTool = normalizeToolForProject(toolRecord, localProject)

    // Starting stock state for playback: the simulated setup's operations
    // BEFORE the selected one, replayed into a fresh grid — operations listed
    // after the selection haven't run yet at this point in the cycle, so their
    // cuts shouldn't appear, and another setup's never do (fresh stock,
    // issue #947).
    //
    // The replay is deferred until the viewport actually starts playback
    // (`lazyOnce`): while the simulation tab is open this memo re-runs on every
    // project change, and eagerly replaying prior operations each time made
    // ordinary edits pay for a full heightfield replay. Every stock shape,
    // square included, replays through this same deferred in-thread path
    // (issue #1016 C2).
    const getBaseGrid: () => SimulationGrid = lazyOnce((): SimulationGrid => priorReplayGrid(
      localProject,
      setupInput.operations,
      setupInput.toolpaths,
      selectedInSetup.id,
      simulationBuildOptions(setupInput, simulationDetailCells),
    ))

    const diameter = normalizedSelectedTool.radius * 2
    // Both maxCutDepth and diameter come from `normalizeToolForProject`, so they're
    // already in project units — mm or inch, whichever the project uses. All the
    // derived dimensions below stay unit-agnostic by staying diameter-relative.
    const toolCutLength = normalizedSelectedTool.maxCutDepth > 0
      ? normalizedSelectedTool.maxCutDepth
      : diameter * 3
    const toolShankLength = diameter * 2
    // Split long source moves so a single move's cell-loop bounding box stays
    // close to the swept path (long diagonals would otherwise test a huge
    // rectangle). Correctness doesn't depend on the length — the controller
    // applies partial moves exactly — so the trade-off is pure overhead: every
    // sub-segment re-tests the tool-radius end caps it shares with its
    // neighbors. At 0.4× radius that overlap dominated (~5/6 of cell tests
    // were repeats); 2× radius keeps bounding boxes tight while cutting the
    // redundant work ~4×.
    const maxSegmentLength = normalizedSelectedTool.radius * 2

    // Operation feed is stored in project-units-per-minute. The viewport works in
    // units-per-second, so divide by 60. This becomes the "1×" playback speed so
    // users can intuitively speed up or slow down relative to the real feed rate.
    const feedPerSecond = selectedInSetup.feed > 0 ? selectedInSetup.feed / 60 : undefined
    const plungeFeedPerSecond = selectedInSetup.plungeFeed > 0 ? selectedInSetup.plungeFeed / 60 : undefined
    // `project.meta.units` uses 'inch'; the playback UI shows the short label 'in'.
    const units: 'mm' | 'in' = localProject.meta.units === 'inch' ? 'in' : 'mm'

    return {
      getBaseGrid,
      moves: selectedLocalToolpath.moves,
      toolType: toolRecord.type,
      toolRadius: normalizedSelectedTool.radius,
      vBitAngle: normalizedSelectedTool.vBitAngle,
      toolCutLength,
      toolShankLength,
      maxSegmentLength,
      units,
      feedPerSecond,
      plungeFeedPerSecond,
    }
  }, [centerTab, paths, selectedInSetup, setupInput, simulationDetailCells, simulationMode])

  const simulationSetupPicker = useMemo<SimulationSetupPicker>(() => ({
    options: simulationSetups(project).map((setup) => ({ id: setup.id, name: setup.name, face: setupFace(setup) })),
    selectedId: simulationSetup.id,
    onChange: (setupId: string) => setChoice({ setupId, operationId: selectedOperationId }),
  }), [project, selectedOperationId, simulationSetup.id])

  const simulationClamps = useMemo(
    () => (setupInput?.project ?? project).clamps.filter((clamp) => clamp.visible),
    [project, setupInput],
  )
  const simulationStock = useMemo(
    () => (setupInput?.project ?? project).stock,
    [project, setupInput],
  )

  return {
    simulationResult,
    simulationOperationCount,
    simulationPlaybackInput,
    simulationInputPending,
    simulationSetupPicker,
    simulationClamps,
    simulationStock,
    simulationBar: setupInput?.bar,
    simulationFlatRoundBar: setupInput?.flatRoundBar,
  }
}
