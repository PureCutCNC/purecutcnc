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

import { Fragment, useState, useMemo } from 'react'
import { useProjectStore } from '../../store/projectStore'
import { useRestoreCanvasFocus } from '../../utils/useRestoreCanvasFocus'
import { platform } from '../../platform'
import {
  formatProgramNumber,
  getActiveMachineDefinition,
  getExportedMotionEligibility,
  projectExportsPerSetup,
} from '../../engine/gcode'
import type { ToolpathResult, ToolpathGenerationTrace, NormalizedTool } from '../../engine/toolpaths/types'
import type { Operation } from '../../types/project'
import type { GenerationContext, ToolpathGenerationService } from '../../app/toolpathGeneration/service'
import { exportHasError, type ExportPostOptions, type PreparedProgram } from '../../app/toolpathGeneration/exportPreparation'
import { useExportPreparation } from '../../app/toolpathGeneration/useExportPreparation'
import {
  groupExportOperationOptions,
  listExportOperationOptions,
  reusableExportPath,
} from './exportOperationSelection'
import { ExportedMotionDebugDialog } from './ExportedMotionDebugDialog'
import { exportDialectLabels } from './exportDialectLabels'
import { dialogsEn } from '../../i18n/locales/en/dialogs'
import type { MessageParams } from '../../i18n/catalog'
import { useI18n } from '../../i18n/i18nContext'
import { toolpathWarningText } from '../../i18n/warningText'
import { warningSeverity } from '../../engine/toolpaths/warningCodes'
import { exportBlockReasonMessage } from './exportBlockReason'

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
  const dialectLabels = exportDialectLabels(activeDefinition)

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

  // One program per setup (issue #946). A project with a single setup has
  // exactly one, and the dialog then looks as it always did.
  const programs = useMemo<PreparedProgram[]>(
    () => (preparation?.status === 'ready' ? preparation.programs : []),
    [preparation],
  )
  const perSetup = projectExportsPerSetup(project)
  const [previewProgramNumber, setPreviewProgramNumber] = useState<number | null>(null)
  const previewProgram = programs.find((program) => program.programNumber === previewProgramNumber) ?? programs[0] ?? null
  const previewResult = previewProgram?.result ?? null
  const activeOperations = useMemo(() => programs.flatMap((program) => program.operations), [programs])
  // Files already written from the programs on screen. A browser may refuse a
  // second save dialog from one click, so an export can take more than one
  // press; this keeps a later press from writing a file twice.
  const [saved, setSaved] = useState<{ tokenId: number; programNumbers: number[] } | null>(null)
  const preparedTokenId = preparation?.status === 'ready' ? preparation.token.id : null
  const savedProgramNumbers = saved !== null && saved.tokenId === preparedTokenId ? saved.programNumbers : []
  const [saveFailedFile, setSaveFailedFile] = useState<string | null>(null)

  function programLabel(program: Pick<PreparedProgram, 'programNumber' | 'setupName'>): string {
    return td('dialogs.export.programLabel', {
      number: formatProgramNumber(program.programNumber),
      setup: program.setupName ?? '',
    })
  }

  type ActiveOperation = { operation: Operation; tool: NormalizedTool; toolpath: ToolpathResult }
  const [debugOperation, setDebugOperation] = useState<ActiveOperation | null>(null)

  // The exported-motion debug view is gated on exactly one eligible operation.
  // Eligibility is derived from the generated motion, not an operation-name list.
  const inspectEligible = useMemo(() => {
    if (activeOperations.length !== 1) return false
    return getExportedMotionEligibility(activeOperations[0].toolpath).eligible
  }, [activeOperations])

  // The engine's codes carry their own severity, so one code lands in the same
  // tier everywhere it is shown; the dialog only decides what to put beside
  // them from live state (issue #755).
  const previewMessages = useMemo(() => {
    const errors: string[] = []
    const warnings: string[] = []

    // Every program's findings, not only the previewed one's: an error in
    // any of them blocks the whole export, so it has to be on screen.
    for (const program of programs) {
      for (const warning of program.result.warnings) {
        const text = programs.length > 1
          ? `${programLabel(program)}: ${toolpathWarningText(warning)}`
          : toolpathWarningText(warning)
        if (warningSeverity(warning.code) === 'error') errors.push(text)
        else warnings.push(text)
      }
    }
    if (saveFailedFile !== null) {
      errors.push(td('dialogs.export.error.saveFailed', { file: saveFailedFile }))
    }

    // A blocked preparation used to just disable Export. The reason is the only
    // thing that says what to change, and no machine or no selection are
    // reported below from live state instead — saying those twice is noise.
    if (preparation?.status === 'blocked') {
      const blocked = exportBlockReasonMessage(
        preparation.reason,
        (operationId) => project.operations.find((operation) => operation.id === operationId)?.name ?? null,
      )
      if (blocked) errors.push(td(blocked.key, blocked.params))
    }

    if (!activeDefinition) {
      errors.push(td('dialogs.export.warning.noMachine'))
    }
    if (operationOptions.length > 0 && selectedOperationIds.size === 0) {
      errors.push(td('dialogs.export.warning.noOperations'))
    }

    return { errors, warnings }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- td wraps stable context t; languageTag drives locale recomputes
  }, [activeDefinition, operationOptions, preparation, programs, project, selectedOperationIds, saveFailedFile, languageTag])

  // The same predicate the save path re-checks, so the button and the bytes
  // cannot disagree about whether these programs may be written.
  const hasProgramError = exportHasError(programs)

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

  // Operations under the setup that cuts them; one unlabelled group for a
  // project with a single setup.
  const operationGroups = useMemo(() => groupExportOperationOptions(project, operationOptions), [project, operationOptions])

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
    if (!exportable || preparedTokenId === null) return

    const ext = activeDefinition.fileExtension
    setSaveFailedFile(null)
    // `exportable` was copied out above and is not re-read from state; the
    // bytes are frozen for these file actions even if the preview moves on.
    const written = [...savedProgramNumbers]
    let lastPath: string | null = null
    for (const program of exportable.programs) {
      if (written.includes(program.programNumber)) continue
      let exportedPath: string | null
      try {
        exportedPath = await platform.saveTextFile(
          program.fileStem,
          program.gcode,
          ext,
          // Only a single-setup project overwrites its last export in place:
          // with one file per setup there is no one path to reuse.
          perSetup ? null : reusableExportPath(lastExportPath, ext),
        )
      } catch {
        // The files written so far stay recorded, so pressing Export again
        // carries on with the rest.
        setSaveFailedFile(`${program.fileStem}.${ext}`)
        return
      }
      if (!exportedPath) return

      // The platform dialog is asynchronous, and another document can be opened
      // while it is up. Marking *that* document exported would attribute this
      // file to a project it did not come from.
      if (contextRef.current.documentKey !== exportable.documentKey) {
        onClose()
        return
      }
      written.push(program.programNumber)
      setSaved({ tokenId: preparedTokenId, programNumbers: [...written] })
      lastPath = exportedPath
    }
    if (lastPath && !perSetup) markExported(lastPath)
    onClose()
  }

  function handleChangeMachine() {
    selectProject()
    onClose()
  }

  const remainingPrograms = programs.filter((program) => !savedProgramNumbers.includes(program.programNumber)).length

  const previewLines = previewResult
    ? previewResult.gcode.split('\n').slice(0, 30).join('\n')
    : td('dialogs.export.previewPlaceholder')

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-header">
          <h2 className="dialog-title">{t(dialectLabels.title)}</h2>
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
                  {operationGroups.map((group) => (
                    <Fragment key={group.setup?.id ?? 'all'}>
                      {group.setup ? (
                        <div className="export-setup-heading" data-setup-face={group.face}>
                          {programLabel({ programNumber: group.programNumber, setupName: group.setup.name })}
                        </div>
                      ) : null}
                      {group.options.map(({ operation, exportable, reasonKey }) => (
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
                    </Fragment>
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
                  {t(dialectLabels.emitToolChanges)}
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
            {previewMessages.errors.length > 0 && (
              <div className="dialog-section-group">
                <label className="dialog-section-title">{td('dialogs.export.errors')}</label>
                <div className="export-warning-list">
                  {previewMessages.errors.map((error, index) => (
                    <div key={index} className="export-error">{error}</div>
                  ))}
                </div>
              </div>
            )}
            {previewMessages.warnings.length > 0 && (
              <div className="dialog-section-group">
                <label className="dialog-section-title">{td('dialogs.export.warnings')}</label>
                <div className="export-warning-list">
                  {previewMessages.warnings.map((warning, index) => (
                    <div key={index} className="export-warning">{warning}</div>
                  ))}
                </div>
              </div>
            )}
            {perSetup && programs.length > 0 ? (
              <div className="dialog-section-group">
                <label className="dialog-section-title">{td('dialogs.export.programs')}</label>
                <div className="export-setup-note">{td('dialogs.export.perSetupNote')}</div>
                <div className="export-program-list" role="group" aria-label={td('dialogs.export.programs')}>
                  {programs.map((program) => (
                    <button
                      key={program.programNumber}
                      type="button"
                      className={`export-program${program === previewProgram ? ' export-program--active' : ''}`}
                      data-setup-face={program.face}
                      aria-pressed={program === previewProgram}
                      onClick={() => setPreviewProgramNumber(program.programNumber)}
                    >
                      <span className="export-program-title">{programLabel(program)}</span>
                      <span className="export-program-file">{`${program.fileStem}.${activeDefinition?.fileExtension ?? ''}`}</span>
                      <span className="export-program-meta">
                        {td(
                          program.operations.length === 1 ? 'dialogs.export.programOperations.one' : 'dialogs.export.programOperations.other',
                          { count: program.operations.length },
                        )}
                        {savedProgramNumbers.includes(program.programNumber) ? ` · ${td('dialogs.export.programSaved')}` : ''}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <label className="dialog-section-title">{td('dialogs.export.preview')}</label>
            <div className="dialog-preview">
              {previewLines}
              {previewResult && previewResult.gcode.split('\n').length > 30 && `\n${td('dialogs.export.previewTruncated')}`}
            </div>
            {previewResult && (
              <div className="export-preview-summary" style={{ fontSize: '11px', color: 'var(--text-dim)', textAlign: 'right' }}>
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
            disabled={!previewResult || !activeDefinition || activeOperations.length === 0 || hasProgramError}
            type="button"
          >
            {remainingPrograms > 1
              ? td('dialogs.export.exportFiles', { count: remainingPrograms })
              : td('dialogs.export.export', { ext: activeDefinition ? `.${activeDefinition.fileExtension}` : '' })}
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
