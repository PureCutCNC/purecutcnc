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
import { useI18n } from '../../../i18n/i18nContext'
import type { MessageKey } from '../../../i18n/locales/en'
import { ToolbarPopoverMenu } from './ToolbarPopoverMenu'
import type { PopoverMenuOption } from './shared'
import { ToolbarActionButton } from './primitives'

const DIMENSION_TYPE_OPTIONS: { value: DimensionType; icon: string; labelKey: MessageKey }[] = [
  { value: 'aligned', icon: 'dim-aligned', labelKey: 'shell.measure.dimAligned' },
  { value: 'horizontal', icon: 'dim-horizontal', labelKey: 'shell.measure.dimHorizontal' },
  { value: 'vertical', icon: 'dim-vertical', labelKey: 'shell.measure.dimVertical' },
  { value: 'radius', icon: 'dim-radius', labelKey: 'shell.measure.dimRadius' },
  { value: 'diameter', icon: 'dim-diameter', labelKey: 'shell.measure.dimDiameter' },
  { value: 'angle', icon: 'dim-angle', labelKey: 'shell.measure.dimAngle' },
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
  const { t, tPlural, languageTag } = useI18n()
  const options: PopoverMenuOption<DimensionType>[] = DIMENSION_TYPE_OPTIONS.map((option) => ({
    value: option.value,
    icon: option.icon,
    label: t(option.labelKey),
  }))

  // Reflect a pending dimension placement in the popover trigger so the user
  // can see which type is in progress without expanding the menu.
  const activeDimOption = pendingDimensionType
    ? DIMENSION_TYPE_OPTIONS.find((option) => option.value === pendingDimensionType) ?? null
    : null
  const triggerIcon = activeDimOption?.icon ?? 'measure'
  // Lowercasing the inserted name reproduces English mid-sentence style; it
  // is an identity transform for CJK and most non-Latin scripts.
  const triggerLabelClosed = activeDimOption
    ? t('shell.measure.cancelDimension', {
        dimension: t(activeDimOption.labelKey).toLocaleLowerCase(languageTag),
      })
    : t('shell.measure.addDimension')
  return (
    <div className="toolbar-group">
      <ToolbarActionButton
        icon="tape-measure"
        label={tapeActive ? t('shell.measure.tapeMeasureOn') : t('shell.measure.tapeMeasure')}
        active={tapeActive}
        tooltipSide={tooltipSide}
        onClick={onTapeMeasure}
      />
      <ToolbarPopoverMenu
        triggerIcon={triggerIcon}
        triggerLabelOpen={t('shell.measure.closeDimensionMenu')}
        triggerLabelClosed={triggerLabelClosed}
        enabled
        tooltipSide={tooltipSide}
        columns={3}
        options={options}
        onSelect={onDimensionType}
      />
      <ToolbarActionButton
        icon="trash"
        label={dimensionDeleteArmed ? t('shell.measure.deleteDimensionArmed') : t('shell.measure.deleteDimension')}
        active={dimensionDeleteArmed}
        disabled={dimensionCount === 0}
        tooltipSide={tooltipSide}
        onClick={onDeleteDimension}
      />
      <ToolbarActionButton
        icon={showDimensions ? 'eye' : 'eye-off'}
        label={dimensionCount === 0
          ? t('shell.measure.showHideDimensions')
          : showDimensions
            ? tPlural(dimensionCount, 'shell.measure.hideDimensionsCount.one', 'shell.measure.hideDimensionsCount.other')
            : tPlural(dimensionCount, 'shell.measure.showDimensionsCount.one', 'shell.measure.showDimensionsCount.other')}
        active={showDimensions}
        tooltipSide={tooltipSide}
        onClick={onToggleShowDimensions}
      />
    </div>
  )
}

export { MeasureActions }
