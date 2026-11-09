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
 * Whether the Exported Motion debug view can be opened for an operation, and
 * which view it opens on (issue #1179 correction round 3).
 *
 * The engine's own eligibility (`getExportedMotionEligibility`) answers "can
 * this be drawn as a flat 2.5D plan": it refuses variable-Z cutting. That is the
 * right question for the plan view and the wrong one for a rotary program,
 * whose Z varies by design (a rough steps radially, a finish follows the
 * model). A rotary program has a second view — the wrapped one — so the dialog
 * must open for it whatever its Z profile.
 *
 * The test is the motion itself, not the operation kind: any generated toolpath
 * whose points carry a rotary angle is wrapped. That also covers a rotary
 * project's wrapped flat work, which is the same shape of motion.
 */

import type { ToolpathMove, ToolpathPoint } from '../../engine/toolpaths/types'
import { getExportedMotionEligibility, type IneligibleReason } from '../../engine/gcode'

/** The shapes the eligibility helper accepts: a move list, or a toolpath result. */
export type InspectMotionSource =
  | ToolpathMove[]
  | { moves: ToolpathMove[]; drillCycles?: readonly unknown[] }

function movesOf(source: InspectMotionSource): ToolpathMove[] {
  return Array.isArray(source) ? source : source.moves
}

function hasAngle(point: ToolpathPoint): boolean {
  return point.a !== undefined && Number.isFinite(point.a)
}

/** True when any point of the motion carries a rotary angle. */
export function carriesRotaryAngles(source: InspectMotionSource): boolean {
  return movesOf(source).some((move) => hasAngle(move.from) || hasAngle(move.to))
}

export interface InspectMotionPlan {
  /** The Export dialog offers "Inspect exported motion". */
  offer: boolean
  /** The debug dialog must open on the 3D wrapped view. */
  wrapped: boolean
  /** Why motion without a rotary angle is refused; null when offered. */
  reason: IneligibleReason | null
}

/**
 * Decide the debug view for one operation's generated motion.
 *
 * A rotary motion is offered whatever its Z profile, because the wrapped view
 * draws it; only motion with nothing to draw stays refused. Everything without
 * a rotary angle keeps exactly the plan-view eligibility it had before, so a
 * flat variable-Z operation is still offered nothing.
 *
 * A canned-cycle trace stays refused even when it carries angles: the debug
 * dialog parses the emitted program, and a drill cycle is not a move it can
 * draw.
 */
export function planInspectMotion(source: InspectMotionSource): InspectMotionPlan {
  const drillCycles = Array.isArray(source) ? undefined : source.drillCycles
  if (drillCycles && drillCycles.length > 0) {
    return { offer: false, wrapped: false, reason: 'drilling' }
  }
  if (carriesRotaryAngles(source)) {
    const hasCut = movesOf(source).some((move) => move.kind === 'cut')
    return hasCut
      ? { offer: true, wrapped: true, reason: null }
      : { offer: false, wrapped: false, reason: 'noCutMoves' }
  }
  const eligibility = getExportedMotionEligibility(source as ToolpathMove[] | { moves: ToolpathMove[] })
  return { offer: eligibility.eligible, wrapped: false, reason: eligibility.reason ?? null }
}
