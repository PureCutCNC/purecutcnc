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

import { useI18n } from '../../../i18n/i18nContext'
import { ToolbarActionButton } from './primitives'

function ShapeToolActions({
  pendingShapeAction,
  tooltipSide,
  onJoin,
  onCut,
}: {
  pendingShapeAction: 'join' | 'cut' | null
  tooltipSide?: 'bottom' | 'right'
  onJoin: () => void
  onCut: () => void
}) {
  const { t } = useI18n()

  return (
    <div className="toolbar-group">
      <ToolbarActionButton
        icon="merge"
        label={pendingShapeAction === 'join' ? t('sketch.boolean.cancelJoin') : t('sketch.boolean.join')}
        active={pendingShapeAction === 'join'}
        tooltipSide={tooltipSide}
        onClick={onJoin}
      />
      <ToolbarActionButton
        icon="cut"
        label={pendingShapeAction === 'cut' ? t('sketch.boolean.cancelCut') : t('sketch.boolean.cut')}
        active={pendingShapeAction === 'cut'}
        tooltipSide={tooltipSide}
        onClick={onCut}
      />
    </div>
  )
}

export { ShapeToolActions }
