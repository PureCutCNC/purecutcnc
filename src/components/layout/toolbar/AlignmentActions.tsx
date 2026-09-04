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
import type { FeatureDistributionMode } from '../../../sketch/featureDistribution'
import { ToolbarPopoverMenu } from './ToolbarPopoverMenu'
import type { PopoverMenuOption } from './shared'

interface AlignmentMenuOption extends PopoverMenuOption<FeatureAlignment> {
  labelKey: MessageKey
}

interface DistributionMenuOption extends PopoverMenuOption<FeatureDistribution> {
  labelKey: MessageKey
}

/**
 * Laying text on a baseline shares this menu with distribution — it is the same
 * "arrange what is already on the sketch" act — but it is a different command
 * with a different predicate, so it gets its own prefixed values rather than
 * widening `FeatureDistributionMode`.
 */
type TextLayoutAction = 'text-arc' | 'text-path'
type DistributionAction = FeatureDistribution | FeatureDistributionMode | TextLayoutAction

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
  canDistributeEvenly,
  canCreatePattern,
  canLayOutText,
  onDistribute,
  onCreatePattern,
  onLayOutText,
}: {
  enabled: boolean
  tooltipSide?: 'bottom' | 'right'
  canDistributeEvenly: boolean
  canCreatePattern: boolean
  canLayOutText: boolean
  onDistribute: (distribution: FeatureDistribution) => void
  onCreatePattern: (mode: FeatureDistributionMode) => void
  onLayOutText: (kind: 'arc' | 'path') => void
}) {
  const { t } = useI18n()

  if (!enabled) return null

  const options: PopoverMenuOption<DistributionAction>[] = [
    ...DISTRIBUTION_OPTIONS.map<PopoverMenuOption<DistributionAction>>((option) => ({
      value: option.value,
      icon: option.icon,
      label: t(option.labelKey),
      enabled: canDistributeEvenly,
    })),
    { value: 'grid', icon: 'grid', label: t('canvas.featureDistribution.grid'), enabled: canCreatePattern },
    { value: 'radial', icon: 'rotate', label: t('canvas.featureDistribution.radial'), enabled: canCreatePattern },
    { value: 'path', icon: 'spline', label: t('canvas.featureDistribution.path'), enabled: canCreatePattern },
    { value: 'text-arc', icon: 'circle', label: t('canvas.textLayout.mode.arc'), enabled: canLayOutText },
    { value: 'text-path', icon: 'text', label: t('canvas.textLayout.mode.path'), enabled: canLayOutText },
  ]

  function selectDistribution(action: DistributionAction) {
    if (DISTRIBUTION_OPTIONS.some((option) => option.value === action)) {
      onDistribute(action as FeatureDistribution)
      return
    }
    if (action === 'text-arc' || action === 'text-path') {
      onLayOutText(action === 'text-arc' ? 'arc' : 'path')
      return
    }
    onCreatePattern(action as FeatureDistributionMode)
  }

  return (
    <ToolbarPopoverMenu
      triggerIcon="distribute"
      triggerLabelOpen={t('sketch.arrange.closeDistributeMenu')}
      triggerLabelClosed={t('sketch.arrange.distribute')}
      enabled={enabled}
      tooltipSide={tooltipSide}
      columns={4}
      options={options}
      onSelect={selectDistribution}
    />
  )
}

export { AlignmentActions, DistributionActions }
