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
 * Which canned kinds own their Z span, the value that sets it, and the surface a
 * Turn or Polygon presents (issue #1112 rt6-a item 39, extended by rt6-c and
 * rt7-b).
 *
 * Frank asked what the Z top/bottom is for on the rotary canned features. It is
 * not a control: the same four kinds already carry the value the span is built
 * from, in the parameters their Edit panel writes.
 *
 *   - Turn and Polygon are models centred on the bar's pivot, so their height
 *     is the regenerated mesh height (`cannedModelSpan`).
 *   - Thread and Flutes run from the surface they sit on down by the entered
 *     Depth (`rotaryPatternSurfaceSpan`).
 *
 * The Properties Z control therefore only ever fought the regenerate, or made
 * the cut depth disagree with the Depth in the Edit panel. Properties hides it
 * for all four kinds; the stored `z_top`/`z_bottom` are still written by the
 * Edit panels and read by toolpaths, 3D and simulation exactly as before.
 *
 * Only a **Thread or Flutes** also gets a read-only line: its Depth appears
 * nowhere else in Properties, so the line names the field, the value and the
 * panel that changes it, and **which surface** the depth is measured from
 * (`surfaceMessageKey`; the surface itself is resolved by
 * `store/helpers/rotarySurface.ts`, never guessed here). A **Turn or Polygon**
 * gets no line (rt7-b): since rt6-c its own summary line already names the
 * diameter or across flats *and* the Z that surface reaches
 * (`cannedShapeSurface`), so the second sentence Frank was shown repeated what
 * the first already said.
 */

import type { CannedShapeData } from '../types/project'
import {
  FLUTES_CANNED_KIND,
  POLYGON_CANNED_KIND,
  THREAD_CANNED_KIND,
  TURN_CANNED_KIND,
} from './generators/kinds'

/** The read-only line Properties shows for a Thread or Flutes. */
export interface CannedShapeZSource {
  /** i18n key naming the field, its value, and the panel that changes it. */
  messageKey: string
  /** The length the Edit panel's field writes, in project units. */
  value: number
  /**
   * The same line with a `{surface}` slot, for the kinds measured from a
   * surface a Turn or the bar supplies. Used only when the surface could be
   * resolved for one selected row.
   */
  surfaceMessageKey?: string
}

interface ReportedByEditPanel {
  /** The stored parameter the Edit panel's own field writes. */
  field: string
  /** The message for that field, its value and where to change it. */
  messageKey: string
  /** The message naming the surface, when the kind is measured from one. */
  surfaceMessageKey?: string
}

/**
 * The four kinds whose span the Edit panel controls: a Turn's and a Polygon's
 * regenerated model height, a Thread's and Flutes' Depth. Keyed on the stored
 * kind rather than on a registered generator, so a file whose generator is
 * missing still hides a control that could never have agreed with the shape.
 */
const SPAN_OWNED_BY_EDIT_PANEL: ReadonlySet<string> = new Set([
  THREAD_CANNED_KIND,
  FLUTES_CANNED_KIND,
  TURN_CANNED_KIND,
  POLYGON_CANNED_KIND,
])

/**
 * The two kinds that also report their value, in the Edit panel's own words
 * (`dialogs.rotary.depth`), so the two surfaces can never disagree about what
 * sets the depth. A Turn and a Polygon are absent on purpose (rt7-b): their
 * summary line already carries the diameter or across flats and the Z it
 * reaches, and Frank asked for the repeat to go.
 */
const REPORTS_Z_SOURCE: Record<string, ReportedByEditPanel> = {
  [THREAD_CANNED_KIND]: {
    field: 'depth',
    messageKey: 'featureTree.properties.canned.zSource.thread',
    surfaceMessageKey: 'featureTree.properties.canned.zSource.threadSurface',
  },
  [FLUTES_CANNED_KIND]: {
    field: 'depth',
    messageKey: 'featureTree.properties.canned.zSource.flutes',
    surfaceMessageKey: 'featureTree.properties.canned.zSource.flutesSurface',
  },
}

/**
 * True when the Edit panel, not the Properties Z range, sets this kind's span.
 * True for all four rotary kinds — including the two that report no line.
 */
export function cannedShapeZIsOwned(canned: CannedShapeData | null | undefined): boolean {
  return !!canned && SPAN_OWNED_BY_EDIT_PANEL.has(canned.kind)
}

/**
 * Keep one line per distinct parameter value: a multi-selection of three
 * identical threads owns the same Depth, and saying it three times adds nothing.
 * Two threads of different depths keep both lines.
 */
export function uniqueCannedZSources(
  sources: readonly CannedShapeZSource[],
): CannedShapeZSource[] {
  return sources.filter((source, index) => sources.findIndex(
    (other) => other.messageKey === source.messageKey && other.value === source.value,
  ) === index)
}

/**
 * The read-only line's message and value, or `null` for a kind that reports
 * none — a Turn or Polygon, a kind Properties edits itself, or a parameter set
 * that carries no usable number.
 */
export function cannedShapeZSource(
  canned: CannedShapeData | null | undefined,
): CannedShapeZSource | null {
  if (!canned) return null
  const reported = REPORTS_Z_SOURCE[canned.kind]
  if (!reported) return null
  const value = canned.params?.[reported.field]
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return {
    messageKey: reported.messageKey,
    value,
    ...(reported.surfaceMessageKey ? { surfaceMessageKey: reported.surfaceMessageKey } : {}),
  }
}

/**
 * The surface a Turn or Polygon presents, as the Properties summary reports it.
 * `diameter` is the length the surface Z is measured from — the Turn's diameter,
 * or a Polygon's across flats — so the caller resolves the Z through the same
 * `rotarySurfaceZ` the Thread/Flutes span uses (axis + radius) instead of
 * restating the formula here.
 */
export interface CannedShapeSurface {
  /** `surface at Z {value}` for a Turn, `flats at Z {value}` for a Polygon. */
  messageKey: string
  /** The diameter (Turn) or across flats (Polygon) the Z is measured from. */
  diameter: number
}

/** The summary line's surface, or `null` for every other kind. */
export function cannedShapeSurface(
  canned: CannedShapeData | null | undefined,
): CannedShapeSurface | null {
  if (!canned) return null
  const field = canned.kind === TURN_CANNED_KIND
    ? 'diameter'
    : canned.kind === POLYGON_CANNED_KIND ? 'acrossFlats' : null
  if (!field) return null
  const value = canned.params?.[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return {
    messageKey: field === 'diameter'
      ? 'featureTree.properties.canned.surface.turn'
      : 'featureTree.properties.canned.surface.flats',
    diameter: value,
  }
}
