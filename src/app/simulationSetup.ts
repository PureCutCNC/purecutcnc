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
 * One setup's simulation input (issue #947).
 *
 * Simulation runs one setup at a time, in that setup's own frame, on fresh
 * stock. The operator does not load a new blank between setups — they turn
 * the same part over — so fresh stock is this simulation's approximation, not
 * the shop floor: what another setup removed is simply not shown. The
 * simulation panel says so wherever more than one setup exists. This module
 * is the whole of that decision. It is pure: it reads the project, the
 * generated stock-space toolpaths and the selected setup, and returns what
 * the existing heightfield engine consumes — a project in the setup-local
 * frame, that setup's operations in cut order, and those operations' paths
 * turned out of canonical stock space once.
 *
 * Nothing here generates, acquires or invents motion. A path the caller did
 * not hand in stays missing, exactly as a missing path is the consumer's
 * signal to wait or to skip; a display-only placeholder must never reach the
 * engine. The engine itself is unchanged: it only ever sees the top-down
 * frame, which for a Bottom setup is the stock turned over.
 *
 * The original project, map and path objects are never written to. For a
 * project with no Around feature — and for a Top setup in it — the project and
 * every individual path come back as the same objects,
 * so a project without a turned setup simulates exactly what it did before
 * setups existed; the returned map is always a new one, scoped to the
 * setup's operations, so another setup's paths cannot leak through it. A flat
 * setup drops the project's Around features (`flatFaceProject`): they belong
 * to the bar's unrolled sheet and have no place on its rectangle. A flat setup
 * of a round bar describes the bar's real rounded profile for the grid to seed
 * (issue #1049), so the simulation draws a bar rather than a block.
 */

import type { BarStock, Clamp, MachineOrigin, MachiningSetup, Operation, Project, RoundStock } from '../types/project'
import { isAroundSetup, isRoundStock } from '../types/project'
import { barCentre, barInscribedRadius, barLength, barPivotZ, isBarStock, isSquareStock } from '../types/barStock'
import type { ToolpathResult } from '../engine/toolpaths/types'
import { setupForOperation, setupFrame } from '../engine/setupOrientation'
import type { SetupFrame } from '../engine/setupOrientation'
import { projectInSetupFrame, toolpathInSetupFrame } from '../engine/setupFrameProject'
import { aroundFrame, aroundFrameForOperation, flatFaceProject, unrolledProject, unwrapToolpath } from '../engine/aroundFrame'
import { foldToolpath } from '../engine/aroundFold'
import type { AroundFrame } from '../engine/aroundFrame'
import { validateFlatRoundBar, validateSquareBar } from '../engine/simulation/grid'
import type { FlatRoundBarDescriptor, SquareBarDescriptor } from '../engine/simulation/types'
import { activeSetup } from '../store/helpers/activeFace'

/**
 * Real bar display data alongside the unchanged unrolled replay project. A
 * square blank is a bar too: it unrolls through the same nominal reference
 * cylinder, and the common heightfield renderer draws the blank's own seeded
 * cross section (issue #1016 C2).
 */
export interface SimulationBar {
  frame: AroundFrame
  stock: BarStock
  clamps: Clamp[]
  origin: MachineOrigin
}

export function buildSimulationBar(project: Project, frame: AroundFrame): SimulationBar | undefined {
  if (!isBarStock(project.stock)) return undefined
  return {
    frame,
    stock: project.stock,
    clamps: project.clamps.filter((clamp) => clamp.visible),
    origin: project.origin,
  }
}

/** Everything one setup's simulation needs, all of it in that setup's frame. */
export interface SimulationSetupInput {
  bar?: SimulationBar
  /**
   * The square blank's grid initialization input, present only when the real
   * stock is square (issue #1016 C2). `side` is the physical blank side and
   * `frame` is the nominal reference cylinder the unrolled sheet is framed in;
   * the true turning pivot stays `frame.radius = side/2`, never the corner
   * radius. It seeds each cell's starting radius in `createSimulationGrid` and
   * then leaves the picture — nothing downstream of initialization needs to
   * know the blank was square. Transient — never persisted.
   */
  squareBar?: SquareBarDescriptor
  /**
   * The round bar's real profile seen from a flat (Top or Bottom) setup
   * (issue #1049), present only when this setup is not an Around setup and the
   * setup-local stock is a round bar. `pivot`/`radius`/`centre`/`length` are
   * the bar's own geometry in that setup's frame; the descriptor seeds each
   * cell's starting height in `createSimulationGrid`, and the renderer reads the
   * same values to mount the static lower half below the equator. Transient —
   * never persisted.
   */
  flatRoundBar?: FlatRoundBarDescriptor
  /** The project turned into the setup's frame; the same object for Top. */
  project: Project
  /** The setup's operations, in the order they are cut, disabled and hidden included. */
  operations: Operation[]
  /** The acquired stock-space paths of those operations, turned once. Missing paths stay missing. */
  toolpaths: ReadonlyMap<string, ToolpathResult>
}

/**
 * The frame a setup turns the stock through, or undefined for Top. Reuses
 * `setupFrame`, so an orientation this build cannot machine is refused here
 * exactly as it is everywhere else. An Around setup is not a rotation: its
 * frame is the unroll frame resolved by the caller.
 */
function frameForSetup(setup: MachiningSetup, project: Pick<Project, 'stock'>): SetupFrame | undefined {
  return setup.orientation.angleDeg === 0 ? undefined : setupFrame(setup.orientation, project.stock)
}

/**
 * The unroll frame of an Around setup, or null when the project's stock is no
 * longer a round bar on the setup's axis. `aroundFrameForOperation` throws
 * for such a project, and a simulation must not: it reports no simulation for
 * that setup instead of raising out of a render pass.
 */
function aroundSimulationFrame(project: Project, operations: readonly Operation[], setup: MachiningSetup): AroundFrame | null {
  if (!isBarStock(project.stock) || setup.orientation.axis !== project.stock.axis) return null
  if (operations.length === 0) return aroundFrame(project.stock)
  for (const operation of operations) {
    try {
      const frame = aroundFrameForOperation(project, operation)
      if (frame) return frame
    } catch {
      return null
    }
  }
  return null
}

/**
 * The unrolled project as the Around simulation draws it (issue #395).
 * `unrolledProject` spreads a chuck or tailstock across every turn the job can
 * reach, because that is the keep-out volume the generators must respect. The
 * simulation draws the sheet, where the fixture is what it is there: a flat
 * band. Its footprint along the bar is the fixture's own extent; across, it is
 * clipped to the one circumference being simulated (`sheetStart`, the sheet's
 * first edge, to `sheetStart + circumference`); and its height is already
 * the fixture's height above the bar's surface, carried down by the radius.
 *
 * Only the across extent is rewritten here — the keep-out rectangle
 * `unrolledProject` hands the generators is untouched. The sheet's stock is a
 * block, so `buildClampMesh` draws the band with the ordinary clamp box rather
 * than the round bar's cylinder.
 */
function unrolledSimulationProject(project: Project, frame: AroundFrame): Project {
  const unrolled = unrolledProject(project, frame)
  const clamps: Clamp[] = unrolled.clamps.map((clamp) => frame.axis === 'x'
    ? { ...clamp, y: frame.sheetStart, h: frame.circumference }
    : { ...clamp, x: frame.sheetStart, w: frame.circumference })
  return { ...unrolled, clamps }
}

/**
 * Prepare one setup's simulation input.
 *
 * `toolpaths` holds every generated operation's result in canonical stock
 * space, by operation id — the map the preview and export already share. Only
 * the selected setup's operations are returned, and only the paths that are
 * actually in the map; the caller owns eligibility (`enabled`,
 * `showToolpath`, tool) exactly as it does today.
 *
 * A setup that is not one of `project.setups` — the provisional face the
 * workspace looks at before content lands on it — is valid and has no
 * operations of its own. Membership follows the same rule as the export and
 * the CAM panel: an operation whose `setupId` names a setup belongs to it,
 * and one with no `setupId` at all reads as Top. A `setupId` that names no
 * setup is an error, not a silent Top operation.
 *
 * An Around setup (issue #395) has no rotation frame: its job is the unrolled
 * sheet, so its project is the unrolled block one circumference across and one
 * radius thick, its Around features lowered onto it — and each of its paths is
 * `unwrapToolpath`ed and folded onto the first circumference of that sheet.
 * Its chuck and tailstock bands are
 * clipped to that one circumference (`unrolledSimulationProject`): the sheet is
 * what is drawn, not the whole multi-turn keep-out the generators use.
 * Everything downstream then cuts a flat job unchanged. An Around setup whose
 * bar is no longer a bar on its axis yields `null` — no simulation for that
 * setup — rather than throwing. A square blank is the exception: it has no
 * honest flat fallback (a flat sheet would report a successful uncut block for
 * a real square-to-round job), so a missing square Around frame throws and the
 * app's existing error surface reports it. The round behaviour is unchanged.
 *
 * A flat setup of a **round bar** also carries the bar's real profile
 * (`flatRoundBar`, issue #1049): its grid starts curved instead of as the
 * bounding block. A Bottom setup needs no special case — the setup turn is
 * already in `localProject`, and the bar is symmetric about its axis.
 */
export function buildSimulationSetupInput(
  project: Project,
  setup: MachiningSetup,
  toolpaths: ReadonlyMap<string, ToolpathResult>,
): SimulationSetupInput | null {
  const operations = setupOperations(project, setup)

  const around = isAroundSetup(setup) ? aroundSimulationFrame(project, operations, setup) : null
  if (isAroundSetup(setup) && !around) {
    // A square blank has no honest flat fallback: the flat sheet would draw an
    // uncut block that claims the job succeeded. Refuse loudly, reusing the
    // app's existing error surface, while a round bar keeps the established
    // "no simulation for this setup" result.
    if (isSquareStock(project.stock)) {
      throw new RangeError("The Around setup must match the square bar's axis.")
    }
    return null
  }

  const frame = around ? undefined : frameForSetup(setup, project)
  const localToolpaths = new Map<string, ToolpathResult>()
  for (const operation of operations) {
    const toolpath = toolpaths.get(operation.id)
    if (!toolpath) continue
    localToolpaths.set(
      operation.id,
      around ? foldToolpath(unwrapToolpath(toolpath, around), around) : toolpathInSetupFrame(toolpath, frame),
    )
  }

  // The real bar display data and, for a square blank, its grid initialization
  // input ride beside the unrolled block and its exact frozen Around frame
  // (issue #1016 C2-R2V). This is the one coordinate mapping: the descriptor's
  // frame is the sheet's, the pivot is `side/2`.
  const bar = around ? buildSimulationBar(project, around) : undefined
  const squareBar = around && bar && isSquareStock(bar.stock) ? squareBarFor(bar.stock, around) : undefined

  const localProject = around
    ? unrolledSimulationProject(project, around)
    : projectInSetupFrame(flatFaceProject(project), frame)

  // A flat setup of a round bar sees the bar's real rounded profile from
  // above, not its bounding-box block (issue #1049). The setup's own turn is
  // already baked into `localProject`, and a round bar is symmetric about its
  // axis, so a Bottom setup yields the same centreline and radius as Top.
  const flatRoundBar = !around && isRoundStock(localProject.stock)
    ? flatRoundBarFor(localProject.stock)
    : undefined

  return {
    project: localProject,
    operations,
    toolpaths: localToolpaths,
    ...(bar ? { bar } : {}),
    ...(squareBar ? { squareBar } : {}),
    ...(flatRoundBar ? { flatRoundBar } : {}),
  }
}

/**
 * The transient square grid-initialization descriptor for the real blank. It is
 * validated here, before any grid allocation, through the same helper
 * `createSimulationGrid` uses: a frame whose radius is not `side/2` (or a
 * non-finite side) must surface, never be approximated by the round sheet.
 */
function squareBarFor(stock: BarStock, frame: AroundFrame): SquareBarDescriptor {
  const descriptor: SquareBarDescriptor = { side: stock.thickness, frame }
  validateSquareBar(descriptor)
  return descriptor
}

/**
 * The transient flat round-bar grid-initialization descriptor for the real
 * bar in this setup's frame (issue #1049). It is validated here, before any
 * grid allocation, through the same helper `createSimulationGrid` uses, so a
 * malformed bar surfaces instead of seeding a plausible-looking surface.
 */
function flatRoundBarFor(stock: RoundStock): FlatRoundBarDescriptor {
  const descriptor: FlatRoundBarDescriptor = {
    axis: stock.axis,
    pivot: barPivotZ(stock),
    radius: barInscribedRadius(stock),
    centre: barCentre(stock),
    length: barLength(stock),
  }
  validateFlatRoundBar(descriptor)
  return descriptor
}

/**
 * The setups a simulation can run: the project's own, in program order, plus
 * the provisional one the workspace is looking at when the project has no
 * setup for that face yet — the same list the CAM panel shows as sections.
 */
export function simulationSetups(project: Project): MachiningSetup[] {
  const saved = project.setups ?? []
  const current = activeSetup(project)
  return saved.some((entry) => entry.id === current.id) ? saved : [...saved, current]
}

/**
 * A setup's operations in cut order. Membership follows the export and the
 * CAM panel: an operation whose `setupId` names a setup belongs to it, and
 * one with no `setupId` reads as the project's first setup (Top). Throws for
 * a `setupId` that names no setup.
 */
export function setupOperations(project: Project, setup: MachiningSetup): Operation[] {
  const saved = project.setups ?? []
  // The legacy fallback is the project's first setup, matching the export and
  // the CAM panel. A provisional setup the project does not hold yet is
  // appended so it can still be told apart from that first setup.
  const setups = saved.some((entry) => entry.id === setup.id) ? saved : [...saved, setup]
  const topSetup = setups[0]
  return project.operations.filter((operation) => {
    // Throws for an operation naming a setup the project does not define.
    const operationSetup = setupForOperation(project, operation)
    return (operationSetup ?? topSetup)?.id === setup.id
  })
}

