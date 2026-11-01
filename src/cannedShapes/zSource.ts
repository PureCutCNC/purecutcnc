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
 * Which canned kinds own their Z span, the Depth a Thread or Flutes reports, and
 * the surface a Turn or Polygon presents (issue #1112 rt6-a item 39, extended by
 * rt6-c, rt7-b and rt7-d).
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
 * A **Thread or Flutes** reports the Depth (`cannedShapeDepth`) so Properties
 * can append it to the shape's own summary sentence — "Thread · 1-start · pitch
 * 0.2 · length 2 · depth 0.122 in below Turn (Ø 0.75 in, surface at Z 1.125)"
 * (rt7-d). Frank asked for the two lines he was shown — that summary, and a
 * separate read-only "Depth … · set in Edit thread…" line under Instance — to
 * become one, and for the "set in Edit …" half to go because the Edit button
 * already sits right under the line. So this module reports the *value* and
 * leaves the sentence to the caller.
 *
 * A **Turn or Polygon** reports no Depth at all (rt7-b): since rt6-c its summary
 * already names the diameter or across flats *and* the Z that surface reaches
 * (`cannedShapeSurface`), so a second sentence repeated what the first said.
 *
 * Which surface a Thread's or Flutes' Depth is measured from is resolved by
 * `store/helpers/rotarySurface.ts`, never guessed here.
 */

import type { CannedShapeData } from '../types/project'
import {
  FLUTES_CANNED_KIND,
  POLYGON_CANNED_KIND,
  THREAD_CANNED_KIND,
  TURN_CANNED_KIND,
} from './generators/kinds'

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
 * The two kinds that report their Depth, in the Edit panel's own word for the
 * field (`dialogs.rotary.depth`). A Turn and a Polygon are absent on purpose
 * (rt7-b): their summary line already carries the diameter or across flats and
 * the Z it reaches.
 */
const REPORTS_DEPTH: ReadonlySet<string> = new Set([
  THREAD_CANNED_KIND,
  FLUTES_CANNED_KIND,
])

/**
 * True when the Edit panel, not the Properties Z range, sets this kind's span.
 * True for all four rotary kinds — including the two that report no Depth.
 */
export function cannedShapeZIsOwned(canned: CannedShapeData | null | undefined): boolean {
  return !!canned && SPAN_OWNED_BY_EDIT_PANEL.has(canned.kind)
}

/**
 * The Depth the Edit panel's field writes, for the two kinds measured down from
 * a surface; `null` for every other kind, and for a parameter set too corrupt to
 * carry a number (the shape's summary is `null` then too, so nothing renders).
 */
export function cannedShapeDepth(canned: CannedShapeData | null | undefined): number | null {
  if (!canned || !REPORTS_DEPTH.has(canned.kind)) return null
  const value = canned.params?.depth
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
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
