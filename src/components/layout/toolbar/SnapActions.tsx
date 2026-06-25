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

import type { SnapMode } from '../../../sketch/snapping'
import type { SnapToolbarProps } from './shared'
import { ToolbarActionButton } from './primitives'

function SnapActions({
  snapSettings,
  activeSnapMode,
  tooltipSide,
  onToggleSnapEnabled,
  onToggleSnapMode,
}: SnapToolbarProps & {
  tooltipSide?: 'bottom' | 'right'
}) {
  const hasMode = (mode: SnapMode) => snapSettings.modes.includes(mode)

  return (
    <>
      <div className="toolbar-group">
        <ToolbarActionButton
          icon="snap"
          label={snapSettings.enabled ? 'Disable snapping' : 'Enable snapping'}
          active={snapSettings.enabled}
          tooltipSide={tooltipSide}
          onClick={onToggleSnapEnabled}
        />
        <ToolbarActionButton
          icon="snap-grid"
          label="Snap to grid"
          active={snapSettings.enabled && hasMode('grid')}
          emphasized={snapSettings.enabled && activeSnapMode === 'grid'}
          tooltipSide={tooltipSide}
          onClick={() => onToggleSnapMode('grid')}
        />
        <ToolbarActionButton
          icon="snap-point"
          label="Snap to point"
          active={snapSettings.enabled && hasMode('point')}
          emphasized={snapSettings.enabled && activeSnapMode === 'point'}
          tooltipSide={tooltipSide}
          onClick={() => onToggleSnapMode('point')}
        />
        <ToolbarActionButton
          icon="snap-line"
          label="Snap to line"
          active={snapSettings.enabled && hasMode('line')}
          emphasized={snapSettings.enabled && activeSnapMode === 'line'}
          tooltipSide={tooltipSide}
          onClick={() => onToggleSnapMode('line')}
        />
        <ToolbarActionButton
          icon="snap-midpoint"
          label="Snap to midpoint"
          active={snapSettings.enabled && hasMode('midpoint')}
          emphasized={snapSettings.enabled && activeSnapMode === 'midpoint'}
          tooltipSide={tooltipSide}
          onClick={() => onToggleSnapMode('midpoint')}
        />
        <ToolbarActionButton
          icon="snap-center"
          label="Snap to center"
          active={snapSettings.enabled && hasMode('center')}
          emphasized={snapSettings.enabled && activeSnapMode === 'center'}
          tooltipSide={tooltipSide}
          onClick={() => onToggleSnapMode('center')}
        />
        <ToolbarActionButton
          icon="snap-intersection"
          label="Snap to intersection"
          active={snapSettings.enabled && hasMode('intersection')}
          emphasized={snapSettings.enabled && activeSnapMode === 'intersection'}
          tooltipSide={tooltipSide}
          onClick={() => onToggleSnapMode('intersection')}
        />
        <ToolbarActionButton
          icon="snap-perpendicular"
          label="Snap perpendicular"
          active={snapSettings.enabled && hasMode('perpendicular')}
          emphasized={snapSettings.enabled && activeSnapMode === 'perpendicular'}
          tooltipSide={tooltipSide}
          onClick={() => onToggleSnapMode('perpendicular')}
        />
      </div>
    </>
  )
}

export { SnapActions }
