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
import { canMoveOperation, cutFromBothSides, operationTargetReach, camSetupSections, visibleTargetReach } from './setupSections'
import { SetupDialogShell } from './SetupDialogShell'
import { useI18n } from '../../i18n/i18nContext'
import { formatLength } from '../../utils/units'

export function SetupOperationControls({ operation, requestToolpath }: {
  operation: Operation
  requestToolpath: (id: string, purpose: 'booklet', signal?: AbortSignal) => Promise<ToolpathResult | null>
}) {
  const { t, tPlural } = useI18n()
  const { project, assignOperationToSetup } = useProjectStore()
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
  // Only where two faces meet: a single-sided target has nothing to verify.
  const shownReaches = visibleTargetReach(face, reaches)
  // Cards for the targets cut from both sides; the "cannot reach" errors keep
  // their card but are no reason to offer the check (issue #1112 item 38).
  const twoSided = shownReaches.filter(cutFromBothSides)
  const movable = canMoveOperation(operation.kind)
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
    <div className="properties-field"><span>{t('cam.setup.setup')}</span><div className="face-row__value"><span className={`face-chip face-chip--${face}`}>{setup.name}</span>{movable ? <button className="feat-btn" type="button" onClick={() => { setMoving(true); setConfirmSnapshot(project); setDestination(sections.find((section) => section.setup.id !== setup.id)?.setup.id ?? '') }}>{t('cam.setup.move')}</button> : null}</div></div>
    {shownReaches.length > 0 ? <div className="cam-setup-reach">
      {twoSided.length > 0 ? <>
        <p className="cam-setup-reach__intro">{tPlural(twoSided.length, 'cam.setup.reachIntro.one', 'cam.setup.reachIntro.other')}</p>
        <button className="feat-btn" type="button" disabled={checking} onClick={() => void checkReach()}>{t(checking ? 'cam.setup.checkingPasses' : 'cam.setup.checkPasses')}</button>
      </> : null}
      {shownReaches.map((entry) => <div key={entry.featureId} className="cam-setup-reach__target">
        <strong>{entry.featureName}</strong> {entry.verdict.status === 'cross-face' ? <span className="cam-setup-reach__cross-face" title={t('cam.setup.crossFaceTitle')} aria-label={t('cam.setup.crossFaceTitle')}>⇄</span> : null}
        {entry.verdict.status === 'rejected' ? <p className="cam-field-message">{t('cam.setup.unreachable')}</p> : <>
          {entry.verdict.depth ? <p>{t(face === 'top' ? 'cam.setup.depthTop' : face === 'bottom' ? 'cam.setup.depthBottom' : 'cam.setup.depthAround', { start: formatLength(entry.verdict.depth.start,project.meta.units), end: formatLength(entry.verdict.depth.end,project.meta.units), units: project.meta.units })}</p> : null}
          {entry.range ? <p>{t('cam.setup.stockReach', { min: formatLength(entry.range.min,project.meta.units), max: formatLength(entry.range.max,project.meta.units), units: project.meta.units })}</p> : null}
          {entry.coverage?.status === 'meets' ? <p className="cam-setup-coverage cam-setup-coverage--meets">{t('cam.setup.meets', { value: formatLength(entry.coverage.overlap ?? 0,project.meta.units), units: project.meta.units })}</p>
            : entry.coverage?.status === 'gap' ? <p className="cam-setup-coverage cam-setup-coverage--gap">{t('cam.setup.gap', { value: formatLength(entry.coverage.gap ?? 0,project.meta.units), units: project.meta.units })}</p>
            : <p className="cam-setup-coverage cam-setup-coverage--unverified">{t('cam.setup.unverified')}</p>}
        </>}
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
