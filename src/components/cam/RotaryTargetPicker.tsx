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

import { useI18n } from '../../i18n/i18nContext'
import type { OperationTarget, Project } from '../../types/project'
import { rotaryTargetModels, rotaryTargetToggle } from './operationValidity'

/**
 * The models a rotary operation machines, as a checklist (issue #1015 slice
 * K). A rotary target is always the imported model (or models) inside the bar,
 * and the model is not selectable on the Around sheet, so "use current
 * selection" could not express it alone. Ticking a box writes the target
 * through `rotaryTargetToggle`, which keeps any region filter the target
 * carries (#1096); the selection control beside this list adds such a filter.
 *
 * The last ticked box is disabled, so the target is never empty — a rotary
 * operation always names what it machines. A target id naming no model any
 * more is dropped from both this list and the next write.
 */
export function RotaryTargetPicker({ project, target, onChange }: {
  project: Project
  target: OperationTarget
  onChange: (target: OperationTarget) => void
}) {
  const { t } = useI18n()
  const models = rotaryTargetModels(project)
  if (models.length === 0) return null
  const targetIds = target.source === 'features' ? target.featureIds : []
  const checkedCount = models.filter((model) => targetIds.includes(model.id)).length
  return <fieldset className="cam-cross-face-picker cam-rotary-target" data-rotary-targets>
    <legend>{t('cam.operation.rotaryTargets')}</legend>
    <p className="properties-hint">{t('cam.operation.rotaryTargetsHelp')}</p>
    {models.map((model) => {
      const checked = targetIds.includes(model.id)
      return <label className="properties-check" key={model.id}>
        <input
          type="checkbox"
          checked={checked}
          disabled={checked && checkedCount === 1}
          data-rotary-target-model={model.id}
          onChange={() => onChange(rotaryTargetToggle(project, target, model.id))}
        />
        <span>{model.name}</span>
      </label>
    })}
  </fieldset>
}
