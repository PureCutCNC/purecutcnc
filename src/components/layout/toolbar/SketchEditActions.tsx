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
  if (!enabled) return null

  return (
    <div className="toolbar-group">
      <ToolbarActionButton
        icon="point-add"
        label={activeTool === 'add_point' ? 'Cancel add point' : 'Add point'}
        active={activeTool === 'add_point'}
        tooltipSide={tooltipSide}
        onClick={onAddPoint}
      />
      <ToolbarActionButton
        icon="point-delete"
        label={activeTool === 'delete_point' ? 'Cancel delete point' : 'Delete point'}
        active={activeTool === 'delete_point'}
        tooltipSide={tooltipSide}
        onClick={onDeletePoint}
      />
      <ToolbarActionButton
        icon="segment-delete"
        label={activeTool === 'delete_segment' ? 'Cancel delete segment' : 'Delete segment'}
        active={activeTool === 'delete_segment'}
        tooltipSide={tooltipSide}
        onClick={onDeleteSegment}
      />
      <ToolbarActionButton
        icon="disconnect"
        label={activeTool === 'disconnect' ? 'Cancel disconnect' : 'Disconnect point'}
        active={activeTool === 'disconnect'}
        tooltipSide={tooltipSide}
        onClick={onDisconnect}
      />
      <ToolbarActionButton
        icon="fillet"
        label={activeTool === 'fillet' ? 'Cancel fillet' : 'Round corner / fillet'}
        active={activeTool === 'fillet'}
        tooltipSide={tooltipSide}
        onClick={onFillet}
      />
      <ToolbarActionButton
        icon="chamfer"
        label={activeTool === 'chamfer' ? 'Cancel chamfer' : 'Chamfer corner'}
        active={activeTool === 'chamfer'}
        tooltipSide={tooltipSide}
        onClick={onChamfer}
      />
      <ToolbarActionButton
        icon="trim"
        label={trimExtendDisabled ? 'Trim — open profiles only' : activeTool === 'trim' ? 'Cancel trim' : 'Trim to cutting edge'}
        active={activeTool === 'trim'}
        disabled={trimExtendDisabled}
        tooltipSide={tooltipSide}
        onClick={onTrim}
      />
      <ToolbarActionButton
        icon="extend"
        label={trimExtendDisabled ? 'Extend — open profiles only' : activeTool === 'extend' ? 'Cancel extend' : 'Extend to target'}
        active={activeTool === 'extend'}
        disabled={trimExtendDisabled}
        tooltipSide={tooltipSide}
        onClick={onExtend}
      />
    </div>
  )
}

export { SketchEditActions }
