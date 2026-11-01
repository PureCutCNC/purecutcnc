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
 * The Shape section's one-line summary for a canned shape (issue #1112), and
 * since rt7-d the only place a Thread's or Flutes' Depth is reported.
 *
 * Properties has no Z control for the four rotary canned kinds: their span is
 * built from the parameter the Edit panel writes, so a Z slider could only
 * fight the regenerate (rt6-a item 39). Until rt7-d a Thread and Flutes put a
 * second, read-only line under **Instance** — "Depth 0.8 mm below the bar (Ø 40
 * mm, surface at Z 40) · set in Edit flutes…" — beside this summary. Frank asked
 * for the two to be one, and for the "set in Edit …" half to go, because the
 * Edit button already sits right under the line.
 *
 * So the sentence is the shape's own summary, then the Z a Turn's diameter or a
 * Polygon's across flats reaches (rt6-c), then a Thread's or Flutes' Depth with
 * the surface it is measured from and that surface's Z:
 *
 *   Thread · 1-start · pitch 0.2 · length 2 · depth 0.122 in below Turn
 *     (Ø 0.75 in, surface at Z 1.125)
 *
 * The surface and its Z come from the same resolver the cut uses
 * (`rotaryPatternSurfaceOfFeature`, `rotarySurfaceZ`), so the sentence cannot be
 * a second opinion about where the cut starts. A Depth whose surface could not
 * be resolved (a file whose bar or machine is gone) keeps the number and drops
 * only the clause.
 */

import { formatLength } from '../../utils/units'
import { useI18n } from '../../i18n/i18nContext'
import type { MessageKey } from '../../i18n/locales/en'
import type { MessageParams } from '../../i18n/catalog'
import type { CannedShapeSummary, CannedShapeSurface } from '../../cannedShapes'
import type { Project } from '../../types/project'
import {
  rotaryPatternSurfaceWarning,
  type RotaryPatternSurface,
} from '../../store/helpers/rotarySurface'

type Units = Project['meta']['units']
type Translate = (key: MessageKey, params?: MessageParams) => string

/**
 * The surface a Thread's or Flutes' Depth is measured from, with the Z it sits
 * at. Both come from the resolver: the surface decides the diameter, and
 * `rotarySurfaceZ` is the function the span itself is placed with.
 */
export interface CannedDepthSurface {
  surface: RotaryPatternSurface
  z: number
}

/** The surface clause: what the depth is below, its diameter and its Z. */
function surfaceClause(
  t: Translate,
  reading: CannedDepthSurface,
  units: Units,
  unitLabel: string,
): string {
  const { surface } = reading
  const values = {
    diameter: `${formatLength(surface.diameter, units)} ${unitLabel}`,
    value: formatLength(reading.z, units),
  }
  if (surface.kind === 'turn') {
    return t('featureTree.properties.canned.surface.onTurn', {
      ...values,
      name: surface.turnName ?? '',
    })
  }
  // Every warned kind measures from the bar, so the bar's own description comes
  // first and the warning — the same sentence the tree and the dialog show —
  // explains why the Turn it crosses does not supply a diameter.
  const warning = rotaryPatternSurfaceWarning(surface)
  if (!warning) return t('featureTree.properties.canned.surface.bar', values)
  return t('featureTree.properties.canned.surface.warned', {
    ...values,
    warning: t(warning.key, warning.values),
  })
}

export function CannedShapeSummaryLine({ summary, surface, depth, depthSurface, units }: {
  /** The shape's own sentence, e.g. "Thread · 1-start · pitch 0.2 · length 2". */
  summary: CannedShapeSummary
  /** The Z a Turn's diameter or a Polygon's across flats reaches (rt6-c). */
  surface?: { surface: CannedShapeSurface; z: number } | null
  /** A Thread's or Flutes' Depth, the parameter the Edit panel writes (rt7-d). */
  depth?: number | null
  /** The surface that Depth is measured from, when one could be resolved. */
  depthSurface?: CannedDepthSurface | null
  units: Units
}) {
  const { t } = useI18n()
  const unitLabel = units === 'inch' ? 'in' : 'mm'
  const parts = [t(summary.key as MessageKey, summary.values)]
  if (surface) {
    parts.push(t(surface.surface.messageKey as MessageKey, {
      value: formatLength(surface.z, units),
    }))
  }
  if (typeof depth === 'number') {
    const value = `${formatLength(depth, units)} ${unitLabel}`
    parts.push(depthSurface
      ? t('featureTree.properties.canned.depth.surface', {
          value,
          surface: surfaceClause(t, depthSurface, units, unitLabel),
        })
      : t('featureTree.properties.canned.depth', { value }))
  }
  return (
    <p className="properties-linked-face-note" data-testid="canned-shape-summary">
      {parts.join(' · ')}
    </p>
  )
}
