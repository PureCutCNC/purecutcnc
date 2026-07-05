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
 * is active — Features / Regions / Construction (issue #199). With three
 * modes, the highlighted toolbar button alone is easy to miss; this badge
 * keeps the answer to "what will I draw right now?" in the corner of the
 * canvas. Display-only: pointer events pass through to the canvas.
 */

import { useProjectStore } from '../../store/projectStore'
import { Icon } from '../Icon'
import type { CreationTarget } from '../../store/types'

const TARGET_PRESENTATION: Record<CreationTarget, { icon: string; label: string }> = {
  feature: { icon: 'plus', label: 'Drawing features' },
  region: { icon: 'pocket', label: 'Drawing regions' },
  construction: { icon: 'construction', label: 'Drawing construction' },
}

export function CreationTargetBadge() {
  const creationTarget = useProjectStore((s) => s.creationTarget)
  const { icon, label } = TARGET_PRESENTATION[creationTarget]

  return (
    <div
      className={`creation-target-badge creation-target-badge--${creationTarget}`}
      role="status"
      aria-label={label}
    >
      <Icon id={icon} size={13} />
      <span>{label}</span>
    </div>
  )
}
