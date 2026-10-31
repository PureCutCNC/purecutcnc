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
 * Turn or Polygon presents (issue #1112 rt6-a item 39, extended by rt6-c).
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
 * for these kinds and shows a read-only line naming the parameter instead; the
 * stored `z_top`/`z_bottom` are still written by the Edit panels and read by
 * toolpaths, 3D and simulation exactly as before.
 *
 * rt6-c adds the two facts that were missing from those lines: **which surface**
 * a Thread/Flutes depth is measured from (`surfaceMessageKey`; the surface
 * itself is resolved by `store/helpers/rotarySurface.ts`, never guessed here),
 * and **where a Turn or Polygon's surface sits in Z** (`cannedShapeSurface`,
 * the diameter/across-flats the Properties summary reports the Z of).
 */

import type { CannedShapeData } from '../types/project'
import {
  FLUTES_CANNED_KIND,
  POLYGON_CANNED_KIND,
  THREAD_CANNED_KIND,
  TURN_CANNED_KIND,
} from './generators/kinds'

/** The read-only line Properties shows instead of a Z control. */
export interface CannedShapeZSource {
  /** i18n key naming the field, its value, and the panel that changes it. */
  messageKey: string
  /** The length the Edit panel's field writes, in project units. */
  value: number
  /**
   * The same line with a `{surface}` slot, for the kinds measured from a
   * surface a Turn or the bar supplies. Present only for Thread and Flutes,
   * and used only when the surface could be resolved for one selected row.
   */
  surfaceMessageKey?: string
}

interface OwnedByEditPanel {
  /** The stored parameter the Edit panel's own field writes. */
  field: string
  /** The message for that field, its value and where to change it. */
  messageKey: string
  /** The message naming the surface, when the kind is measured from one. */
  surfaceMessageKey?: string
}

/**
 * The four kinds whose span the Edit panel controls. The label and the value
 * are the panel's own (`dialogs.rotary.depth`, `dialogs.rotarySolid.diameter`,
 * `dialogs.rotarySolid.acrossFlats`), so the two surfaces can never disagree
 * about what sets the height.
 */
const OWNED_BY_EDIT_PANEL: Record<string, OwnedByEditPanel> = {
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
  [TURN_CANNED_KIND]: {
    field: 'diameter',
    messageKey: 'featureTree.properties.canned.zSource.turn',
  },
  [POLYGON_CANNED_KIND]: {
    field: 'acrossFlats',
    messageKey: 'featureTree.properties.canned.zSource.polygon',
  },
}

/**
 * True when the Edit panel, not the Properties Z range, sets this kind's span.
 *
 * Keyed on the stored kind rather than on a registered generator, so a file
 * whose generator is missing still hides a control that could never have
 * agreed with the shape.
 */
export function cannedShapeZIsOwned(canned: CannedShapeData | null | undefined): boolean {
  return !!canned && Object.prototype.hasOwnProperty.call(OWNED_BY_EDIT_PANEL, canned.kind)
}

/**
 * Keep one line per distinct parameter value: a multi-selection of three
 * identical threads owns the same Depth, and saying it three times adds nothing.
 * Two turns of different diameters keep both lines.
 */
export function uniqueCannedZSources(
  sources: readonly CannedShapeZSource[],
): CannedShapeZSource[] {
  return sources.filter((source, index) => sources.findIndex(
    (other) => other.messageKey === source.messageKey && other.value === source.value,
  ) === index)
}

/**
 * The read-only line's message and value, or `null` for a kind Properties
 * edits itself (or a parameter set that carries no usable number).
 */
export function cannedShapeZSource(
  canned: CannedShapeData | null | undefined,
): CannedShapeZSource | null {
  if (!canned) return null
  const owned = OWNED_BY_EDIT_PANEL[canned.kind]
  if (!owned) return null
  const value = canned.params?.[owned.field]
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return {
    messageKey: owned.messageKey,
    value,
    ...(owned.surfaceMessageKey ? { surfaceMessageKey: owned.surfaceMessageKey } : {}),
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
