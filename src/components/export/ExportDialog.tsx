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

import { useState, useMemo, useEffect } from 'react'
import { useProjectStore } from '../../store/projectStore'
import { useRestoreCanvasFocus } from '../../utils/useRestoreCanvasFocus'
import { platform } from '../../platform'
import {
  getActiveMachineDefinition,
  runPostProcessor,
  type PostProcessorResult,
} from '../../engine/gcode'
import { normalizeToolForProject } from '../../engine/toolpaths/geometry'
import type { ToolpathResult } from '../../engine/toolpaths/types'
import type { Operation } from '../../types/project'
import {
  listExportOperationOptions,
  suggestGcodeFileName,
} from './exportOperationSelection'

interface ExportDialogProps {
  onClose: () => void
  generateToolpath: (operation: Operation) => ToolpathResult | null
  /** Pre-check only these operations (per-operation export); defaults to the visible set. */
  initialOperationIds?: string[]
}

export function ExportDialog({ onClose, generateToolpath, initialOperationIds }: ExportDialogProps) {
  useRestoreCanvasFocus()
  const { project, selectProject, lastExportPath, markExported } = useProjectStore()

  const [emitToolChanges, setEmitToolChanges] = useState(true)
  const [emitCoolant, setEmitCoolant] = useState(false)
  const [previewResult, setPreviewResult] = useState<PostProcessorResult | null>(null)
  const [selectedOperationIds, setSelectedOperationIds] = useState<ReadonlySet<string>>(() => {
    const options = listExportOperationOptions(project)
    const selected = initialOperationIds
      ? options.filter((option) => option.exportable && initialOperationIds.includes(option.operation.id))
      : options.filter((option) => option.defaultSelected)
    return new Set(selected.map((option) => option.operation.id))
  })

  const activeDefinition = useMemo(() => getActiveMachineDefinition(project), [project])

  // Clear a stale preview the moment the active definition goes away — adjusting
  // state during render instead of a synchronous setState-in-effect. When a
  // definition is (re)selected, the debounced effect below recomputes the preview.
  const hasDefinition = Boolean(activeDefinition)
  const [hadDefinition, setHadDefinition] = useState(hasDefinition)
  if (hadDefinition !== hasDefinition) {
    setHadDefinition(hasDefinition)
    if (!hasDefinition && previewResult !== null) {
      setPreviewResult(null)
    }
  }

  const operationOptions = useMemo(() => listExportOperationOptions(project), [project])

  const activeOperations = useMemo(() => (
    operationOptions
      .filter((option) => option.exportable && selectedOperationIds.has(option.operation.id))
      .map(({ operation }) => {
        const toolpath = generateToolpath(operation)
        const toolRecord = project.tools.find((tool) => tool.id === operation.toolRef)
        if (!toolpath || !toolRecord) {
          return null
        }

        return {
          operation,
          tool: normalizeToolForProject(toolRecord, project),
          toolpath,
        }
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
  ), [generateToolpath, operationOptions, project, selectedOperationIds])

  const previewWarnings = useMemo(() => {
    const warnings = [...(previewResult?.warnings ?? [])]
    if (operationOptions.length > 0 && selectedOperationIds.size === 0) {
      warnings.unshift('No operations selected. Check at least one operation to export.')
    }
    if (!activeDefinition) {
      warnings.unshift('No machine selected. Select one in Project Settings before exporting.')
    }
    return warnings
  }, [activeDefinition, operationOptions, previewResult, selectedOperationIds])

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

  useEffect(() => {
    if (!activeDefinition) {
      return
    }

    const timer = setTimeout(() => {
      const result = runPostProcessor({
        project,
        operations: activeOperations,
        definition: activeDefinition,
        options: {
          emitToolChanges,
          emitCoolant,
          programName: project.meta.name,
        },
      })
      setPreviewResult(result)
    }, 300)

    return () => clearTimeout(timer)
  }, [activeDefinition, activeOperations, emitCoolant, emitToolChanges, project])

  async function handleExport() {
    if (!previewResult || !activeDefinition || activeOperations.length === 0) return

    const suggestedName = suggestGcodeFileName(
      project.meta.name,
      activeOperations.map(({ operation }) => operation.name),
    )
    const ext = activeDefinition.fileExtension
    const exportedPath = await platform.saveTextFile(suggestedName, previewResult.gcode, ext, lastExportPath)
    if (exportedPath) {
      markExported(exportedPath)
      onClose()
    }
  }

  function handleChangeMachine() {
    selectProject()
    onClose()
  }

  const previewLines = previewResult
    ? previewResult.gcode.split('\n').slice(0, 30).join('\n')
    : 'Select a machine in Project Settings to generate G-code preview.'

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-header">
          <h2 className="dialog-title">Export G-code</h2>
          <button className="dialog-close" onClick={onClose} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="dialog-body dialog-body--gcode-export">
          <div className="dialog-section">
            <div className="dialog-section-group">
              <label className="dialog-section-title">Machine</label>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                <div style={{ fontSize: '13px', color: 'var(--text)' }}>
                  {activeDefinition?.name ?? 'None selected'}
                </div>
                <button className="btn-secondary" onClick={handleChangeMachine} type="button" style={{ padding: '0 12px' }}>
                  Change
                </button>
              </div>
            </div>

            <div className="dialog-section-group">
              <label className="dialog-section-title">Origin</label>
              <div style={{ fontSize: '13px', color: 'var(--text)', display: 'grid', gap: '6px' }}>
                <div>Export uses the current project origin as machine X0 Y0 Z0.</div>
                <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                  Edit Origin in the sketch or project tree to change the work zero used for export.
                </div>
              </div>
            </div>

            <div className="dialog-section-group">
              <label className="dialog-section-title">Project Units</label>
              <div style={{ fontSize: '13px', color: 'var(--text)' }}>
                {project.meta.units === 'inch' ? 'Inch' : 'Millimeter'}
              </div>
            </div>

            <div className="dialog-section-group dialog-section-group--operations">
              <label className="dialog-section-title">Operations</label>
              {operationOptions.length === 0 ? (
                <div style={{ fontSize: '13px', color: 'var(--text-dim)' }}>
                  No operations to export. Add one in the Operations panel.
                </div>
              ) : (
                <div className="export-option-group export-operation-list">
                  {operationOptions.map(({ operation, exportable, reason }) => (
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
                      {reason ? <span className="export-option-note">{reason}</span> : null}
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="dialog-section-group">
              <label className="dialog-section-title">Options</label>
              <div className="export-option-group">
                <label className="export-option">
                  <input
                    type="checkbox"
                    checked={emitToolChanges}
                    onChange={(event) => setEmitToolChanges(event.target.checked)}
                  />
                  Emit tool changes (M6)
                </label>
                <label className="export-option">
                  <input
                    type="checkbox"
                    checked={emitCoolant}
                    onChange={(event) => setEmitCoolant(event.target.checked)}
                  />
                  Emit coolant commands
                </label>
              </div>
            </div>

            {previewWarnings.length > 0 && (
              <div className="dialog-section-group">
                <label className="dialog-section-title">Warnings</label>
                <div className="export-warning-list">
                  {previewWarnings.map((warning, index) => (
                    <div key={index} className="export-warning">{warning}</div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="dialog-preview-container">
            <label className="dialog-section-title">Preview (First 30 lines)</label>
            <div className="dialog-preview">
              {previewLines}
              {previewResult && previewResult.gcode.split('\n').length > 30 && '\n...'}
            </div>
            {previewResult && (
              <div style={{ fontSize: '11px', color: 'var(--text-dim)', textAlign: 'right' }}>
                {previewResult.stats.moveCount} moves, {previewResult.stats.lineCount} lines total
              </div>
            )}
          </div>
        </div>

        <div className="dialog-footer">
          <button className="btn-secondary" onClick={onClose} type="button">Cancel</button>
          <button
            className="btn-primary"
            onClick={handleExport}
            disabled={!previewResult || !activeDefinition || activeOperations.length === 0}
            type="button"
          >
            Export {activeDefinition ? `.${activeDefinition.fileExtension}` : ''}
          </button>
        </div>
      </div>
    </div>
  )
}
