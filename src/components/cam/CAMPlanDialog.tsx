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

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  reconcileCamPlanRest,
  type CamPlanDraft,
  type CamPlanOperationDraft,
  type CamPlanOperationField,
  type CamPlanSharedTabsDraft,
} from '../../engine/operations/camPlan'
import { useI18n } from '../../i18n/i18nContext'
import { useProjectStore } from '../../store/projectStore'
import type { Operation } from '../../types/project'
import { formatLength, parseLengthInput } from '../../utils/units'
import { Icon } from '../Icon'
import { camT } from './camI18n'
import { CAMPlanOperationEditor } from './CAMPlanOperationEditor'
import { OPERATION_FIELDS } from './operationFields'

type SelectedPlanItem = { type: 'operation'; key: string } | { type: 'tabs'; key: string }

function operationSelection(key: string): SelectedPlanItem {
  return { type: 'operation', key }
}

function operationKindLabel(operation: Operation): string {
  const kind = operation.kind
  switch (kind) {
    case 'pocket': return camT('cam.opLabel.pocket')
    case 'edge_route_inside': return camT('cam.opLabel.edgeRouteInside')
    case 'edge_route_outside': return camT('cam.opLabel.edgeRouteOutside')
    case 'surface_clean': return camT('cam.opLabel.surfaceClean')
    case 'drilling': return camT('cam.opLabel.drilling')
    case 'v_carve': return camT('cam.opLabel.vCarve')
    case 'v_carve_medial': return camT('cam.opLabel.vCarveMedial')
    case 'rough_surface': return camT('cam.opLabel.roughSurface')
    case 'finish_surface': return camT('cam.opLabel.finishSurface')
    case 'finish_surface_cleanup': return camT('cam.opLabel.finishSurfaceCleanup')
    case 'follow_line': return camT('cam.opLabel.followLine')
  }
}

function operationSettingSummary(operation: Operation, tool: CamPlanDraft['tools'][number]['tool'] | null): string {
  const applies = (id: 'pattern' | 'edgeStrategy' | 'drillType' | 'xyLeadStrategy') => (
    OPERATION_FIELDS.find((field) => field.id === id)?.appliesTo(operation, tool) ?? false
  )
  if (applies('drillType')) return (operation.drillType ?? 'simple').replaceAll('_', ' ')
  if (applies('edgeStrategy')) return (operation.edgeStrategy ?? 'contour').replaceAll('_', ' ')
  if (applies('pattern')) return operation.pocketPattern.replaceAll('_', ' ')
  if (applies('xyLeadStrategy')) return (operation.xyLeadStrategy ?? 'none').replaceAll('_', ' ')
  return operation.pass
}

function dependenciesAreOrdered(operations: CamPlanOperationDraft[]): boolean {
  const positions = new Map(operations.map((draft, index) => [draft.key, index]))
  return operations.every((draft, index) =>
    draft.dependencies.every((dependency) => (positions.get(dependency) ?? -1) < index),
  )
}

function moveOperation(operations: CamPlanOperationDraft[], key: string, delta: -1 | 1): CamPlanOperationDraft[] | null {
  const from = operations.findIndex((draft) => draft.key === key)
  const to = from + delta
  if (from < 0 || to < 0 || to >= operations.length) return null
  const next = [...operations]
  const [moved] = next.splice(from, 1)
  if (!moved) return null
  next.splice(to, 0, moved)
  return dependenciesAreOrdered(next) ? next : null
}

function enabledCoverage(plan: CamPlanDraft, featureId: string): boolean {
  return plan.operations.some((draft) => draft.enabled && draft.coveredFeatureIds.includes(featureId))
}

function selectedItemKey(item: SelectedPlanItem): string {
  return `${item.type}:${item.key}`
}

interface SharedTabsEditorProps {
  draft: CamPlanSharedTabsDraft
  units: 'mm' | 'inch'
  onChange: (next: CamPlanSharedTabsDraft) => void
}

