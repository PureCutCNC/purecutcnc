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

import type { OperationKind, Project, SetupFace } from '../../types/project'
import { judgeTargetFromFace } from '../../engine/setupTargets'
import { resolveFeatureInstances } from '../../store/helpers/resolveFeatures'
import { isOperationTargetValid } from '../../store/helpers/operationDefaults'
import { useI18n } from '../../i18n/i18nContext'

/** Targets are picked for CAM; ghost sketch selection remains untouched. */
export function CrossFaceTargetPicker({ project, face, selectedIds, kind, onChange }: {
  project: Project; face: SetupFace; selectedIds: readonly string[]; kind?: OperationKind
  onChange: (ids: string[]) => void
}) {
  const { t } = useI18n()
  const candidates = resolveFeatureInstances(project).filter((feature) => judgeTargetFromFace(project, feature, face).status === 'cross-face')
  if (candidates.length === 0) return null
  return <fieldset className="cam-cross-face-picker">
    <legend>{t('cam.setup.crossFacePicker')}</legend>
    <p className="properties-hint">{t('cam.setup.crossFaceHelp')}</p>
    {candidates.map((feature) => {
      const checked = selectedIds.includes(feature.id)
      const ids = checked ? selectedIds.filter((id) => id !== feature.id) : [...selectedIds, feature.id]
      const valid = !kind || isOperationTargetValid(project, kind, { source: 'features', featureIds: ids })
      return <label className="properties-check" key={feature.id}>
        <input type="checkbox" checked={checked} disabled={!valid} onChange={() => onChange(ids)} />
        <span>{feature.name}</span><span className="face-chip face-chip--thru">{t('cam.setup.crossFace')}</span>
        {!valid ? <span className="properties-hint">{t('cam.hint.notCompatible')}</span> : null}
      </label>
    })}
  </fieldset>
}
