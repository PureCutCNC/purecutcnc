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

import type { FeatureAlignment, FeatureDistribution } from '../../../store/types'
import { ToolbarPopoverMenu } from './ToolbarPopoverMenu'
import type { PopoverMenuOption } from './shared'

const ALIGNMENT_OPTIONS: PopoverMenuOption<FeatureAlignment>[] = [
  { value: 'left', icon: 'align-left', label: 'Align left' },
  { value: 'center_horizontal', icon: 'align-center-horizontal', label: 'Align center horizontally' },
  { value: 'right', icon: 'align-right', label: 'Align right' },
  { value: 'top', icon: 'align-top', label: 'Align top' },
  { value: 'center_vertical', icon: 'align-center-vertical', label: 'Align center vertically' },
  { value: 'bottom', icon: 'align-bottom', label: 'Align bottom' },
]

const DISTRIBUTION_OPTIONS: PopoverMenuOption<FeatureDistribution>[] = [
  { value: 'horizontal_gaps', icon: 'distribute-horizontal-gaps', label: 'Distribute horizontally (equal gaps)' },
  { value: 'horizontal_centers', icon: 'distribute-horizontal-centers', label: 'Distribute horizontally (equal centers)' },
  { value: 'vertical_gaps', icon: 'distribute-vertical-gaps', label: 'Distribute vertically (equal gaps)' },
  { value: 'vertical_centers', icon: 'distribute-vertical-centers', label: 'Distribute vertically (equal centers)' },
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
  if (!enabled) return null

  return (
    <ToolbarPopoverMenu
      triggerIcon="align"
      triggerLabelOpen="Close alignment menu"
      triggerLabelClosed="Align selected features"
      enabled={enabled}
      tooltipSide={tooltipSide}
      columns={3}
      options={ALIGNMENT_OPTIONS}
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
  if (!enabled) return null

  return (
    <ToolbarPopoverMenu
      triggerIcon="distribute"
      triggerLabelOpen="Close distribute menu"
      triggerLabelClosed="Distribute selected features"
      enabled={enabled}
      tooltipSide={tooltipSide}
      columns={2}
      options={DISTRIBUTION_OPTIONS}
      onSelect={onDistribute}
    />
  )
}

export { AlignmentActions, DistributionActions }
