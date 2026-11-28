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
 * The exported program of one operation, read back as project-space motion
 * (issue #1261, slice 1 of #1267). Approach after #1264 (jrussellsmyth).
 *
 * `exportOperationMotion` posts one operation on its own — no tool change, no
 * coolant — parses the program in the definition's own dialect (canned cycles
 * expanded as this controller runs them), flattens every arc in machine space
 * within the export tolerance, and maps each point back to project space with
 * `machineToProjectPoint`, through the operation's setup frame and the rotary
 * angle. The result is `ToolpathMove[]` the simulation replays directly, plus
 * the feed each move ran at, a status, and the reasons for it as structured
 * codes (never English text).
 *
 * Two things a program cannot say are filled from the operation's own
 * toolpath, and reported as `info`:
 * - a machine axis the program never states (a borrowed rotary motor's
 *   letter, or a cross axis held by touch-off, #1156): `axisNotStated`;
 * - the opening turn of a manual-index bar program (#1054 slice 2b) — the
 *   setup frame already is that turn, so it is taken out of every angle:
 *   `manualIndexTurnRemoved`.
 *
 * After a probe and touch-off (a plasma pierce, #983) the program's Z is
 * measured from the probed surface; it is mapped back from the sheet's own
 * height, the stock top, exactly as the emitter measured it.
 */

import { findOperationTool } from '../../toolPolicy'
import { isBarStock } from '../../types/barStock'
import type { Operation, Project } from '../../types/project'
import { exportGeometryTolerance } from '../../utils/units'
import { setupFrameForOperation } from '../setupOrientation'
import { normalizeToolForProject } from '../toolpaths/geometry'
import type { NormalizedTool, ToolpathMove, ToolpathPoint, ToolpathResult } from '../toolpaths/types'
import type { ToolpathWarning } from '../toolpaths/warningCodes'
import type { GcodeParseNoteCode, GcodeParseStatus, ParsedArcMove, ParsedGcodeMove } from './gcodeMotionParser'
import { parseExportedMotion } from './motionDebug'
import { runPostProcessor } from './postprocessor'
import { pinRotaryAxis, rotaryDirection } from './types'
import type { MachineDefinition, PinnedMachineDefinition } from './types'
import { machineToProjectPoint, projectToMachinePoint } from './utils'

export type ExportedMotionStatus = GcodeParseStatus

/** Why an exported read-back has the status it has. Stable; translated in the UI. */
export type ExportedMotionReasonCode =
  /** A finding of the dialect's parser (see `GcodeParseNoteCode`). */
  | GcodeParseNoteCode
  /** The postprocessor wrote no program; `postWarnings` says why. */
  | 'emptyProgram'
  /**
   * The program has no feed move for an operation whose toolpath has some,
   * and the postprocessor said why (`postWarnings`): it refused the operation.
   * Without a warning the same gap is a deviation, not a refusal.
   */
  | 'operationRefused'
  /** The postprocessor threw. */
  | 'postFailed'
  /** The operation has no usable tool, so it cannot be posted. */
  | 'noTool'
  /** The program never states this machine axis; its value came from the toolpath. */
  | 'axisNotStated'
  /** The manual-index opening turn was taken out of the angles (the setup frame is that turn). */
  | 'manualIndexTurnRemoved'

export interface ExportedMotionReason {
  code: ExportedMotionReasonCode
  /** `info` leaves the status alone; `unsupported` / `failed` set it. */
  severity: 'info' | 'unsupported' | 'failed'
  /** First one-based program line the reason was found on. */
  line?: number
  /** How many times it was found; the reason is listed once. */
  count: number
  /** The command it is about (`G73`, `G91`, …), when there is one. */
  command?: string
  /** The machine axis it is about, for `axisNotStated`. */
  axis?: 'x' | 'y' | 'z'
}

/**
 * A move of the exported program in project space. It is a `ToolpathMove`, so
 * the simulation replays it as is; the feed it ran at rides along.
 */
export interface ExportedToolpathMove extends ToolpathMove {
  /** Ordinary feed in program (= project) units per minute. Absent on rapids. */
  feed?: number
  /** Inverse-time F (1/min) of a turning feed move; see `ParsedLinearMove`. */
  inverseTimeFeed?: number
  /** A rapid after a machine-coordinate retract, whose real Z is the machine's. */
  workZUnknown?: boolean
}

export interface ExportedOperationMotion {
  operationId: string
  /** The program text, in the definition's output dialect. */
  program: string
  /** Project-space motion, arcs flattened. Replayable by `src/engine/simulation`. */
  moves: ExportedToolpathMove[]
  status: ExportedMotionStatus
  reasons: ExportedMotionReason[]
  /** The postprocessor's own structured warnings for this operation. */
  postWarnings: ToolpathWarning[]
}

export interface ExportOperationMotionArgs {
  project: Project
  operation: Operation
  /** The operation's generated toolpath, in stock space. */
  toolpath: ToolpathResult
  definition: MachineDefinition
  /** The operation's tool; resolved from the project when omitted. */
  tool?: NormalizedTool
}

const STATUS_RANK: Record<ExportedMotionStatus, number> = { verified: 0, unsupported: 1, failed: 2 }

function statusOf(reasons: readonly ExportedMotionReason[]): ExportedMotionStatus {
  let status: ExportedMotionStatus = 'verified'
  for (const reason of reasons) {
    if (reason.severity === 'info') continue
    const next: ExportedMotionStatus = reason.severity
    if (STATUS_RANK[next] > STATUS_RANK[status]) status = next
  }
  return status
}

/** Collects reasons, listing each code/command/axis once with a count. */
class ReasonList {
  readonly items: ExportedMotionReason[] = []

  add(reason: Omit<ExportedMotionReason, 'count'>): void {
    const existing = this.items.find((item) => item.code === reason.code
      && item.command === reason.command && item.axis === reason.axis && item.severity === reason.severity)
    if (existing) {
      existing.count += 1
      return
    }
    this.items.push({ ...reason, count: 1 })
  }
}

/**
 * Points along a parsed arc in machine space, the chord error at most
 * `tolerance`. Z is interpolated (a helical arc), the angle held: the fitter
 * only fits arcs at one angle.
 */
export function flattenParsedArc(move: ParsedArcMove, tolerance: number): ToolpathPoint[] {
  const { from, to, center, clockwise } = move
  const radius = Math.hypot(from.x - center.x, from.y - center.y)
  if (!(radius > 1e-9)) return [from, to]
  const a0 = Math.atan2(from.y - center.y, from.x - center.x)
  const a1 = Math.atan2(to.y - center.y, to.x - center.x)
  let sweep = a1 - a0
  const closed = Math.hypot(to.x - from.x, to.y - from.y) <= 1e-9
  if (clockwise) {
    while (sweep >= 0) sweep -= Math.PI * 2
    if (closed) sweep = -Math.PI * 2
  } else {
    while (sweep <= 0) sweep += Math.PI * 2
    if (closed) sweep = Math.PI * 2
  }
  // The chord of angle θ deviates r(1 − cos(θ/2)) from the arc.
  const step = tolerance > 0 && tolerance < radius ? 2 * Math.acos(1 - tolerance / radius) : Math.PI / 2
  const steps = Math.min(100000, Math.max(1, Math.ceil(Math.abs(sweep) / Math.min(step, Math.PI / 2))))
  const points: ToolpathPoint[] = [from]
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps
    const angle = a0 + sweep * t
    const point: ToolpathPoint = {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
      z: from.z + (to.z - from.z) * t,
    }
    if (from.a !== undefined) point.a = from.a
    points.push(point)
  }
  points.push(to)
  return points
}

function toolpathCarriesAngle(toolpath: ToolpathResult): boolean {
  return toolpath.moves.some((move) => move.from.a !== undefined || move.to.a !== undefined)
}

/** The first point of the toolpath, or of its first drill hole. */
function firstToolpathPoint(toolpath: ToolpathResult): ToolpathPoint | null {
  const move = toolpath.moves.find((candidate) => candidate.kind !== 'rapid') ?? toolpath.moves[0]
  if (move) return move.from
  const cycle = toolpath.drillCycles?.[0]
  return cycle ? { x: cycle.x, y: cycle.y, z: cycle.clearZ } : null
}

/**
 * Post one operation, read its program back and map it to project space.
 * Never throws: a postprocessor failure comes back as `failed` with a reason.
 */
export function exportOperationMotion(args: ExportOperationMotionArgs): ExportedOperationMotion {
  const { project, operation, toolpath, definition } = args
  const reasons = new ReasonList()
  const result = (program: string, moves: ExportedToolpathMove[], postWarnings: ToolpathWarning[]): ExportedOperationMotion => ({
    operationId: operation.id,
    program,
    moves,
    status: statusOf(reasons.items),
    reasons: reasons.items,
    postWarnings,
  })

  const rawTool = args.tool ? null : findOperationTool(project, operation)
  const tool = args.tool ?? (rawTool ? normalizeToolForProject(rawTool, project) : null)
  if (tool === null) {
    reasons.add({ code: 'noTool', severity: 'failed' })
    return result('', [], [])
  }

  let program: string
  let postWarnings: ToolpathWarning[]
  try {
    const posted = runPostProcessor({
      project,
      definition,
      operations: [{ operation, tool, toolpath }],
      options: { emitToolChanges: false, emitCoolant: false, programName: operation.name },
    })
    program = posted.gcode
    postWarnings = posted.warnings
  } catch {
    reasons.add({ code: 'postFailed', severity: 'failed' })
    return result('', [], [])
  }
  if (program.trim().length === 0) {
    reasons.add({ code: 'emptyProgram', severity: 'failed' })
    return result(program, [], postWarnings)
  }

  const pinned = pinRotaryAxis(definition, project.stock)
  const parsed = parseExportedMotion(program, pinned)
  for (const note of parsed.notes ?? []) {
    reasons.add({ code: note.code, severity: note.severity, line: note.line, ...(note.command ? { command: note.command } : null) })
  }
  // A parser that sets no note but downgrades still downgrades.
  if (parsed.status !== 'verified' && (parsed.notes ?? []).every((note) => note.severity === 'info')) {
    reasons.add({ code: 'unsupportedStatement', severity: parsed.status })
  }

  const moves = mapParsedMoves(parsed.moves, parsed.statedAxes, {
    project, operation, toolpath, pinned, reasons,
  })
  const exportedFeeds = moves.some((move) => move.kind !== 'rapid')
  const internalFeeds = toolpath.moves.some((move) => move.kind !== 'rapid') || (toolpath.drillCycles?.length ?? 0) > 0
  if (!exportedFeeds && internalFeeds && postWarnings.length > 0) {
    reasons.add({ code: 'operationRefused', severity: 'failed' })
  }
  return result(program, moves, postWarnings)
}

interface MapContext {
  project: Project
  operation: Operation
  toolpath: ToolpathResult
  pinned: PinnedMachineDefinition
  reasons: ReasonList
}

function mapParsedMoves(
  parsedMoves: readonly ParsedGcodeMove[],
  statedAxes: { x: boolean; y: boolean; z: boolean } | undefined,
  context: MapContext,
): ExportedToolpathMove[] {
  const { project, operation, toolpath, pinned, reasons } = context
  const setup = setupFrameForOperation(project, operation)
  // Arcs are flattened well inside the export tolerance, so the flattening
  // never reads as a deviation of its own.
  const chordTolerance = exportGeometryTolerance(project.meta.units) / 2

  // A machine axis the program never states is where the controller already
  // was; the operation's own toolpath says where that is meant to be.
  const first = firstToolpathPoint(toolpath)
  const expectedMachine = first ? projectToMachinePoint(first, project.origin, pinned, setup) : null
  const unstated = (['x', 'y', 'z'] as const).filter((axis) => statedAxes !== undefined && !statedAxes[axis])
  if (parsedMoves.length > 0) {
    for (const axis of unstated) reasons.add({ code: 'axisNotStated', severity: 'info', axis })
  }

  // A manual-index bar program opens with the face's own turn (#1054 slice
  // 2b); the setup frame below already turns the points, so the turn is taken
  // out of every angle. A toolpath that carries angles keeps them as written.
  const manualIndexAngle = pinned.rotary !== undefined && isBarStock(project.stock) && !toolpathCarriesAngle(toolpath)
    ? (setup?.orientation.angleDeg ?? 0) * rotaryDirection(pinned)
    : null
  let removedTurn = false

  // The machine Z of the sheet top: what a touch-off's surface was, before the
  // program re-zeroed Z on it.
  const surfaceZ = projectToMachinePoint({ x: 0, y: 0, z: project.stock.thickness }, project.origin, pinned, setup).z

  const toProject = (machine: ToolpathPoint, touchOffZ?: number): ToolpathPoint => {
    let point: ToolpathPoint = touchOffZ === undefined ? machine : { ...machine, z: machine.z - touchOffZ + surfaceZ }
    if (expectedMachine !== null && unstated.length > 0) {
      point = { ...point }
      for (const axis of unstated) point[axis] = expectedMachine[axis]
    }
    if (manualIndexAngle !== null && point.a !== undefined) {
      const rest = point.a - manualIndexAngle
      const { a: _a, ...withoutAngle } = point
      void _a
      removedTurn = true
      point = Math.abs(rest) < 1e-9 ? withoutAngle : { ...withoutAngle, a: rest }
    }
    return machineToProjectPoint(point, project.origin, pinned, setup)
  }

  const moves: ExportedToolpathMove[] = []
  for (const move of parsedMoves) {
    const feedFields: Pick<ExportedToolpathMove, 'feed' | 'inverseTimeFeed' | 'workZUnknown'> = {}
    if (move.kind !== 'rapid' && move.feed !== undefined) feedFields.feed = move.feed
    if (move.inverseTimeFeed !== undefined) feedFields.inverseTimeFeed = move.inverseTimeFeed
    if (move.kind !== 'arc' && move.workZUnknown) feedFields.workZUnknown = true

    if (move.kind === 'arc') {
      const points = flattenParsedArc(move, chordTolerance)
      let previous = toProject(points[0], move.touchOffZ)
      for (let i = 1; i < points.length; i += 1) {
        const next = toProject(points[i], move.touchOffZ)
        moves.push({ kind: 'cut', from: previous, to: next, ...feedFields })
        previous = next
      }
      continue
    }
    const from = toProject(move.from, move.touchOffZ)
    const to = toProject(move.to, move.touchOffZ)
    // A plunge is a feed straight down the tool axis — judged in machine
    // space, where "down" is the tool's own direction on every setup.
    const plunge = move.kind === 'linear'
      && Math.abs(move.from.x - move.to.x) <= 1e-9
      && Math.abs(move.from.y - move.to.y) <= 1e-9
      && move.to.z < move.from.z - 1e-9
      && move.from.a === move.to.a
    moves.push({
      kind: move.kind === 'rapid' ? 'rapid' : plunge ? 'plunge' : 'cut',
      from,
      to,
      ...feedFields,
    })
  }
  if (removedTurn && manualIndexAngle !== null && manualIndexAngle !== 0) {
    reasons.add({ code: 'manualIndexTurnRemoved', severity: 'info' })
  }
  return moves
}
