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
import {
  getActiveMachineDefinition,
  runPostProcessor,
  type PostProcessorResult,
} from '../../engine/gcode'
import { normalizeToolForProject } from '../../engine/toolpaths/geometry'
import type { ToolpathResult } from '../../engine/toolpaths/types'
import type { Operation } from '../../types/project'

interface ExportDialogProps {
  onClose: () => void
  generateToolpath: (operation: Operation) => ToolpathResult | null
}

export function ExportDialog({ onClose, generateToolpath }: ExportDialogProps) {
  const { project, selectProject } = useProjectStore()

  const [emitToolChanges, setEmitToolChanges] = useState(true)
  const [emitCoolant, setEmitCoolant] = useState(false)
  const [previewResult, setPreviewResult] = useState<PostProcessorResult | null>(null)

  const activeDefinition = useMemo(() => getActiveMachineDefinition(project), [project])

  const activeOperations = useMemo(() => (
    project.operations
      .filter((op) => op.enabled && op.showToolpath && op.toolRef)
      .map((op) => {
        const toolpath = generateToolpath(op)
        const toolRecord = project.tools.find((tool) => tool.id === op.toolRef)
        if (!toolpath || !toolRecord) {
          return null
        }

        return {
          operation: op,
          tool: normalizeToolForProject(toolRecord, project),
          toolpath,
        }
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
  ), [generateToolpath, project])

  const previewWarnings = useMemo(() => {
    const warnings = [...(previewResult?.warnings ?? [])]
    if (!activeDefinition) {
      warnings.unshift('No machine selected. Select one in Project Settings before exporting.')
    }
    return warnings
  }, [activeDefinition, previewResult])

  useEffect(() => {
    if (!activeDefinition) {
      setPreviewResult(null)
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

  function handleDownload() {
    if (!previewResult || !activeDefinition) {
      return
    }

    const blob = new Blob([previewResult.gcode], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${project.meta.name.replace(/\s+/g, '_')}.${activeDefinition.fileExtension}`
    anchor.click()
    URL.revokeObjectURL(url)
    onClose()
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

        <div className="dialog-body">
          <div className="dialog-section">
            <div className="dialog-section-group">
              <label className="dialog-section-title">Machine</label>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                <div style={{ fontSize: '13px', color: 'var(--text)' }}>
                  {activeDefinition?.name ?? 'None selected'}
                </div>
                <button className="btn-secondary" onClick={handleChangeMachine} type="button" style={{ height: '32px', padding: '0 12px' }}>
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
            onClick={handleDownload}
            disabled={!previewResult || !activeDefinition}
            type="button"
          >
            Download {activeDefinition ? `.${activeDefinition.fileExtension}` : ''}
          </button>
        </div>
      </div>
    </div>
  )
}
