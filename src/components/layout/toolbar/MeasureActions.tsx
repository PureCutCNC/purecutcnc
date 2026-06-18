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

import type { DimensionType } from '../../../types/project'
import { ToolbarPopoverMenu } from './ToolbarPopoverMenu'
import type { PopoverMenuOption } from './shared'
import { ToolbarActionButton } from './primitives'

const DIMENSION_TYPE_OPTIONS: PopoverMenuOption<DimensionType>[] = [
  { value: 'aligned', icon: 'dim-aligned', label: 'Aligned dimension' },
  { value: 'horizontal', icon: 'dim-horizontal', label: 'Horizontal dimension' },
  { value: 'vertical', icon: 'dim-vertical', label: 'Vertical dimension' },
  { value: 'radius', icon: 'dim-radius', label: 'Radius dimension' },
  { value: 'diameter', icon: 'dim-diameter', label: 'Diameter dimension' },
  { value: 'angle', icon: 'dim-angle', label: 'Angle dimension' },
]

function MeasureActions({
  tapeActive,
  pendingDimensionType,
  dimensionDeleteArmed,
  showDimensions,
  dimensionCount,
  tooltipSide,
  onTapeMeasure,
  onDimensionType,
  onDeleteDimension,
  onToggleShowDimensions,
}: {
  tapeActive: boolean
  pendingDimensionType: DimensionType | null
  dimensionDeleteArmed: boolean
  showDimensions: boolean
  dimensionCount: number
  tooltipSide?: 'bottom' | 'right'
  onTapeMeasure: () => void
  onDimensionType: (type: DimensionType) => void
  onDeleteDimension: () => void
  onToggleShowDimensions: () => void
}) {
  // Reflect a pending dimension placement in the popover trigger so the user
  // can see which type is in progress without expanding the menu.
  const activeDimOption = pendingDimensionType
    ? DIMENSION_TYPE_OPTIONS.find((option) => option.value === pendingDimensionType) ?? null
    : null
  const triggerIcon = activeDimOption?.icon ?? 'measure'
  const triggerLabelClosed = activeDimOption
    ? `Cancel ${activeDimOption.label.toLowerCase()}`
    : 'Add dimension'
  return (
    <div className="toolbar-group">
      <ToolbarActionButton
        icon="tape-measure"
        label={tapeActive ? 'Tape measure (on)' : 'Tape measure'}
        active={tapeActive}
        tooltipSide={tooltipSide}
        onClick={onTapeMeasure}
      />
      <ToolbarPopoverMenu
        triggerIcon={triggerIcon}
        triggerLabelOpen="Close dimension menu"
        triggerLabelClosed={triggerLabelClosed}
        enabled
        tooltipSide={tooltipSide}
        columns={3}
        options={DIMENSION_TYPE_OPTIONS}
        onSelect={onDimensionType}
      />
      <ToolbarActionButton
        icon="trash"
        label={dimensionDeleteArmed ? 'Delete dimension (click one)' : 'Delete dimension'}
        active={dimensionDeleteArmed}
        disabled={dimensionCount === 0}
        tooltipSide={tooltipSide}
        onClick={onDeleteDimension}
      />
      <ToolbarActionButton
        icon={showDimensions ? 'eye' : 'eye-off'}
        label={dimensionCount === 0
          ? 'Show/hide dimensions'
          : showDimensions ? `Hide dimensions (${dimensionCount})` : `Show dimensions (${dimensionCount})`}
        active={showDimensions}
        tooltipSide={tooltipSide}
        onClick={onToggleShowDimensions}
      />
    </div>
  )
}

export { MeasureActions }
