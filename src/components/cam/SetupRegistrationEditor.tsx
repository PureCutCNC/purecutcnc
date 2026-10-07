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

import { useState } from 'react'
import type { Project, RegistrationReference, RegistrationKind, RegistrationTarget } from '../../types/project'
import { useI18n } from '../../i18n/i18nContext'

export function SetupRegistrationEditor({ project, references, onChange }: {
  project: Project; references: RegistrationReference[]; onChange: (references: RegistrationReference[]) => void
}) {
  const { t } = useI18n()
  const [kind, setKind] = useState<RegistrationKind>('dowel')
  const [type, setType] = useState<RegistrationTarget['type']>('feature')
  const [featureId, setFeatureId] = useState(project.features[0]?.id ?? '')
  const [coordinates, setCoordinates] = useState([0, 0, 0, 0])
  const valid = type === 'feature' ? project.features.some((feature) => feature.id === featureId) : coordinates.slice(0, type === 'edge' ? 4 : 2).every(Number.isFinite)
  function add() {
    if (!valid) return
    const target: RegistrationTarget = type === 'feature' ? { type, featureId }
      : type === 'point' ? { type, point: { x: coordinates[0], y: coordinates[1] } }
      : { type, start: { x: coordinates[0], y: coordinates[1] }, end: { x: coordinates[2], y: coordinates[3] } }
    let number = references.length + 1
    while (references.some((ref) => ref.id === `registration-${number}`)) number++
    onChange([...references, { id: `registration-${number}`, kind, target }])
  }
  return <fieldset className="setup-registration"><legend>{t('cam.setup.registration')}</legend>
    <ul>{references.map((ref) => <li key={ref.id}>
      <span>{t(`cam.setup.${ref.kind}`)} · {ref.target.type === 'feature' ? project.features.find((feature) => feature.id === (ref.target.type === 'feature' ? ref.target.featureId : ''))?.name : ref.target.type === 'point' ? `${ref.target.point.x}, ${ref.target.point.y}` : `${ref.target.start.x}, ${ref.target.start.y} → ${ref.target.end.x}, ${ref.target.end.y}`}</span>
      <button type="button" className="feat-btn" aria-label={t('cam.setup.removeRegistration', { id: ref.id })} onClick={() => onChange(references.filter((entry) => entry.id !== ref.id))}>✕</button>
    </li>)}</ul>
    <div className="setup-registration__add">
      <label>{t('cam.setup.referenceKind')}<select value={kind} onChange={(event) => setKind(event.target.value as RegistrationKind)}>{(['dowel','fence','corner'] as const).map((value) => <option key={value} value={value}>{t(`cam.setup.${value}`)}</option>)}</select></label>
      <label>{t('cam.setup.referenceTarget')}<select value={type} onChange={(event) => setType(event.target.value as RegistrationTarget['type'])}>{(['feature','point','edge'] as const).map((value) => <option key={value} value={value}>{t(`cam.setup.${value}`)}</option>)}</select></label>
      {type === 'feature' ? <label>{t('cam.setup.feature')}<select value={featureId} onChange={(event) => setFeatureId(event.target.value)}>{project.features.map((feature) => <option key={feature.id} value={feature.id}>{feature.name}</option>)}</select></label>
        : <div className="setup-registration__coordinates">{coordinates.slice(0,type === 'edge' ? 4 : 2).map((value,index) => <label key={index}>{['X','Y','X2','Y2'][index]} ({project.meta.units})<input type="number" step="any" value={Number.isFinite(value) ? value : ''} onChange={(event) => setCoordinates(coordinates.map((entry,i) => i === index ? event.target.valueAsNumber : entry))} /></label>)}</div>}
      <button className="feat-btn" type="button" disabled={!valid} onClick={add}>{t('cam.setup.addReference')}</button>
    </div>
    <p className="properties-hint">{t('cam.setup.registrationHelp')}</p>
  </fieldset>
}
