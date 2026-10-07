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
import type { MachiningSetup, Project } from '../../types/project'
import { setupFace, setupOriginInCanonical, setupFrame } from '../../engine/setupOrientation'
import { useProjectStore } from '../../store/projectStore'
import { activeSetup } from '../../store/helpers/activeFace'
import { operationsDeletedWithSetup } from './setupSections'
import { SetupDialogShell } from './SetupDialogShell'
import { SetupRegistrationEditor } from './SetupRegistrationEditor'
import { useI18n } from '../../i18n/i18nContext'
import { formatLength } from '../../utils/units'

export function SetupPropertiesDialog({ setup: initialSetup, onClose }: { setup: MachiningSetup; onClose: () => void }) {
  const { t } = useI18n()
  const [setup] = useState(initialSetup)
  const [deleteSnapshot, setDeleteSnapshot] = useState<Project | null>(null)
  const close = onClose
  const { project, updateSetup, deleteSetup } = useProjectStore()
  const [name, setName] = useState(setup.name)
  const [axis, setAxis] = useState(setup.orientation.axis)
  const [notes, setNotes] = useState(setup.notes)
  const [registration, setRegistration] = useState(setup.registration)
  const [deleting, setDeleting] = useState(false)
  const face = setupFace(setup)
  const current = project.setups.find((entry) => entry.id === setup.id) ?? (activeSetup(project)?.id === setup.id ? activeSetup(project) : null)
  // A dialog cannot save over an intervening undo/edit to the setup.
  const unchanged = current && JSON.stringify(current) === JSON.stringify(setup)
  const origin = setupOriginInCanonical(project.origin, setupFrame({ ...setup.orientation, axis }, project.stock))
  const removed = operationsDeletedWithSetup(project, setup.id)
  function save() { if (unchanged && updateSetup(setup.id, { name, flipAxis: axis, registration, notes })) close() }
  return <SetupDialogShell title={t('cam.setup.propertiesFor', { name: setup.name })} onClose={close} footer={<>
    <button className="btn-secondary" type="button" onClick={close}>{t('dialogs.common.cancel')}</button>
    {deleting ? <button className="btn-primary" type="button" disabled={!unchanged || deleteSnapshot !== project} onClick={() => { if (deleteSnapshot === project && deleteSetup(setup.id)) close() }}>{t('cam.setup.confirmDelete')}</button>
      : <button className="btn-primary" type="button" disabled={!name.trim() || !unchanged} onClick={save}>{t('cam.setup.save')}</button>}
  </>}>
    {!unchanged ? <p role="alert">{t('cam.setup.changed')}</p> : null}
    {deleting ? <><p>{t('cam.setup.deleteWarning', { name: setup.name })}</p><ul>{removed.map((operation) => <li key={operation.id}>{operation.name}</li>)}</ul><p>{t('cam.setup.deleteCount', { count: removed.length })}</p></> : <>
      <label className="properties-field"><span>{t('cam.operation.name')}</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
      <div className="properties-field"><span>{t('cam.setup.faceUp')}</span><div className="setup-face-options">{(['top','bottom','left','right','front','back'] as const).map((value) => <button key={value} type="button" disabled aria-pressed={value === face} className={value === face ? `face-chip face-chip--${face}` : 'face-chip'}>{t(`cam.setup.${value}`)}</button>)}</div></div>
      <p className="properties-hint">{t('cam.setup.faceFixed')}</p>
      <label className="properties-field"><span>{t('cam.setup.flipAxis')}</span><select value={axis} onChange={(event) => setAxis(event.target.value as 'x' | 'y')}><option value="x">{t('cam.setup.axisX')}</option><option value="y">{t('cam.setup.axisY')}</option></select></label>
      <FlipSketch axis={axis} />
      <div className="properties-field"><span>{t('cam.setup.sharedOrigin')}</span><span>{formatLength(origin.x, project.meta.units)}, {formatLength(origin.y, project.meta.units)}, {formatLength(origin.z, project.meta.units)} {project.meta.units}</span></div>
      <p className="properties-hint">{t('cam.setup.touchOff')}</p>
      <SetupRegistrationEditor project={project} references={registration} onChange={setRegistration} />
      {(project.setups.indexOf(setup) > 0 || !project.setups.includes(setup)) && registration.length === 0 ? <p className="cam-field-message" role="note">{t('cam.setup.noRegistration')}</p> : null}
      <label className="properties-field properties-field--textarea"><span>{t('cam.setup.notes')}</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
      <button className="feat-btn" type="button" disabled={project.setups.length < 2 || !project.setups.some((entry) => entry.id === setup.id)} onClick={() => { setDeleteSnapshot(project); setDeleting(true) }}>{t('cam.setup.delete')}</button>
    </>}
  </SetupDialogShell>
}

function FlipSketch({ axis }: { axis: 'x' | 'y' }) {
  const { t } = useI18n()
  return <figure className="setup-flip-sketch">
    <svg viewBox="0 0 340 105" role="img" aria-label={t(axis === 'x' ? 'cam.setup.flipSketchX' : 'cam.setup.flipSketchY')}>
      <rect x="10" y="15" width="120" height="70" fill="none" stroke="var(--accent)" />
      <text x="15" y="80" fill="var(--text)">A</text><text x="112" y="30" fill="var(--text)">B</text>
      <text x="153" y="58" fill="var(--text)">→</text>
      <rect x="205" y="15" width="120" height="70" fill="none" stroke="var(--face-bottom)" />
      <text x={axis === 'x' ? 210 : 307} y={axis === 'x' ? 30 : 80} fill="var(--face-bottom-text)">A</text>
      <text x={axis === 'x' ? 307 : 210} y={axis === 'x' ? 80 : 30} fill="var(--face-bottom-text)">B</text>
      <path d={axis === 'x' ? 'M 0 50 H 140 M 195 50 H 335' : 'M 70 5 V 95 M 265 5 V 95'} stroke="var(--face-bottom)" strokeDasharray="5 4" />
    </svg><figcaption>{t(axis === 'x' ? 'cam.setup.flipSketchX' : 'cam.setup.flipSketchY')}</figcaption>
  </figure>
}
