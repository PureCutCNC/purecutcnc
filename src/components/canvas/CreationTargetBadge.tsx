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
 * Discrete sketch-view overlay showing which drawing mode (creation target)
 * is active — Features / Lines / Regions / Construction (issues #199/#270).
 * With four modes, the highlighted toolbar button alone is easy to miss; this badge
 * keeps the answer to "what will I draw right now?" in the corner of the
 * canvas. Display-only: pointer events pass through to the canvas.
 */

import { useProjectStore } from '../../store/projectStore'
import { Icon } from '../Icon'
import { useI18n } from '../../i18n/i18nContext'
import type { MessageKey } from '../../i18n/locales/en'
import type { CreationTarget } from '../../store/types'

const TARGET_LABEL_KEYS: Record<CreationTarget, MessageKey> = {
  feature: 'canvas.target.drawingFeatures',
  line: 'canvas.target.drawingLines',
  region: 'canvas.target.drawingRegions',
  construction: 'canvas.target.drawingConstruction',
}

const TARGET_ICONS: Record<CreationTarget, string> = {
  feature: 'plus',
  line: 'snap-line',
  region: 'pocket',
  construction: 'construction',
}

export function CreationTargetBadge() {
  const creationTarget = useProjectStore((s) => s.creationTarget)
  const { t } = useI18n()
  const label = t(TARGET_LABEL_KEYS[creationTarget])

  return (
    <div
      className={`creation-target-badge creation-target-badge--${creationTarget}`}
      role="status"
      aria-label={label}
    >
      <Icon id={TARGET_ICONS[creationTarget]} size={13} />
      <span>{label}</span>
    </div>
  )
}