function SharedTabsEditor({ draft, units, onChange }: SharedTabsEditorProps) {
  function updateDimension(field: 'w' | 'h' | 'z_top', value: number) {
    onChange({ ...draft, tabs: draft.tabs.map((tab) => ({ ...tab, [field]: value })) })
  }
  function lengthInput(label: string, field: 'w' | 'h' | 'z_top', value: number) {
    return (
      <label className="cam-plan-field">
        <span>{label}</span>
        <div className="cam-plan-length-input">
          <input
            key={`${field}:${value}`}
            type="text"
            inputMode="decimal"
            defaultValue={formatLength(value, units)}
            onBlur={(event) => {
              const parsed = parseLengthInput(event.currentTarget.value, units)
              if (parsed === null || parsed <= 0) {
                event.currentTarget.value = formatLength(value, units)
              } else {
                updateDimension(field, parsed)
              }
            }}
          />
          <span>{units === 'inch' ? 'in' : 'mm'}</span>
        </div>
      </label>
    )
  }

  const first = draft.tabs[0] ?? null
  return (
    <div className="cam-plan-editor">
      <div className="cam-plan-editor__heading">
        <div>
          <span className="cam-plan-eyebrow">{camT('cam.plan.sharedSetup')}</span>
          <h3>{camT('cam.plan.sharedTabs')}</h3>
        </div>
        <span className="cam-plan-status-chip">{draft.targetLabel}</span>
      </div>
      <div className="cam-plan-explanation">
        <strong>{camT('cam.plan.sharedBy')}</strong>
        <p>{camT('cam.plan.sharedByCount', { count: draft.operationKeys.length })}</p>
      </div>
      <label className="cam-plan-check cam-plan-check--card">
        <input type="checkbox" checked={draft.enabled} onChange={(event) => onChange({ ...draft, enabled: event.currentTarget.checked })} />
        <span>{draft.reusedExistingTabs ? camT('cam.plan.reuseTabs') : camT('cam.plan.createTabs', { count: draft.tabs.length })}</span>
      </label>
      {!draft.reusedExistingTabs && first ? (
        <section className="cam-plan-editor__section">
          <h4>{camT('cam.plan.tabDimensions')}</h4>
          {lengthInput(camT('cam.plan.tabWidth'), 'w', first.w)}
          {lengthInput(camT('cam.plan.tabHeight'), 'h', first.h)}
          {lengthInput(camT('cam.plan.tabTop'), 'z_top', first.z_top)}
          <p className="cam-plan-field-note">{camT('cam.plan.tabSharedNote')}</p>
        </section>
      ) : null}
      {!draft.enabled ? <div className="cam-plan-alert cam-plan-alert--warning">{camT('cam.plan.tabsDisabledWarning')}</div> : null}
      {draft.warning ? <div className="cam-plan-alert cam-plan-alert--warning">{draft.warning}</div> : null}
    </div>
  )
}

export interface CAMPlanDialogProps {
  initialPlan: CamPlanDraft
  onRecalculate: () => Promise<CamPlanDraft>
  onClose: () => void
  onCreated: (operationIds: string[]) => void
  triggerRef: React.RefObject<HTMLElement | null>
}

