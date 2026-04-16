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

import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { importDxfString, importSvgString, inspectDxfString, inspectSvgString, type ImportInspection, type ImportSourceType } from '../../import'
import { useProjectStore } from '../../store/projectStore'
import type { Units } from '../../utils/units'

interface LoadedImportFile {
  fileName: string
  text: string
  sourceType: ImportSourceType
  inspection: ImportInspection
}

interface ImportGeometryDialogProps {
  onClose: () => void
  onImportComplete?: () => void
}

function sourceTypeLabel(sourceType: ImportSourceType): string {
  return sourceType === 'svg' ? 'SVG' : 'DXF'
}

function unitsLabel(units: Units): string {
  return units === 'inch' ? 'Inch' : 'Millimeter'
}

function defaultJoinTolerance(units: Units): string {
  return units === 'inch' ? '0.02' : '0.5'
}

function joinToleranceStep(units: Units): string {
  return units === 'inch' ? '0.001' : '0.01'
}

function detectSourceType(fileName: string): ImportSourceType | null {
  const lowerName = fileName.toLowerCase()
  if (lowerName.endsWith('.svg')) {
    return 'svg'
  }
  if (lowerName.endsWith('.dxf')) {
    return 'dxf'
  }
  return null
}

export function ImportGeometryDialog({ onClose, onImportComplete }: ImportGeometryDialogProps) {
  const { project, importShapes } = useProjectStore()
  const [loadedFile, setLoadedFile] = useState<LoadedImportFile | null>(null)
  const [sourceUnits, setSourceUnits] = useState<Units | ''>('')
  const [joinTolerance, setJoinTolerance] = useState(defaultJoinTolerance(project.meta.units))
  const [allowCrossLayerJoins, setAllowCrossLayerJoins] = useState(false)
  const [selectedLayers, setSelectedLayers] = useState<Set<string>>(new Set())
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    const nextSourceType = detectSourceType(file.name)
    if (!nextSourceType) {
      setLoadedFile(null)
      setSourceUnits('')
      setJoinTolerance(defaultJoinTolerance(project.meta.units))
      setAllowCrossLayerJoins(false)
      setSelectedLayers(new Set())
      setDialogError('Unsupported import format. Use .svg or .dxf.')
      return
    }

    const reader = new FileReader()
    reader.onload = (readerEvent) => {
      try {
        const text = String(readerEvent.target?.result ?? '')
        const inspection = nextSourceType === 'svg' ? inspectSvgString(text) : inspectDxfString(text)
        setLoadedFile({
          fileName: file.name,
          text,
          sourceType: nextSourceType,
          inspection,
        })
        setSourceUnits(inspection.detectedUnits ?? '')
        setJoinTolerance(defaultJoinTolerance(project.meta.units))
        setAllowCrossLayerJoins(false)
        setSelectedLayers(new Set(inspection.layers))
        setDialogError(null)
      } catch (error) {
        setLoadedFile(null)
        setSourceUnits('')
        setJoinTolerance(defaultJoinTolerance(project.meta.units))
        setAllowCrossLayerJoins(false)
        setSelectedLayers(new Set())
        setDialogError(error instanceof Error ? error.message : 'Failed to inspect geometry file.')
      }
    }
    reader.readAsText(file)
  }

  function toggleLayer(layer: string) {
    setSelectedLayers((prev) => {
      const next = new Set(prev)
      if (next.has(layer)) {
        next.delete(layer)
      } else {
        next.add(layer)
      }
      return next
    })
  }

  function setAllLayersSelected(value: boolean) {
    setSelectedLayers(value ? new Set(loadedFile?.inspection.layers ?? []) : new Set())
  }

  function handleImport() {
    if (!loadedFile) {
      setDialogError('Choose an SVG or DXF file to import.')
      return
    }
    if (!sourceUnits) {
      setDialogError('Source units could not be detected. Choose the source units to continue.')
      return
    }

    setBusy(true)
    setDialogError(null)

    try {
      const keepDetectedScale = loadedFile.inspection.detectedUnits === sourceUnits
      const sourceUnitScale = keepDetectedScale ? loadedFile.inspection.sourceUnitScale : 1
      const parsedJoinTolerance = Number.parseFloat(joinTolerance)
      if (loadedFile.sourceType === 'dxf' && (!Number.isFinite(parsedJoinTolerance) || parsedJoinTolerance < 0)) {
        setDialogError('Join tolerance must be a non-negative number.')
        setBusy(false)
        return
      }

      const hasDxfLayers = loadedFile.sourceType === 'dxf' && loadedFile.inspection.layers.length > 0
      const layerFilter = hasDxfLayers ? [...selectedLayers] : null

      const result = loadedFile.sourceType === 'svg'
        ? importSvgString(loadedFile.text, {
          fileName: loadedFile.fileName,
          targetUnits: project.meta.units,
          sourceUnits,
          sourceUnitScale,
        })
        : importDxfString(loadedFile.text, {
          fileName: loadedFile.fileName,
          targetUnits: project.meta.units,
          sourceUnits,
          sourceUnitScale,
          joinTolerance: parsedJoinTolerance,
          allowCrossLayerJoins,
          layerFilter,
        })

      const createdIds = importShapes({
        fileName: loadedFile.fileName,
        sourceType: loadedFile.sourceType,
        shapes: result.shapes,
      })

      if (createdIds.length === 0) {
        setDialogError(result.warnings[0] ?? 'No importable geometry found in the selected file.')
        setBusy(false)
        return
      }

      if (result.warnings.length > 0) {
        window.alert(
          `Imported ${createdIds.length} feature${createdIds.length === 1 ? '' : 's'} with warnings:\n\n${result.warnings.join('\n')}`,
        )
      }

      onImportComplete?.()
      onClose()
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : 'Failed to import geometry file.')
      setBusy(false)
    }
  }

  const inspectionWarnings = loadedFile?.inspection.warnings ?? []
  const detectionKnown = Boolean(loadedFile?.inspection.detectedUnits)
  const showJoinTolerance = loadedFile?.sourceType === 'dxf'
  const dxfLayers = loadedFile?.sourceType === 'dxf' ? (loadedFile.inspection.layers ?? []) : []
  const showLayers = dxfLayers.length > 0
  const allLayersSelected = dxfLayers.length > 0 && dxfLayers.every((l) => selectedLayers.has(l))
  const someLayersSelected = dxfLayers.some((l) => selectedLayers.has(l))

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog dialog--import" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-header">
          <h2 className="dialog-title">Import Geometry</h2>
          <button className="dialog-close" onClick={onClose} aria-label="Close" type="button">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="dialog-body dialog-body--import">
          <div className="dialog-section">
            <div className="dialog-section-group">
              <label className="dialog-section-title">Source File</label>
              <button className="btn-secondary import-dialog__file-button" type="button" onClick={() => fileInputRef.current?.click()}>
                {loadedFile ? 'Choose Different File' : 'Choose SVG or DXF'}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".svg,.dxf"
                onChange={handleFileChange}
                style={{ display: 'none' }}
              />
              <div className="import-dialog__file-name">
                {loadedFile ? loadedFile.fileName : 'No file selected.'}
              </div>
            </div>

            <div className="dialog-section-group">
              <label className="dialog-section-title" htmlFor="import-source-units">Source Units</label>
              <div className="properties-field import-dialog__units-field">
                <span>Units</span>
                <select
                  id="import-source-units"
                  value={sourceUnits}
                  onChange={(event) => setSourceUnits(event.target.value as Units)}
                  disabled={!loadedFile}
                >
                  <option value="">Select units</option>
                  <option value="mm">Millimeter</option>
                  <option value="inch">Inch</option>
                </select>
              </div>
              {!detectionKnown && loadedFile ? (
                <div className="cam-field-message">
                  Source units were not detected from the file. Choose the intended units before importing.
                </div>
              ) : null}
              {showJoinTolerance ? (
                <>
                  <div className="properties-field import-dialog__units-field">
                    <span>Join Tolerance ({project.meta.units === 'inch' ? 'in' : 'mm'})</span>
                    <input
                      type="number"
                      min="0"
                      step={joinToleranceStep(project.meta.units)}
                      value={joinTolerance}
                      onChange={(event) => setJoinTolerance(event.target.value)}
                      disabled={!loadedFile}
                    />
                  </div>
                  <div className="import-dialog__field-note">
                    Connect open path endpoints within this distance. Always in project units — independent of the source units selected above.
                  </div>
                  <label className="import-dialog__toggle-row">
                    <span className="import-dialog__toggle-label">Cross-Layer Join</span>
                    <input
                      className="import-dialog__toggle-input"
                      type="checkbox"
                      checked={allowCrossLayerJoins}
                      onChange={(event) => setAllowCrossLayerJoins(event.target.checked)}
                      disabled={!loadedFile}
                    />
                  </label>
                  <div className="import-dialog__field-note">
                    Allow endpoint stitching even when touching shapes come from different DXF layers.
                  </div>
                </>
              ) : null}
              {dialogError ? <div className="cam-field-message">{dialogError}</div> : null}
            </div>

            {showLayers ? (
              <div className="dialog-section-group">
                <div className="import-dialog__layers-header">
                  <label className="dialog-section-title">Layers</label>
                  <div className="import-dialog__layers-actions">
                    <button
                      className="import-dialog__layers-toggle"
                      type="button"
                      onClick={() => setAllLayersSelected(!allLayersSelected)}
                      disabled={!loadedFile}
                    >
                      {allLayersSelected ? 'Deselect all' : 'Select all'}
                    </button>
                  </div>
                </div>
                <div className="import-dialog__layer-list">
                  {dxfLayers.map((layer) => (
                    <label key={layer} className="import-dialog__layer-row">
                      <input
                        type="checkbox"
                        checked={selectedLayers.has(layer)}
                        onChange={() => toggleLayer(layer)}
                        disabled={!loadedFile}
                      />
                      <span className="import-dialog__layer-name">{layer}</span>
                    </label>
                  ))}
                </div>
                {!someLayersSelected && loadedFile ? (
                  <div className="cam-field-message">Select at least one layer to import.</div>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="dialog-preview-container">
            <label className="dialog-section-title">Import Preview</label>
            <div className="dialog-preview import-dialog__preview">
              {loadedFile ? (
                <div className="project-template-preview__content">
                  <div className="project-template-preview__title">{loadedFile.fileName}</div>
                  <div className="project-template-preview__row">
                    <span>Format</span>
                    <strong>{sourceTypeLabel(loadedFile.sourceType)}</strong>
                  </div>
                  <div className="project-template-preview__row">
                    <span>Detected Units</span>
                    <strong>{loadedFile.inspection.detectedUnits ? unitsLabel(loadedFile.inspection.detectedUnits) : 'Unknown'}</strong>
                  </div>
                  <div className="project-template-preview__row">
                    <span>Project Units</span>
                    <strong>{unitsLabel(project.meta.units)}</strong>
                  </div>
                  {showJoinTolerance ? (
                    <div className="project-template-preview__row">
                      <span>Join Tolerance</span>
                      <strong>{joinTolerance || defaultJoinTolerance(project.meta.units)} {project.meta.units}</strong>
                    </div>
                  ) : null}
                  {showJoinTolerance ? (
                    <div className="project-template-preview__row">
                      <span>Cross-Layer Join</span>
                      <strong>{allowCrossLayerJoins ? 'On' : 'Off'}</strong>
                    </div>
                  ) : null}
                  {showLayers ? (
                    <div className="project-template-preview__row">
                      <span>Layers</span>
                      <strong>{selectedLayers.size} / {dxfLayers.length} selected</strong>
                    </div>
                  ) : null}
                  <div className="project-template-preview__row">
                    <span>Detection</span>
                    <strong>{loadedFile.inspection.unitsReliable ? 'Confirmed' : 'Needs review'}</strong>
                  </div>
                  <div className="import-dialog__summary">{loadedFile.inspection.summary}</div>
                  {inspectionWarnings.length > 0 ? (
                    <div className="export-warning-list">
                      {inspectionWarnings.map((warning) => (
                        <div key={warning} className="export-warning">{warning}</div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="project-template-preview__empty">
                  Choose an SVG or DXF file to inspect its source units before importing.
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="dialog-footer">
          <button className="btn-secondary" onClick={onClose} type="button">Cancel</button>
          <button
            className="btn-primary"
            onClick={handleImport}
            type="button"
            disabled={!loadedFile || !sourceUnits || busy || (showLayers && !someLayersSelected)}
          >
            Import
          </button>
        </div>
      </div>
    </div>
  )
}
