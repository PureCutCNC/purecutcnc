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

function BackdropEditActions({
  enabled,
  pendingMoveMode,
  pendingTransformMode,
  tooltipSide,
  onMove,
  onDelete,
  onResize,
  onRotate,
}: {
  enabled: boolean
  pendingMoveMode: 'move' | null
  pendingTransformMode: 'resize' | 'rotate' | null
  tooltipSide?: 'bottom' | 'right'
  onMove: () => void
  onDelete: () => void
  onResize: () => void
  onRotate: () => void
}) {
  const { t } = useI18n()

  if (!enabled) return null

  return (
    <div className="toolbar-group">
      <ToolbarActionButton
        icon="move"
        label={pendingMoveMode === 'move' ? t('sketch.backdrop.cancelMove') : t('sketch.backdrop.move')}
        active={pendingMoveMode === 'move'}
        tooltipSide={tooltipSide}
        onClick={onMove}
      />
      <ToolbarActionButton
        icon="trash"
        label={t('sketch.backdrop.delete')}
        tooltipSide={tooltipSide}
        onClick={onDelete}
      />
      <ToolbarActionButton
        icon="resize"
        label={pendingTransformMode === 'resize' ? t('sketch.backdrop.cancelResize') : t('sketch.backdrop.resize')}
        active={pendingTransformMode === 'resize'}
        tooltipSide={tooltipSide}
        onClick={onResize}
      />
      <ToolbarActionButton
        icon="rotate"
        label={pendingTransformMode === 'rotate' ? t('sketch.backdrop.cancelRotate') : t('sketch.backdrop.rotate')}
        active={pendingTransformMode === 'rotate'}
        tooltipSide={tooltipSide}
        onClick={onRotate}
      />
    </div>
  )
}

export { BackdropEditActions }
