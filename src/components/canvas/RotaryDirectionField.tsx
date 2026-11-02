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
 * The Right/Left hand picker shared by the Thread and Flutes panels
 * (issue #1016 C1 direction; moved into the canvas panels by #1112 rt2-b).
 *
 * "Hand" is the physical helix — right-hand is the ordinary one — never the
 * machine's A-axis reversal or a cut-direction (climb/conventional) choice.
 * The visible label and the group's accessible name are the same catalog key,
 * so the choice is announced as "Direction" whether the label is read or
 * heard. The control is the shared `Select`, which is already tablet-sized.
 */

import { useI18n } from '../../i18n/i18nContext'
import { Select } from '../Select'

export type RotaryDirection = 'right' | 'left'

interface RotaryDirectionFieldProps {
  value: RotaryDirection
  onChange: (value: RotaryDirection) => void
}

export function RotaryDirectionField({ value, onChange }: RotaryDirectionFieldProps) {
  const { t } = useI18n()
  return (
    <div
      className="canvas-workflow-panel__field rotary-panel__direction"
      role="group"
      aria-label={t('dialogs.rotary.direction')}
    >
      <span>{t('dialogs.rotary.direction')}</span>
      <Select
        value={value}
        options={[
          { value: 'right', label: t('dialogs.rotary.direction.right') },
          { value: 'left', label: t('dialogs.rotary.direction.left') },
        ]}
        onChange={onChange}
      />
    </div>
  )
}
