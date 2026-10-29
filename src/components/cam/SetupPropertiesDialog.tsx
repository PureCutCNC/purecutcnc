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
import { setupFace } from '../../engine/setupOrientation'
import { useProjectStore } from '../../store/projectStore'
import { activeSetup } from '../../store/helpers/activeFace'
import { formHasChanges } from '../common/formDraft'
import { operationsDeletedWithSetup } from './setupSections'
import { setupDialogSections } from './setupDialogSections'
import { setupFormValues } from './setupFormValues'
import { SetupDialogShell } from './SetupDialogShell'
import { SetupRegistrationEditor } from './SetupRegistrationEditor'
import { useI18n } from '../../i18n/i18nContext'

export function SetupPropertiesDialog({ setup: initialSetup, onClose }: { setup: MachiningSetup; onClose: () => void }) {
  const { t } = useI18n()
  const [setup, setSetup] = useState(initialSetup)
  const [deleteSnapshot, setDeleteSnapshot] = useState<Project | null>(null)
  const close = onClose
  const { project, updateSetup, deleteSetup } = useProjectStore()
  const units = project.meta.units
  const [openedUnits, setOpenedUnits] = useState(units)
  const [name, setName] = useState(setup.name)
  const [axis, setAxis] = useState(setup.orientation.axis)
  const [notes, setNotes] = useState(setup.notes)
  const [registration, setRegistration] = useState(setup.registration)
  const [deleting, setDeleting] = useState(false)
  const face = setupFace(setup)
  const sections = setupDialogSections(face)
  const current = project.setups.find((entry) => entry.id === setup.id) ?? (activeSetup(project)?.id === setup.id ? activeSetup(project) : null)
  // A unit conversion happens under the dialog too: the store rescales every
  // length with the project, this setup's registration points included (#1112
  // F4). Re-read the converted setup, as reopening the dialog would, so the form
  // keeps showing the same physical reference — the old millimetre numbers would
  // otherwise read as inches, a real edit the user never made, and the
  // stale-form guard below would refuse a Save it should have disabled anyway.
  if (units !== openedUnits) {
    setOpenedUnits(units)
    if (current) {
      setSetup(current)
      setRegistration(current.registration)
    }
  }
  // A dialog cannot save over an intervening undo/edit to the setup.
  const storeUnchanged = Boolean(current) && JSON.stringify(current) === JSON.stringify(setup)
  // Compare the draft with the saved setup through the values Save would write
  // (issue #1112 F4): a field this face does not store cannot enable it, and a
  // name typed back with different whitespace is not a change.
  const draft: MachiningSetup = { ...setup, name, notes, orientation: { ...setup.orientation, axis }, registration }
  const changed = formHasChanges(setupFormValues(setup, face), setupFormValues(draft, face))
  const canSave = storeUnchanged && changed && name.trim() !== ''
  const removed = operationsDeletedWithSetup(project, setup.id)
  function save() {
    // Save does nothing when the form still holds the values it opened on, so
    // it is disabled rather than silently writing an empty undo step.
    if (!canSave) return
    // An Around setup is not a flip: it has no face buttons, flip axis or
    // registration, so only its name and notes are written (issue #395).
    const next = face === 'around'
      ? { name, notes }
      : { name, flipAxis: axis, registration, notes }
    if (updateSetup(setup.id, next)) close()
  }
  return <SetupDialogShell title={t('cam.setup.propertiesFor', { name: setup.name })} onClose={close} footer={<>
    {deleting ? null : <button className="btn-secondary setup-dialog__delete" type="button" disabled={project.setups.length < 2 || !project.setups.some((entry) => entry.id === setup.id)} onClick={() => { setDeleteSnapshot(project); setDeleting(true) }}>{t('cam.setup.delete')}</button>}
    <button className="btn-secondary" type="button" onClick={close}>{t('dialogs.common.cancel')}</button>
    {deleting ? <button className="btn-primary" type="button" disabled={!storeUnchanged || deleteSnapshot !== project} onClick={() => { if (deleteSnapshot === project && deleteSetup(setup.id)) close() }}>{t('cam.setup.confirmDelete')}</button>
      : <button className="btn-primary" type="button" disabled={!canSave} onClick={save}>{t('cam.setup.save')}</button>}
  </>}>
    {!storeUnchanged ? <p role="alert">{t('cam.setup.changed')}</p> : null}
    {deleting ? <><p>{t('cam.setup.deleteWarning', { name: setup.name })}</p><ul>{removed.map((operation) => <li key={operation.id}>{operation.name}</li>)}</ul><p>{t('cam.setup.deleteCount', { count: removed.length })}</p></> : <>
      <label className="properties-field"><span>{t('cam.operation.name')}</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
      {sections.faceUp ? <div className="properties-field"><span>{t('cam.setup.faceUp')}</span><span className={`face-chip face-chip--${face}`}>{t(face === 'bottom' ? 'cam.setup.bottom' : 'cam.setup.top')}</span></div> : null}
      {sections.flip ? <>
        <label className="properties-field"><span>{t('cam.setup.flipAxis')}</span><select value={axis} onChange={(event) => setAxis(event.target.value as 'x' | 'y')}><option value="x">{t('cam.setup.axisX')}</option><option value="y">{t('cam.setup.axisY')}</option></select></label>
        <FlipSketch axis={axis} />
      </> : null}
      {sections.faceUp ? <>
        {/* No coordinates (Frank, #1102): measured from a corner they mean nothing on a round or freeform stock. */}
        <p className="properties-hint">{t('cam.setup.touchOff')}</p>
      </> : null}
      {sections.registration ? <>
        <SetupRegistrationEditor project={project} references={registration} onChange={setRegistration} />
        {(project.setups.indexOf(setup) > 0 || !project.setups.includes(setup)) && registration.length === 0 ? <p className="cam-field-message" role="note">{t('cam.setup.noRegistration')}</p> : null}
      </> : null}
      <label className="properties-field properties-field--textarea"><span>{t('cam.setup.notes')}</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
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