export function CAMPlanDialog({ initialPlan, onRecalculate, onClose, onCreated, triggerRef }: CAMPlanDialogProps) {
  useI18n()
  const project = useProjectStore((state) => state.project)
  const applyCamPlan = useProjectStore((state) => state.applyCamPlan)
  const [plan, setPlan] = useState(initialPlan)
  const [selected, setSelected] = useState<SelectedPlanItem>(() =>
    initialPlan.operations[0] ? operationSelection(initialPlan.operations[0].key) : { type: 'tabs', key: initialPlan.sharedTabs[0]?.key ?? '' },
  )
  const [acknowledgeCoverage, setAcknowledgeCoverage] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [recalculating, setRecalculating] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    previousFocusRef.current = triggerRef.current
    dialogRef.current?.focus()
    return () => previousFocusRef.current?.focus()
  }, [triggerRef])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const selectedOperation = selected.type === 'operation'
    ? plan.operations.find((draft) => draft.key === selected.key) ?? null
    : null
  const selectedTabs = selected.type === 'tabs'
    ? plan.sharedTabs.find((draft) => draft.key === selected.key) ?? null
    : null
  const uncovered = useMemo(() => plan.coverage.filter((coverage) =>
    coverage.status === 'unsupported'
    || (coverage.status === 'planned' && !enabledCoverage(plan, coverage.featureId)),
  ), [plan])
  const blockingErrors = plan.operations.flatMap((draft) => {
    const message = draft.hardError ?? draft.staleReason ?? (!draft.operation.toolRef ? camT('cam.plan.missingTool') : null)
    return draft.enabled && message ? [{
      key: draft.key,
      label: `${operationKindLabel(draft.operation)} · ${camT(`cam.pass.${draft.operation.pass}`)}`,
      message,
    }] : []
  })
  const hardError = blockingErrors.length > 0
  const enabledCount = plan.operations.filter((draft) => draft.enabled).length
  const existingOperationCount = project.operations.filter((operation) => operation.enabled).length
  const canCreate = enabledCount > 0 && !hardError && (uncovered.length === 0 || acknowledgeCoverage)

  function patchOperation(key: string, patch: Partial<Operation>, invalidatesRest = false) {
    setMessage(null)
    setPlan((current) => {
      const selectedTool = patch.toolRef
        ? current.tools.find((candidate) => candidate.id === patch.toolRef)?.tool ?? null
        : null
      const overrideFields = Object.keys(patch) as CamPlanOperationField[]
      const revised = {
        ...current,
        operations: current.operations.map((draft) => {
          if (draft.key === key) {
            const userOverrides = [...new Set([...draft.userOverrides, ...overrideFields])]
            const operation = {
              ...draft.operation,
              ...patch,
              ...(selectedTool ? {
                ...(!userOverrides.includes('feed') ? { feed: selectedTool.defaultFeed } : {}),
                ...(!userOverrides.includes('plungeFeed') ? { plungeFeed: selectedTool.defaultPlungeFeed } : {}),
                ...(!userOverrides.includes('stepdown') ? { stepdown: selectedTool.defaultStepdown } : {}),
                ...(!userOverrides.includes('stepover') ? { stepover: selectedTool.defaultStepover } : {}),
                ...(!userOverrides.includes('rpm') ? { rpm: selectedTool.defaultRpm } : {}),
              } : {}),
            }
            return {
              ...draft,
              operation,
              userOverrides,
              toolReason: patch.toolRef ? camT('cam.plan.userSelectedTool') : draft.toolReason,
              hardError: operation.toolRef ? null : camT('cam.plan.missingTool'),
            }
          }
          return draft
        }),
      }
      if (!invalidatesRest) return revised
      const revisedDraft = revised.operations.find((draft) => draft.key === key)
      return reconcileCamPlanRest(project, revised, revisedDraft?.rest?.sourceOperationKey ?? key)
    })
  }

  function toggleOperation(key: string, enabled: boolean) {
    setPlan((current) => ({
      ...current,
      operations: current.operations.map((draft) =>
        draft.key === key || (!enabled && draft.rest?.sourceOperationKey === key)
          ? { ...draft, enabled }
          : draft,
      ),
    }))
    setAcknowledgeCoverage(false)
  }

  function applyRecommendedRestTool(key: string) {
    setMessage(null)
    setPlan((current) => {
      const rest = current.operations.find((draft) => draft.key === key)
      if (!rest?.rest) return current
      const revised = {
        ...current,
        operations: current.operations.map((draft) => draft.key === key
          ? { ...draft, userOverrides: draft.userOverrides.filter((field) => field !== 'toolRef') }
          : draft,
        ),
      }
      return reconcileCamPlanRest(project, revised, rest.rest.sourceOperationKey)
    })
  }

  function handleMove(key: string, delta: -1 | 1) {
    setPlan((current) => {
      const operations = moveOperation(current.operations, key, delta)
      if (!operations) {
        setMessage(camT('cam.plan.dependencyBlocked'))
        return current
      }
      setMessage(null)
      return { ...current, operations }
    })
  }

  async function handleRecalculate() {
    setRecalculating(true)
    setMessage(null)
    const next = await onRecalculate()
    setPlan(next)
    setSelected(next.operations[0] ? operationSelection(next.operations[0].key) : { type: 'tabs', key: next.sharedTabs[0]?.key ?? '' })
    setAcknowledgeCoverage(false)
    setRecalculating(false)
  }

  function handleCreate() {
    const result = applyCamPlan(plan)
    if (!result.ok) {
      setMessage(result.message)
      return
    }
    onCreated(result.operationIds)
  }

  function handleBackdropClick(event: React.MouseEvent) {
    if (event.target === event.currentTarget) onClose()
  }

  return createPortal(
    <div className="dialog-backdrop" onClick={handleBackdropClick}>
      <div className="dialog dialog--cam-plan" role="dialog" aria-modal="true" aria-labelledby="cam-plan-title" ref={dialogRef} tabIndex={-1}>
        <header className="dialog-header cam-plan-header">
          <div>
            <span className="cam-plan-eyebrow">{camT('cam.plan.preview')}</span>
            <h2 id="cam-plan-title">{camT('cam.plan.title')}</h2>
            <p>{camT('cam.plan.subtitle')}</p>
          </div>
          <button className="dialog-close" type="button" aria-label={camT('cam.panel.close')} onClick={onClose}><Icon id="close" /></button>
        </header>

        <div className="cam-plan-overview">
          <div className="cam-plan-summary" aria-label={camT('cam.plan.summary')}>
            <span><strong>{enabledCount}</strong> {camT('cam.plan.operations')}</span>
            <span><strong>{new Set(plan.operations.flatMap((draft) => draft.enabled && draft.operation.toolRef ? [draft.operation.toolRef] : [])).size}</strong> {camT('cam.plan.tools')}</span>
            <span><strong>{existingOperationCount}</strong> {camT('cam.plan.existingOperations')}</span>
            <span className={uncovered.length > 0 ? 'cam-plan-summary__warning' : ''}><strong>{uncovered.length}</strong> {camT('cam.plan.needsReview')}</span>
          </div>

          {blockingErrors.length > 0 ? (
            <section className="cam-plan-errors" aria-label={camT('cam.plan.blockingErrors')} role="alert">
              <strong className="cam-plan-errors__heading">{camT('cam.plan.blockingErrors')}</strong>
              <div className="cam-plan-errors__items">
                {blockingErrors.map((error) => (
                  <button key={error.key} type="button" className="cam-plan-errors__item" onClick={() => setSelected(operationSelection(error.key))}>
                    <span>
                      <strong>{error.label}</strong>
                      <span>{error.message}</span>
                    </span>
                    <span className="cam-plan-errors__review">{camT('cam.plan.reviewError')} <span aria-hidden="true">→</span></span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </div>

        <div className="dialog-body cam-plan-body">
          <aside className="cam-plan-list" aria-label={camT('cam.plan.recommendations')}>
            <div className="cam-plan-list__heading">
              <span>{camT('cam.plan.recommendations')}</span>
              <button type="button" onClick={() => void handleRecalculate()} disabled={recalculating}>{recalculating ? camT('cam.plan.recalculating') : camT('cam.plan.recalculate')}</button>
            </div>
            <div className="cam-plan-rows">
              {plan.operations.map((draft, index) => {
                const item = operationSelection(draft.key)
                const tool = plan.tools.find((candidate) => candidate.id === draft.operation.toolRef)?.tool ?? null
                return (
                  <div
                    key={draft.key}
                    className={`cam-plan-row${selectedItemKey(selected) === selectedItemKey(item) ? ' cam-plan-row--selected' : ''}${!draft.enabled ? ' cam-plan-row--disabled' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelected(item)}
                    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setSelected(item) }}
                  >
                    <input type="checkbox" checked={draft.enabled} aria-label={camT('cam.plan.includeOperation', { name: draft.operation.name })} onClick={(event) => event.stopPropagation()} onChange={(event) => toggleOperation(draft.key, event.currentTarget.checked)} />
                    <span className="cam-plan-row__index">{index + 1}</span>
                    <span className="cam-plan-row__content">
                      <strong>{operationKindLabel(draft.operation)} · {camT(`cam.pass.${draft.operation.pass}`)}</strong>
                      <span>{draft.targetLabel}</span>
                      <small>{tool?.name ?? camT('cam.operation.noTool')} · {operationSettingSummary(draft.operation, tool)}</small>
                    </span>
                    <span className="cam-plan-row__actions">
                      {draft.rest ? <span className="cam-plan-tag">REST</span> : null}
                      {draft.hardError || draft.staleReason ? <span className="cam-plan-row__warning">!</span> : null}
                      <button type="button" aria-label={camT('cam.plan.moveUp')} disabled={index === 0} onClick={(event) => { event.stopPropagation(); handleMove(draft.key, -1) }}>↑</button>
                      <button type="button" aria-label={camT('cam.plan.moveDown')} disabled={index === plan.operations.length - 1} onClick={(event) => { event.stopPropagation(); handleMove(draft.key, 1) }}>↓</button>
                    </span>
                  </div>
                )
              })}
              {plan.sharedTabs.map((draft) => {
                const item: SelectedPlanItem = { type: 'tabs', key: draft.key }
                return (
                  <button key={draft.key} type="button" className={`cam-plan-row cam-plan-row--shared${selectedItemKey(selected) === selectedItemKey(item) ? ' cam-plan-row--selected' : ''}`} onClick={() => setSelected(item)}>
                    <span className="cam-plan-row__index"><Icon id="tab" size={14} /></span>
                    <span className="cam-plan-row__content"><strong>{camT('cam.plan.sharedTabs')}</strong><span>{draft.targetLabel}</span><small>{camT('cam.plan.sharedByCount', { count: draft.operationKeys.length })}</small></span>
                  </button>
                )
              })}
            </div>
            {uncovered.length > 0 ? (
              <div className="cam-plan-coverage">
                <strong>{camT('cam.plan.coverageReview')}</strong>
                {uncovered.map((coverage) => (
                  <p key={coverage.featureId}>
                    <span>{coverage.featureName}</span>
                    {coverage.status === 'planned' ? camT('cam.plan.excludedCoverage') : coverage.detail}
                  </p>
                ))}
                <label className="cam-plan-check"><input type="checkbox" checked={acknowledgeCoverage} onChange={(event) => setAcknowledgeCoverage(event.currentTarget.checked)} /> {camT('cam.plan.acknowledge')}</label>
              </div>
            ) : null}
          </aside>

          <main className="cam-plan-detail">
            {selectedOperation ? (
              <CAMPlanOperationEditor
                draft={selectedOperation}
                tools={plan.tools}
                units={project.meta.units}
                onPatch={(patch, invalidatesRest) => patchOperation(selectedOperation.key, patch, invalidatesRest)}
                onUseRecommendedRestTool={selectedOperation.rest ? () => applyRecommendedRestTool(selectedOperation.key) : undefined}
              />
            ) : selectedTabs ? (
              <SharedTabsEditor draft={selectedTabs} units={project.meta.units} onChange={(next) => setPlan((current) => ({ ...current, sharedTabs: current.sharedTabs.map((draft) => draft.key === next.key ? next : draft) }))} />
            ) : (
              <div className="panel-empty">{camT('cam.plan.noRecommendations')}</div>
            )}
          </main>
        </div>

        <footer className="dialog-footer cam-plan-footer">
          <span className="cam-plan-footer__message" role="status">{message}</span>
          <button type="button" className="secondary" onClick={onClose}>{camT('cam.plan.cancel')}</button>
          <button type="button" className="primary" disabled={!canCreate} onClick={handleCreate}>{camT('cam.plan.createOperations', { count: enabledCount })}</button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
