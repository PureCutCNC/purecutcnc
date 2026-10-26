/**
 * Copyright 2026 Maik Rolf
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

import type { MessageKey } from '../i18n/locales/en'
import type { DimensionType } from '../types/project'
import type { FeatureAlignment, FeatureDistribution } from '../store/types'

export interface ArrangeCommandOption<T extends string> {
  id: T
  icon: string
  labelKey: MessageKey
}

export const FEATURE_ALIGNMENT_COMMANDS: ArrangeCommandOption<FeatureAlignment>[] = [
  { id: 'left', icon: 'align-left', labelKey: 'sketch.align.left' },
  { id: 'center_horizontal', icon: 'align-center-horizontal', labelKey: 'sketch.align.centerHorizontal' },
  { id: 'right', icon: 'align-right', labelKey: 'sketch.align.right' },
  { id: 'top', icon: 'align-top', labelKey: 'sketch.align.top' },
  { id: 'center_vertical', icon: 'align-center-vertical', labelKey: 'sketch.align.centerVertical' },
  { id: 'bottom', icon: 'align-bottom', labelKey: 'sketch.align.bottom' },
]

export const FEATURE_DISTRIBUTION_COMMANDS: ArrangeCommandOption<FeatureDistribution>[] = [
  { id: 'horizontal_gaps', icon: 'distribute-horizontal-gaps', labelKey: 'sketch.distribute.horizontalGaps' },
  { id: 'horizontal_centers', icon: 'distribute-horizontal-centers', labelKey: 'sketch.distribute.horizontalCenters' },
  { id: 'vertical_gaps', icon: 'distribute-vertical-gaps', labelKey: 'sketch.distribute.verticalGaps' },
  { id: 'vertical_centers', icon: 'distribute-vertical-centers', labelKey: 'sketch.distribute.verticalCenters' },
]

export const DIMENSION_TYPE_COMMANDS: ArrangeCommandOption<DimensionType>[] = [
  { id: 'aligned', icon: 'dim-aligned', labelKey: 'shell.measure.dimAligned' },
  { id: 'horizontal', icon: 'dim-horizontal', labelKey: 'shell.measure.dimHorizontal' },
  { id: 'vertical', icon: 'dim-vertical', labelKey: 'shell.measure.dimVertical' },
  { id: 'radius', icon: 'dim-radius', labelKey: 'shell.measure.dimRadius' },
  { id: 'diameter', icon: 'dim-diameter', labelKey: 'shell.measure.dimDiameter' },
  { id: 'angle', icon: 'dim-angle', labelKey: 'shell.measure.dimAngle' },
]
