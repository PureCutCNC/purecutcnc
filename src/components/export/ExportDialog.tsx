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

import { useState, useMemo } from 'react'
import { useProjectStore } from '../../store/projectStore'
import { useRestoreCanvasFocus } from '../../utils/useRestoreCanvasFocus'
import { platform } from '../../platform'
import {
  getActiveMachineDefinition,
  getExportedMotionEligibility,
} from '../../engine/gcode'
import type { ToolpathResult, ToolpathGenerationTrace, NormalizedTool } from '../../engine/toolpaths/types'
import type { Operation } from '../../types/project'
import type { GenerationContext, ToolpathGenerationService } from '../../app/toolpathGeneration/service'
import type { ExportPostOptions } from '../../app/toolpathGeneration/exportPreparation'
import { useExportPreparation } from '../../app/toolpathGeneration/useExportPreparation'
import {
  listExportOperationOptions,
  suggestGcodeFileName,
} from './exportOperationSelection'
import { ExportedMotionDebugDialog } from './ExportedMotionDebugDialog'
import { dialogsEn } from '../../i18n/locales/en/dialogs'
import type { MessageParams } from '../../i18n/catalog'
import { useI18n } from '../../i18n/i18nContext'
import { toolpathWarningTexts } from '../../i18n/warningText'

interface ExportDialogProps {
  onClose: () => void
  /** The generation service and the live context to submit against (issue #675). */
  service: ToolpathGenerationService
  contextRef: React.RefObject<GenerationContext>
  /** Debug-only (issue #356): produces a {raw, optimized} trace for one operation. */
  requestGenerationTrace: (operationId: string, signal?: AbortSignal) => Promise<ToolpathGenerationTrace | null>
  /** Pre-check only these operations (per-operation export); defaults to the visible set. */
  initialOperationIds?: string[]
}

