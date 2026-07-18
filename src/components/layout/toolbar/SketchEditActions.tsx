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
import type { SketchEditTool } from '../../../store/types'
import { ToolbarActionButton } from './primitives'

function SketchEditActions({
  enabled,
  activeTool,
  tooltipSide,
  onAddPoint,
  onDeletePoint,
  onDeleteSegment,
  onDisconnect,
  onFillet,
  onChamfer,
  onTrim,
  onExtend,
  trimExtendDisabled = false,
}: {
  enabled: boolean
  activeTool: SketchEditTool | null
  tooltipSide?: 'bottom' | 'right'
  onAddPoint: () => void
  onDeletePoint: () => void
  onDeleteSegment: () => void
  onDisconnect: () => void
  onFillet: () => void
  onChamfer: () => void
  onTrim: () => void
  onExtend: () => void
  trimExtendDisabled?: boolean
}) {
  const { t } = useI18n()

  if (!enabled) return null

  return (
    <div className="toolbar-group">
      <ToolbarActionButton
        icon="point-add"
        label={activeTool === 'add_point' ? t('sketch.edit.cancelAddPoint') : t('sketch.edit.addPoint')}
        active={activeTool === 'add_point'}
        tooltipSide={tooltipSide}
        onClick={onAddPoint}
      />
      <ToolbarActionButton
        icon="point-delete"
        label={activeTool === 'delete_point' ? t('sketch.edit.cancelDeletePoint') : t('sketch.edit.deletePoint')}
        active={activeTool === 'delete_point'}
        tooltipSide={tooltipSide}
        onClick={onDeletePoint}
      />
      <ToolbarActionButton
        icon="segment-delete"
        label={activeTool === 'delete_segment' ? t('sketch.edit.cancelDeleteSegment') : t('sketch.edit.deleteSegment')}
        active={activeTool === 'delete_segment'}
        tooltipSide={tooltipSide}
        onClick={onDeleteSegment}
      />
      <ToolbarActionButton
        icon="disconnect"
        label={activeTool === 'disconnect' ? t('sketch.edit.cancelDisconnect') : t('sketch.edit.disconnect')}
        active={activeTool === 'disconnect'}
        tooltipSide={tooltipSide}
        onClick={onDisconnect}
      />
      <ToolbarActionButton
        icon="fillet"
        label={activeTool === 'fillet' ? t('sketch.edit.cancelFillet') : t('sketch.edit.fillet')}
        active={activeTool === 'fillet'}
        tooltipSide={tooltipSide}
        onClick={onFillet}
      />
      <ToolbarActionButton
        icon="chamfer"
        label={activeTool === 'chamfer' ? t('sketch.edit.cancelChamfer') : t('sketch.edit.chamfer')}
        active={activeTool === 'chamfer'}
        tooltipSide={tooltipSide}
        onClick={onChamfer}
      />
      <ToolbarActionButton
        icon="trim"
        label={trimExtendDisabled ? t('sketch.edit.trimDisabled') : activeTool === 'trim' ? t('sketch.edit.cancelTrim') : t('sketch.edit.trim')}
        active={activeTool === 'trim'}
        disabled={trimExtendDisabled}
        tooltipSide={tooltipSide}
        onClick={onTrim}
      />
      <ToolbarActionButton
        icon="extend"
        label={trimExtendDisabled ? t('sketch.edit.extendDisabled') : activeTool === 'extend' ? t('sketch.edit.cancelExtend') : t('sketch.edit.extend')}
        active={activeTool === 'extend'}
        disabled={trimExtendDisabled}
        tooltipSide={tooltipSide}
        onClick={onExtend}
      />
    </div>
  )
}

export { SketchEditActions }
