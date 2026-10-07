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

import { useCallback, useState } from 'react'
import type { Operation, Project } from '../../types/project'
import type { ToolpathResult } from '../../engine/toolpaths'
import { useProjectStore } from '../../store/projectStore'
import { setupFace, setupForOperation } from '../../engine/setupOrientation'
import { planOperationMove } from '../../engine/setupOperationMove'
import { operationTargetReach, camSetupSections } from './setupSections'
import { CrossFaceTargetPicker } from './CrossFaceTargetPicker'
import { SetupDialogShell } from './SetupDialogShell'
import { useI18n } from '../../i18n/i18nContext'
import { formatLength } from '../../utils/units'

export function SetupOperationControls({ operation, requestToolpath }: {
  operation: Operation
  requestToolpath: (id: string, purpose: 'booklet', signal?: AbortSignal) => Promise<ToolpathResult | null>
}) {
  const { t } = useI18n()
  const { project, updateOperation, assignOperationToSetup } = useProjectStore()
  const [moving, setMoving] = useState(false)
  const [destination, setDestination] = useState('')
  const [checking, setChecking] = useState(false)
  const [measured, setMeasured] = useState<{ project: Project; paths: Map<string, ToolpathResult> } | null>(null)
  const close = useCallback(() => setMoving(false), [])
  const setup = setupForOperation(project, operation) ?? project.setups[0]
  const sections = camSetupSections(project).sections
  const face = setupFace(setup)
  const ids = operation.target.source === 'features' ? operation.target.featureIds : []
  const reaches = operationTargetReach(project, operation, measured?.project === project ? measured.paths : new Map())
  // Preview a provisional destination without adding it to the document.
  const dest = sections.find((section) => section.setup.id === destination)?.setup
  const preview = dest && !project.setups.includes(dest) ? { ...project, setups: [...project.setups, dest] } : project
  const plan = planOperationMove(preview, operation.id, destination)
  const [confirmSnapshot, setConfirmSnapshot] = useState<Project | null>(null)
  async function checkReach() {
    const snapshot = project
    setChecking(true)
    try {
      const related = project.operations.filter((op) => op.id === operation.id || op.enabled && op.target.source === 'features' && op.target.featureIds.some((id) => ids.includes(id)))
      const paths = new Map<string, ToolpathResult>()
      for (const op of related) {
        const path = await requestToolpath(op.id, 'booklet')
        if (useProjectStore.getState().project !== snapshot) return
        if (path) paths.set(op.id, path)
      }
      setMeasured({ project: snapshot, paths })
    } catch { setMeasured(null) }
    finally { setChecking(false) }
  }
  return <div className="setup-operation-controls">
    <div className="properties-field"><span>{t('cam.setup.setup')}</span><div className="face-row__value"><span className={`face-chip face-chip--${face}`}>{setup.name}</span><button className="feat-btn" type="button" onClick={() => { setMoving(true); setConfirmSnapshot(project); setDestination(sections.find((section) => section.setup.id !== setup.id)?.setup.id ?? '') }}>{t('cam.setup.move')}</button></div></div>
    {operation.target.source === 'features' ? <CrossFaceTargetPicker project={project} face={face} selectedIds={ids} kind={operation.kind} onChange={(featureIds) => updateOperation(operation.id, { target: { source: 'features', featureIds } })} /> : null}
    {reaches.length > 0 ? <div className="cam-setup-reach">
      <button className="feat-btn" type="button" disabled={checking} onClick={() => void checkReach()}>{t(checking ? 'cam.setup.checkingReach' : 'cam.setup.checkReach')}</button>
      {reaches.map((entry) => <div key={entry.featureId} className="cam-setup-reach__target">
        <strong>{entry.featureName}</strong> {entry.verdict.status === 'cross-face' ? <span className="face-chip face-chip--thru">{t('cam.setup.crossFace')}</span> : null}
        {entry.verdict.status === 'rejected' ? <p className="cam-field-message">{t('cam.setup.unreachable')}</p> : null}
        {entry.verdict.depth ? <p>{t(face === 'top' ? 'cam.setup.depthTop' : 'cam.setup.depthBottom', { start: formatLength(entry.verdict.depth.start,project.meta.units), end: formatLength(entry.verdict.depth.end,project.meta.units), units: project.meta.units })}</p> : null}
        <p>{entry.range ? t('cam.setup.stockReach', { min: formatLength(entry.range.min,project.meta.units), max: formatLength(entry.range.max,project.meta.units), units: project.meta.units }) : t('cam.setup.unverified')}</p>
        {entry.coverage ? <p className={`cam-setup-coverage cam-setup-coverage--${entry.coverage.status}`}>
          {entry.coverage.status === 'meets' ? t('cam.setup.meets', { value: formatLength(entry.coverage.overlap ?? 0,project.meta.units), units: project.meta.units })
            : entry.coverage.status === 'singleSide' ? t('cam.setup.singleSide')
            : entry.coverage.status === 'gap' ? t('cam.setup.gap', { value: formatLength(entry.coverage.gap ?? 0,project.meta.units), units: project.meta.units }) : t('cam.setup.unverified')}
        </p> : null}
      </div>)}
    </div> : null}
    {moving ? <SetupDialogShell title={t('cam.setup.moveTitle', { name: operation.name })} onClose={close} footer={<>
      <button className="btn-secondary" type="button" onClick={close}>{t('dialogs.common.cancel')}</button>
      <button className="btn-primary" type="button" disabled={!!plan.blocked || confirmSnapshot !== project} onClick={() => { if (confirmSnapshot === project) { assignOperationToSetup(operation.id, destination); close() } }}>{t('cam.setup.confirmMove')}</button>
    </>}>
      <label className="properties-field"><span>{t('cam.setup.destination')}</span><select value={destination} onChange={(event) => setDestination(event.target.value)}>{sections.map((section) => <option key={section.setup.id} value={section.setup.id}>{section.setup.name}</option>)}</select></label>
      {confirmSnapshot !== project ? <p role="alert">{t('cam.setup.changed')}</p> : null}
      {plan.blocked ? <p role="alert">{t(`cam.setup.moveBlocked.${plan.blocked}`)}</p> : <p>{t('cam.setup.moveHelp')}</p>}
      {plan.removed.length > 0 ? <><p>{t('cam.setup.removedTargets')}</p><ul>{plan.removed.map((verdict) => <li key={verdict.featureId}>{verdict.featureName}</li>)}</ul></> : null}
    </SetupDialogShell> : null}
  </div>
}
