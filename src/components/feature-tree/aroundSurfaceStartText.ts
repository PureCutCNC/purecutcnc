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

/**
 * The words for an Around shape that starts above its surface (#1131, Frank's
 * 2026-10-31 addition). One sentence, shared by the tree marker and the
 * Properties note, so the two cannot disagree.
 */

import type { MessageKey } from '../../i18n/locales/en'
import type { MessageParams } from '../../i18n/catalog'
import type { AroundSurfaceStart } from '../../store/helpers/turnedSheet'
import { formatLength, type Units } from '../../utils/units'

type Translate = (key: MessageKey, params?: MessageParams) => string

export function aroundSurfaceStartText(t: Translate, start: AroundSurfaceStart, units: Units): string {
  if (start.kind === 'above') {
    return t('featureTree.surfaceStart.above', {
      distance: `${formatLength(start.distance, units)} ${units === 'inch' ? 'in' : 'mm'}`,
      turn: start.turnName,
    })
  }
  return t('featureTree.surfaceStart.crossing', { turn: start.turnNames.join(', ') })
}
