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
 * The read-only Z line for the four rotary canned kinds (issue #1112 rt6-a,
 * item 39).
 *
 * Properties has no Z control for a Thread, Flutes, Turn or Polygon: their span
 * is built from the parameter the Edit panel writes, so a Z slider could only
 * fight the regenerate. In its place this line names that parameter, its value
 * and the panel that changes it — the same field label and number the Edit
 * panel shows, so the two surfaces agree by construction.
 */

import { formatLength } from '../../utils/units'
import { useI18n } from '../../i18n/i18nContext'
import type { MessageKey } from '../../i18n/locales/en'
import type { CannedShapeZSource } from '../../cannedShapes'
import type { Project } from '../../types/project'

type Units = Project['meta']['units']

export function CannedZSourceLine({ source, units }: { source: CannedShapeZSource, units: Units }) {
  const { t } = useI18n()
  const unitLabel = units === 'inch' ? 'in' : 'mm'
  return (
    <p className="properties-linked-face-note" data-testid="canned-z-source">
      {t(source.messageKey as MessageKey, {
        value: `${formatLength(source.value, units)} ${unitLabel}`,
      })}
    </p>
  )
}