export function ExportDialog({ onClose, service, contextRef, requestGenerationTrace, initialOperationIds }: ExportDialogProps) {
  useRestoreCanvasFocus()
  const { project, selectProject, lastExportPath, markExported } = useProjectStore()
  const { t, languageTag } = useI18n()

  function td(key: keyof typeof dialogsEn, params?: MessageParams): string {
    return t(key, params)
  }

  const [emitToolChanges, setEmitToolChanges] = useState(true)
  const [emitCoolant, setEmitCoolant] = useState(false)
  const [selectedOperationIds, setSelectedOperationIds] = useState<ReadonlySet<string>>(() => {
    const options = listExportOperationOptions(project)
    const selected = initialOperationIds
      ? options.filter((option) => option.exportable && initialOperationIds.includes(option.operation.id))
      : options.filter((option) => option.defaultSelected)
    return new Set(selected.map((option) => option.operation.id))
  })

  const activeDefinition = useMemo(() => getActiveMachineDefinition(project), [project])

  const operationOptions = useMemo(() => listExportOperationOptions(project), [project])

  // Selected operations in project order — the order they will be cut in, and
  // the order the program must list them in.
  const selectedInProjectOrder = useMemo(() => (
    operationOptions
      .filter((option) => option.exportable && selectedOperationIds.has(option.operation.id))
      .map((option) => option.operation.id)
  ), [operationOptions, selectedOperationIds])

  const postOptions = useMemo<ExportPostOptions>(() => ({
    emitToolChanges,
    emitCoolant,
    programName: project.meta.name,
    captureMotionTrace: selectedInProjectOrder.length === 1,
  }), [emitToolChanges, emitCoolant, project.meta.name, selectedInProjectOrder.length])

  // Generation is asynchronous now (issue #675), so the program is *prepared*
  // rather than derived during render. The preparation either produces a
  // complete program for every selected operation or refuses and says which one
  // stopped it — it never posts the subset that happened to succeed.
  const { preparation, takeExportable } = useExportPreparation({
    service,
    contextRef,
    operationIds: selectedInProjectOrder,
    definition: activeDefinition,
    options: postOptions,
    revision: project,
  })

  const previewResult = preparation?.status === 'ready' ? preparation.result : null
  const activeOperations = useMemo(
    () => (preparation?.status === 'ready' ? preparation.operations : []),
    [preparation],
  )

  type ActiveOperation = { operation: Operation; tool: NormalizedTool; toolpath: ToolpathResult }
  const [debugOperation, setDebugOperation] = useState<ActiveOperation | null>(null)

  // The exported-motion debug view is gated on exactly one eligible operation.
  // Eligibility is derived from the generated motion, not an operation-name list.
  const inspectEligible = useMemo(() => {
    if (activeOperations.length !== 1) return false
    return getExportedMotionEligibility(activeOperations[0].toolpath).eligible
  }, [activeOperations])

  const previewWarnings = useMemo(() => {
    const warnings = toolpathWarningTexts(previewResult?.warnings ?? [])
    if (operationOptions.length > 0 && selectedOperationIds.size === 0) {
      warnings.unshift(td('dialogs.export.warning.noOperations'))
    }
    if (!activeDefinition) {
      warnings.unshift(td('dialogs.export.warning.noMachine'))
    }
    return warnings
  // eslint-disable-next-line react-hooks/exhaustive-deps -- td wraps stable context t; languageTag drives locale recomputes
  }, [activeDefinition, operationOptions, previewResult, selectedOperationIds, languageTag])

  function toggleOperationSelected(operationId: string, selected: boolean) {
    setSelectedOperationIds((current) => {
      const next = new Set(current)
      if (selected) {
        next.add(operationId)
      } else {
        next.delete(operationId)
      }
      return next
    })
  }

  const exportableOperationIds = useMemo(() => (
    operationOptions
      .filter((option) => option.exportable)
      .map((option) => option.operation.id)
  ), [operationOptions])

  const allExportableSelected = exportableOperationIds.length > 0
    && exportableOperationIds.every((id) => selectedOperationIds.has(id))

  function toggleAllOperationsSelected() {
    setSelectedOperationIds(allExportableSelected ? new Set() : new Set(exportableOperationIds))
  }

  async function handleExport() {
    if (!activeDefinition) return

    // Revalidated at the moment Save is pressed, not when the preview last
    // rendered: an edit between the two would otherwise write a file describing
    // a project that no longer exists.
    const exportable = takeExportable()
    if (!exportable) return

    const suggestedName = suggestGcodeFileName(project.meta.name, exportable.operationNames)
    const ext = activeDefinition.fileExtension
    // `exportable.gcode` was copied out above and is not re-read from state; the
    // bytes are frozen for this file action even if the preview moves on.
    const exportedPath = await platform.saveTextFile(suggestedName, exportable.gcode, ext, lastExportPath)
    if (!exportedPath) return

    // The platform dialog is asynchronous, and another document can be opened
    // while it is up. Marking *that* document exported would attribute this
    // file to a project it did not come from.
    if (contextRef.current.documentKey !== exportable.documentKey) {
      onClose()
      return
    }
    markExported(exportedPath)
    onClose()
  }

  function handleChangeMachine() {
    selectProject()
    onClose()
  }

  const previewLines = previewResult
    ? previewResult.gcode.split('\n').slice(0, 30).join('\n')
    : td('dialogs.export.previewPlaceholder')

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-header">
          <h2 className="dialog-title">{td('dialogs.export.title')}</h2>
          <button className="dialog-close" onClick={onClose} aria-label={td('dialogs.common.close')}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="dialog-body dialog-body--gcode-export">
          <div className="dialog-section">
            <div className="dialog-section-group">
              <label className="dialog-section-title">{td('dialogs.export.machine')}</label>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                <div style={{ fontSize: '13px', color: 'var(--text)' }}>
                  {activeDefinition?.name ?? td('dialogs.export.machineNone')}
                </div>
                <button className="btn-secondary" onClick={handleChangeMachine} type="button" style={{ padding: '0 12px' }}>
                  {td('dialogs.export.change')}
                </button>
              </div>
            </div>

            <div className="dialog-section-group">
              <label className="dialog-section-title">{td('dialogs.export.origin')}</label>
              <div style={{ fontSize: '13px', color: 'var(--text)', display: 'grid', gap: '6px' }}>
                <div>{td('dialogs.export.originDescription')}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                  {td('dialogs.export.originNote')}
                </div>
              </div>
            </div>

            <div className="dialog-section-group">
              <label className="dialog-section-title">{td('dialogs.export.projectUnits')}</label>
              <div style={{ fontSize: '13px', color: 'var(--text)' }}>
                {project.meta.units === 'inch' ? td('dialogs.common.inch') : td('dialogs.common.millimeter')}
              </div>
            </div>

            <div className="dialog-section-group dialog-section-group--operations">
              <div className="export-operations-header">
                <label className="dialog-section-title">{td('dialogs.export.operations')}</label>
                {exportableOperationIds.length > 0 ? (
                  <button
                    className="export-operations-toggle"
                    type="button"
                    onClick={toggleAllOperationsSelected}
                  >
                    {allExportableSelected ? td('dialogs.importGeometry.deselectAll') : td('dialogs.importGeometry.selectAll')}
                  </button>
                ) : null}
              </div>
              {operationOptions.length === 0 ? (
                <div style={{ fontSize: '13px', color: 'var(--text-dim)' }}>
                  {td('dialogs.export.noOperations')}
                </div>
              ) : (
                <div className="export-option-group export-operation-list">
                  {operationOptions.map(({ operation, exportable, reasonKey }) => (
                    <label
                      key={operation.id}
                      className={`export-option${exportable ? '' : ' export-option--disabled'}`}
                    >
                      <input
                        type="checkbox"
                        disabled={!exportable}
                        checked={exportable && selectedOperationIds.has(operation.id)}
                        onChange={(event) => toggleOperationSelected(operation.id, event.target.checked)}
                      />
                      <span className="export-option-label">{operation.name}</span>
                      {reasonKey ? <span className="export-option-note">{td(reasonKey)}</span> : null}
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="dialog-section-group">
              <label className="dialog-section-title">{td('dialogs.export.options')}</label>
              <div className="export-option-group">
                <label className="export-option">
                  <input
                    type="checkbox"
                    checked={emitToolChanges}
                    onChange={(event) => setEmitToolChanges(event.target.checked)}
                  />
                  {td('dialogs.export.emitToolChanges')}
                </label>
                <label className="export-option">
                  <input
                    type="checkbox"
                    checked={emitCoolant}
                    onChange={(event) => setEmitCoolant(event.target.checked)}
                  />
                  {td('dialogs.export.emitCoolant')}
                </label>
              </div>
            </div>

          </div>

          <div className="dialog-preview-container">
            {previewWarnings.length > 0 && (
              <div className="dialog-section-group">
                <label className="dialog-section-title">{td('dialogs.export.warnings')}</label>
                <div className="export-warning-list">
                  {previewWarnings.map((warning, index) => (
                    <div key={index} className="export-warning">{warning}</div>
                  ))}
                </div>
              </div>
            )}
            <label className="dialog-section-title">{td('dialogs.export.preview')}</label>
            <div className="dialog-preview">
              {previewLines}
              {previewResult && previewResult.gcode.split('\n').length > 30 && `\n${td('dialogs.export.previewTruncated')}`}
            </div>
            {previewResult && (
              <div style={{ fontSize: '11px', color: 'var(--text-dim)', textAlign: 'right' }}>
                {td('dialogs.export.movesLines', { moves: previewResult.stats.moveCount, lines: previewResult.stats.lineCount })}
              </div>
            )}
          </div>
        </div>

        <div className="dialog-footer">
          <button className="btn-secondary" onClick={onClose} type="button">{td('dialogs.common.cancel')}</button>
          {inspectEligible && (
            <button
              className="btn-secondary"
              onClick={() => setDebugOperation(activeOperations[0])}
              disabled={!activeDefinition}
              type="button"
            >
              {td('dialogs.export.inspectMotion')}
            </button>
          )}
          <button
            className="btn-primary"
            onClick={handleExport}
            disabled={!previewResult || !activeDefinition || activeOperations.length === 0}
            type="button"
          >
            {td('dialogs.export.export', { ext: activeDefinition ? `.${activeDefinition.fileExtension}` : '' })}
          </button>
        </div>
      </div>
      {debugOperation && activeDefinition && previewResult && (
        <ExportedMotionDebugDialog
          operation={debugOperation.operation}
          requestGenerationTrace={requestGenerationTrace}
          project={project}
          definition={activeDefinition}
          previewResult={previewResult}
          onClose={() => setDebugOperation(null)}
        />
      )}
    </div>
  )
}
