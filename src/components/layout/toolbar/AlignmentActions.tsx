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
import type { MessageKey } from '../../../i18n/locales/en'
import type { FeatureAlignment, FeatureDistribution } from '../../../store/types'
import { ToolbarPopoverMenu } from './ToolbarPopoverMenu'
import type { PopoverMenuOption } from './shared'

interface AlignmentMenuOption extends PopoverMenuOption<FeatureAlignment> {
  labelKey: MessageKey
}

interface DistributionMenuOption extends PopoverMenuOption<FeatureDistribution> {
  labelKey: MessageKey
}

const ALIGNMENT_OPTIONS: AlignmentMenuOption[] = [
  { value: 'left', icon: 'align-left', label: '', labelKey: 'sketch.align.left' },
  { value: 'center_horizontal', icon: 'align-center-horizontal', label: '', labelKey: 'sketch.align.centerHorizontal' },
  { value: 'right', icon: 'align-right', label: '', labelKey: 'sketch.align.right' },
  { value: 'top', icon: 'align-top', label: '', labelKey: 'sketch.align.top' },
  { value: 'center_vertical', icon: 'align-center-vertical', label: '', labelKey: 'sketch.align.centerVertical' },
  { value: 'bottom', icon: 'align-bottom', label: '', labelKey: 'sketch.align.bottom' },
]

const DISTRIBUTION_OPTIONS: DistributionMenuOption[] = [
  { value: 'horizontal_gaps', icon: 'distribute-horizontal-gaps', label: '', labelKey: 'sketch.distribute.horizontalGaps' },
  { value: 'horizontal_centers', icon: 'distribute-horizontal-centers', label: '', labelKey: 'sketch.distribute.horizontalCenters' },
  { value: 'vertical_gaps', icon: 'distribute-vertical-gaps', label: '', labelKey: 'sketch.distribute.verticalGaps' },
  { value: 'vertical_centers', icon: 'distribute-vertical-centers', label: '', labelKey: 'sketch.distribute.verticalCenters' },
]

function AlignmentActions({
  enabled,
  tooltipSide,
  onAlign,
}: {
  enabled: boolean
  tooltipSide?: 'bottom' | 'right'
  onAlign: (alignment: FeatureAlignment) => void
}) {
  const { t } = useI18n()

  if (!enabled) return null

  const options = ALIGNMENT_OPTIONS.map((option) => ({
    value: option.value,
    icon: option.icon,
    label: t(option.labelKey),
  }))

  return (
    <ToolbarPopoverMenu
      triggerIcon="align"
      triggerLabelOpen={t('sketch.arrange.closeAlignMenu')}
      triggerLabelClosed={t('sketch.arrange.align')}
      enabled={enabled}
      tooltipSide={tooltipSide}
      columns={3}
      options={options}
      onSelect={onAlign}
    />
  )
}

function DistributionActions({
  enabled,
  tooltipSide,
  onDistribute,
}: {
  enabled: boolean
  tooltipSide?: 'bottom' | 'right'
  onDistribute: (distribution: FeatureDistribution) => void
}) {
  const { t } = useI18n()

  if (!enabled) return null

  const options = DISTRIBUTION_OPTIONS.map((option) => ({
    value: option.value,
    icon: option.icon,
    label: t(option.labelKey),
  }))

  return (
    <ToolbarPopoverMenu
      triggerIcon="distribute"
      triggerLabelOpen={t('sketch.arrange.closeDistributeMenu')}
      triggerLabelClosed={t('sketch.arrange.distribute')}
      enabled={enabled}
      tooltipSide={tooltipSide}
      columns={2}
      options={options}
      onSelect={onDistribute}
    />
  )
}

export { AlignmentActions, DistributionActions }
