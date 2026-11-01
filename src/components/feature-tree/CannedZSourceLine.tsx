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
 * The read-only Z line for a Thread and Flutes (issue #1112 rt6-a, item 39;
 * extended by rt6-c).
 *
 * Properties has no Z control for the four rotary canned kinds: their span is
 * built from the parameter the Edit panel writes, so a Z slider could only
 * fight the regenerate. For a Thread or Flutes this line names that parameter,
 * its value and the panel that changes it — the same field label and number the
 * Edit panel shows, so the two surfaces agree by construction. A Turn and a
 * Polygon get no line (rt7-b): their own summary already names the diameter or
 * across flats and the Z it reaches, so the line Frank was shown only repeated
 * it.
 *
 * rt6-c adds **which surface** a Thread/Flutes depth is measured from, with that
 * surface's diameter and its Z: "Depth 1.2 mm below Turn 1 (Ø 30 mm, surface at
 * Z 35) · set in Edit thread…". Frank could not tell that a thread floats on a
 * Turn and moves when the Turn changes; the surface and its Z come from the same
 * resolver the cut uses (`rotaryPatternSurfaceOfFeature`, `rotarySurfaceZ`), so
 * the sentence cannot be a second opinion about where the cut starts.
 */

import { formatLength } from '../../utils/units'
import { useI18n } from '../../i18n/i18nContext'
import type { MessageKey } from '../../i18n/locales/en'
import type { MessageParams } from '../../i18n/catalog'
import type { CannedShapeZSource } from '../../cannedShapes'
import type { Project } from '../../types/project'
import {
  rotaryPatternSurfaceWarning,
  type RotaryPatternSurface,
} from '../../store/helpers/rotarySurface'

type Units = Project['meta']['units']
type Translate = (key: MessageKey, params?: MessageParams) => string

/**
 * The surface a Thread/Flutes depth is measured from, with the Z it sits at.
 * Both come from the resolver: the surface decides the diameter, and
 * `rotarySurfaceZ` is the function the span itself is placed with.
 */
export interface CannedZSourceSurface {
  surface: RotaryPatternSurface
  z: number
}

/** The surface clause: what the depth is below, its diameter and its Z. */
function surfaceClause(
  t: Translate,
  reading: CannedZSourceSurface,
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

export function CannedZSourceLine({ source, units, surface }: {
  source: CannedShapeZSource
  units: Units
  /** Present when one Thread/Flutes row is selected and its surface resolved. */
  surface?: CannedZSourceSurface | null
}) {
  const { t } = useI18n()
  const unitLabel = units === 'inch' ? 'in' : 'mm'
  const value = `${formatLength(source.value, units)} ${unitLabel}`
  const clause = surface && source.surfaceMessageKey
    ? surfaceClause(t, surface, units, unitLabel)
    : null
  return (
    <p className="properties-linked-face-note" data-testid="canned-z-source">
      {clause && source.surfaceMessageKey
        ? t(source.surfaceMessageKey as MessageKey, { value, surface: clause })
        : t(source.messageKey as MessageKey, { value })}
    </p>
  )
}
