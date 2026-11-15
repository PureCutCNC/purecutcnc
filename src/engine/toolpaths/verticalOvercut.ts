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
 * Bounded vertical overcut for Edge Route operations (issue #834).
 *
 * An Edge Route may ask for its final bottom cut to go a little below the
 * intended bottom — to make sure a through cut parts cleanly despite stock
 * thickness, Z-zero and tool variation. The project sets the ceiling
 * (`ProjectMeta.maxSpoilboardCutDepth`, a distance below the nominal stock
 * bottom at Z 0) and each operation asks for an amount within it
 * (`Operation.verticalOvercut`).
 *
 * This is the single resolver. Generation, the tab pass, the postprocessor,
 * the CAM panel and the booklet all read it, so they cannot disagree about
 * whether an operation overcuts, by how much, or whether it is refused. A
 * value is never clamped: anything negative, non-finite or past the project
 * limit refuses the operation until the user corrects it.
 */

import type { Operation, Project } from '../../types/project'
import { formatLength, type Units } from '../../utils/units'
import type { ToolpathWarning } from './warningCodes'

/** Tolerance for comparing a requested overcut with the project limit. */
const LIMIT_EPSILON = 1e-9

export type VerticalOvercutInvalidReason = 'negative' | 'nonFinite' | 'overLimit' | 'limitInvalid'

export type VerticalOvercutStatus =
  /** No overcut: absent, zero, or not an Edge Route. Motion is unchanged. */
  | { kind: 'none' }
  /** A valid overcut, `amount` and `limit` both measured down from the stock bottom. */
  | { kind: 'ok'; amount: number; limit: number }
  /** A value that must not produce motion. `amount`/`limit` are raw inputs, possibly non-finite. */
  | { kind: 'invalid'; reason: VerticalOvercutInvalidReason; amount: unknown; limit: unknown }

export function isEdgeRouteKind(kind: Operation['kind']): boolean {
  return kind === 'edge_route_inside' || kind === 'edge_route_outside'
}

/**
 * The project's spoilboard limit as a usable number, or null when the stored
 * value is unusable (negative, non-finite, or not a number). Absent reads as 0.
 */
export function projectSpoilboardLimit(project: Pick<Project, 'meta'>): number | null {
  const raw: unknown = project.meta.maxSpoilboardCutDepth
  if (raw === undefined) return 0
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null
  return raw
}

export function resolveVerticalOvercut(project: Pick<Project, 'meta'>, operation: Operation): VerticalOvercutStatus {
  if (!isEdgeRouteKind(operation.kind)) return { kind: 'none' }
  const raw: unknown = operation.verticalOvercut
  if (raw === undefined || raw === 0) return { kind: 'none' }
  const limitRaw: unknown = project.meta.maxSpoilboardCutDepth
  // JSON turns NaN and Infinity into null, so a stored null is a non-finite value.
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { kind: 'invalid', reason: 'nonFinite', amount: raw, limit: limitRaw }
  }
  if (raw < 0) return { kind: 'invalid', reason: 'negative', amount: raw, limit: limitRaw }
  const limit = projectSpoilboardLimit(project)
  if (limit === null) return { kind: 'invalid', reason: 'limitInvalid', amount: raw, limit: limitRaw }
  if (raw > limit + LIMIT_EPSILON) return { kind: 'invalid', reason: 'overLimit', amount: raw, limit }
  return { kind: 'ok', amount: raw, limit }
}

/**
 * The stock bottom in the frame an Edge Route is generated in. Generation
 * always runs top-down on the operation's setup frame (`projectInSetupFrame`),
 * and every flat setup turns the stock about its mid-thickness, so the turned
 * stock still occupies `[0, thickness]`: the bottom is Z 0 in every setup.
 * Every overcut depth is measured from here, so this is the one place that
 * says where it is: the stock stores a thickness, never a bottom offset.
 */
export const STOCK_BOTTOM_Z = 0

/**
 * Whether a target whose nominal bottom is `nominalBottom` cuts through to the
 * stock bottom. Only such a target is overcut; a pocket-like target that stops
 * inside the material is left exactly as it was.
 */
export function cutsThroughStockBottom(nominalBottom: number, stockBottom: number): boolean {
  return nominalBottom <= stockBottom + LIMIT_EPSILON
}

/**
 * The final bottom an Edge Route cuts a descending target to (issue #834).
 *
 * - `nominalBottom` is the target's modelled bottom; `effectiveBottom` is the
 *   bottom it would cut to without overcut (the nominal raised by the axial
 *   stock to leave).
 * - A target that does not cut through to the stock bottom is not overcut.
 * - A through target's final level goes to `stockBottom - amount`, measured
 *   from the stock bottom, so the axial leave cannot eat into the overcut. A
 *   target modelled deeper than that keeps its own depth, and nothing the
 *   overcut adds goes below the spoilboard floor `stockBottom - limit`.
 * - The result is never shallower than `effectiveBottom`.
 */
export function overcutBottomZ(
  nominalBottom: number,
  effectiveBottom: number,
  status: VerticalOvercutStatus,
  stockBottom: number,
): number {
  if (status.kind !== 'ok') return effectiveBottom
  if (!cutsThroughStockBottom(nominalBottom, stockBottom)) return effectiveBottom
  const requested = Math.min(nominalBottom, stockBottom - status.amount)
  return Math.min(effectiveBottom, Math.max(requested, stockBottom - status.limit))
}

function unitSuffix(units: Units): string {
  return units === 'inch' ? 'in' : 'mm'
}

function formatValue(value: unknown, units: Units): string {
  if (typeof value === 'number' && Number.isFinite(value)) return `${formatLength(value, units)} ${unitSuffix(units)}`
  return String(value)
}

/**
 * The program comment for a valid overcut. Program comments are English in
 * every dialect, like the rest of the emitted text; the amount is in project
 * units, the units the operator set it in.
 */
export function verticalOvercutCommentText(amount: number, units: Units): string {
  return `WARNING: vertical overcut ${formatValue(amount, units)} below the stock bottom - cuts into the spoilboard`
}

/**
 * The notice for an operation's overcut, or null when there is none. A valid
 * overcut is a warning — it is intentional, but it is a cut into the
 * spoilboard and has to be visible before machining. An invalid one is the
 * error that refuses generation and blocks export.
 */
export function verticalOvercutWarning(
  project: Pick<Project, 'meta'>,
  operation: Operation,
  status: VerticalOvercutStatus = resolveVerticalOvercut(project, operation),
): ToolpathWarning | null {
  const units = project.meta.units
  if (status.kind === 'none') return null
  if (status.kind === 'ok') {
    return {
      code: 'edgeVerticalOvercut',
      params: { operation: operation.name, amount: formatValue(status.amount, units) },
    }
  }
  return {
    code: 'edgeVerticalOvercutInvalid',
    params: {
      operation: operation.name,
      amount: formatValue(status.amount, units),
      limit: formatValue(status.limit ?? 0, units),
    },
  }
}
