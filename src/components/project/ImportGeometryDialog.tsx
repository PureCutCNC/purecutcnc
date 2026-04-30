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
import { extractStlProfileAndBounds } from '../../import/stl'
import { useProjectStore } from '../../store/projectStore'
import type { Units } from '../../utils/units'

interface LoadedImportFile {
  fileName: string
  text: string
  dataUrl?: string // For STL
  sourceType: ImportSourceType
  inspection: ImportInspection
}

interface ImportGeometryDialogProps {
  onClose: () => void
  onImportComplete?: () => void
}

function sourceTypeLabel(sourceType: ImportSourceType): string {
  if (sourceType === 'svg') return 'SVG'
  if (sourceType === 'dxf') return 'DXF'
  if (sourceType === 'stl') return 'STL'
  return 'Unknown'
}

function unitsLabel(units: Units): string {
  return units === 'inch' ? 'Inch' : 'Millimeter'
}

function defaultJoinTolerance(units: Units): string {
  return units === 'inch' ? '0.01' : '0.25'
}

function joinToleranceStep(units: Units): string {
  return units === 'inch' ? '0.001' : '0.01'
}

function detectSourceType(fileName: string): ImportSourceType | null {
  const lowerName = fileName.toLowerCase()
  if (lowerName.endsWith('.svg')) return 'svg'
  if (lowerName.endsWith('.dxf')) return 'dxf'
  if (lowerName.endsWith('.stl')) return 'stl'
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
  const [loadingProgress, setLoadingProgress] = useState<number | null>(null)
  const [axisSwap, setAxisSwap] = useState<'none' | 'yz' | 'xz' | 'xy'>('none')
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

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
        if (nextSourceType === 'stl') {
          const dataUrl = String(readerEvent.target?.result ?? '')
          setLoadedFile({
            fileName: file.name,
            text: '',
            dataUrl,
            sourceType: nextSourceType,
            inspection: { layers: [], warnings: [], sourceUnitScale: 1, detectedUnits: null, unitsReliable: false, summary: 'STL file - 3D mesh imported by top-down silhouette projection' }
          })
          setSourceUnits(project.meta.units) // Default to project units for STL
        } else {
          const text = String(readerEvent.target?.result ?? '')
          const inspection = nextSourceType === 'svg' ? inspectSvgString(text) : inspectDxfString(text)
          setLoadedFile({ fileName: file.name, text, sourceType: nextSourceType, inspection })
          setSourceUnits(inspection.detectedUnits ?? '')
        }
        setJoinTolerance(defaultJoinTolerance(project.meta.units))
        setAllowCrossLayerJoins(false)
        if (nextSourceType !== 'stl') {
          const text = String(readerEvent.target?.result ?? '')
          const inspection = nextSourceType === 'svg' ? inspectSvgString(text) : inspectDxfString(text)
          setSelectedLayers(new Set(inspection.layers))
        } else {
          setSelectedLayers(new Set())
        }
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
    if (nextSourceType === 'stl') {
      reader.readAsDataURL(file)
    } else {
      reader.readAsText(file)
    }
  }

  function toggleLayer(layer: string) {
    setSelectedLayers((prev) => {
      const next = new Set(prev)
      if (next.has(layer)) next.delete(layer)
      else next.add(layer)
      return next
    })
  }

  function setAllLayersSelected(value: boolean) {
    setSelectedLayers(value ? new Set(loadedFile?.inspection.layers ?? []) : new Set())
  }

  async function handleImport() {
    if (!loadedFile) {
      setDialogError('Choose an SVG, DXF, or STL file to import.')
      return
    }
    if (!sourceUnits) {
      setDialogError('Source units could not be detected. Choose the source units to continue.')
      return
    }

    setBusy(true)
    setLoadingProgress(0)
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

      let createdIds: string[] = []

      if (loadedFile.sourceType === 'stl') {
        const stlScale = sourceUnits === project.meta.units ? 1 : (sourceUnits === 'inch' ? 25.4 : 1/25.4)
        
        // Wait for WebAssembly to parse and project the STL footprint
        const base64Data = loadedFile.dataUrl?.split(',')[1]
        if (!base64Data) throw new Error('Missing file data')
        
        const stlInfo = await extractStlProfileAndBounds(base64Data, stlScale, axisSwap, (p) => setLoadingProgress(p))
        if (!stlInfo) throw new Error('Failed to parse STL or generate silhouette')

        const { addFeature } = useProjectStore.getState()
        const featureId = crypto.randomUUID()
        
        addFeature({
          id: featureId,
          name: loadedFile.fileName.replace(/\.stl$/i, ''),
          kind: 'stl',
          folderId: null,
          stl: {
            filePath: undefined,
            fileData: loadedFile.dataUrl,
            scale: stlScale,
            axisSwap: axisSwap,
          },
          sketch: {
            profile: stlInfo.profile,
            origin: { x: 0, y: 0 },
            orientationAngle: 0,
            dimensions: [],
            constraints: []
          },
          operation: 'model',
          z_top: stlInfo.z_top,
          z_bottom: stlInfo.z_bottom,
          visible: true,
          locked: false
        })
        createdIds = [featureId]
      } else {
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

        createdIds = importShapes({
          fileName: loadedFile.fileName,
          sourceType: loadedFile.sourceType,
          shapes: result.shapes,
        })
        
        if (result.warnings.length > 0) {
          window.alert(
            `Imported ${createdIds.length} feature${createdIds.length === 1 ? '' : 's'} with warnings:\n\n${result.warnings.join('\n')}`,
          )
        }

        if (createdIds.length === 0) {
          setDialogError(result.warnings[0] ?? 'No importable geometry found in the selected file.')
          setBusy(false)
          return
        }
      }



      onImportComplete?.()
      onClose()
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : 'Failed to import geometry file.')
      setBusy(false)
      setLoadingProgress(null)
    }
  }

  const inspectionWarnings = loadedFile?.inspection.warnings ?? []
  const showJoinTolerance = loadedFile?.sourceType === 'dxf'
  const dxfLayers = loadedFile?.sourceType === 'dxf' ? (loadedFile.inspection.layers ?? []) : []
  const showLayers = dxfLayers.length > 0
  const allLayersSelected = dxfLayers.length > 0 && dxfLayers.every((l) => selectedLayers.has(l))
  const someLayersSelected = dxfLayers.some((l) => selectedLayers.has(l))

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className={`dialog dialog--import${showLayers ? ' dialog--import-with-layers' : ''}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">
          <h2 className="dialog-title">Import Geometry</h2>
          <button className="dialog-close" onClick={onClose} aria-label="Close" type="button">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className={`dialog-body dialog-body--import${showLayers ? ' dialog-body--import-with-layers' : ''}`}>
          {/* ── Left / main settings column ── */}
          <div className="dialog-section">

            {/* File */}
            <div className="dialog-section-group">
              <label className="dialog-section-title">Source File</label>
              <button
                className="btn-secondary import-dialog__file-button"
                type="button"
                onClick={() => fileInputRef.current?.click()}
              >
                {loadedFile ? 'Choose Different File' : 'Choose SVG, DXF, or STL'}
              </button>
              <input ref={fileInputRef} type="file" accept=".svg,.dxf,.stl" onChange={handleFileChange} style={{ display: 'none' }} />
              <div className="import-dialog__file-name">
                {loadedFile ? loadedFile.fileName : 'No file selected.'}
              </div>
            </div>

            {/* File info + settings — only shown once a file is loaded */}
            {loadedFile ? (
              <div className="dialog-section-group">
                <label className="dialog-section-title">Settings</label>

                {/* Format */}
                <div className="import-dialog__info-row">
                  <span>Format</span>
                  <strong>{sourceTypeLabel(loadedFile.sourceType)}</strong>
                </div>

                {/* Source Units */}
                <div className="import-dialog__info-row">
                  <span>Source Units</span>
                  <select
                    value={sourceUnits}
                    onChange={(event) => setSourceUnits(event.target.value as Units)}
                  >
                    <option value="">Select units</option>
                    <option value="mm">Millimeter</option>
                    <option value="inch">Inch</option>
                  </select>
                </div>
                {!loadedFile.inspection.detectedUnits && loadedFile.sourceType !== 'stl' ? (
                  <div className="import-dialog__field-note import-dialog__field-note--warn">
                    Units not detected — choose the source units before importing.
                  </div>
                ) : null}

                {/* Project Units */}
                <div className="import-dialog__info-row">
                  <span>Project Units</span>
                  <strong>{unitsLabel(project.meta.units)}</strong>
                </div>

                {/* Axis Swap (STL Only) */}
                {loadedFile.sourceType === 'stl' ? (
                  <div className="import-dialog__info-row">
                    <span>Axis Orientation</span>
                    <select
                      value={axisSwap}
                      onChange={(event) => setAxisSwap(event.target.value as any)}
                    >
                      <option value="none">Original (Z-Up)</option>
                      <option value="yz">Swap Y / Z (Y-Up)</option>
                      <option value="xz">Swap X / Z</option>
                      <option value="xy">Swap X / Y</option>
                    </select>
                  </div>
                ) : null}

                {/* Join Tolerance */}
                {showJoinTolerance ? (
                  <>
                    <div className="import-dialog__info-row">
                      <span>Join Tolerance ({project.meta.units === 'inch' ? 'in' : 'mm'})</span>
                      <input
                        type="number"
                        min="0"
                        step={joinToleranceStep(project.meta.units)}
                        value={joinTolerance}
                        onChange={(event) => setJoinTolerance(event.target.value)}
                      />
                    </div>

                    {/* Cross-Layer Join */}
                    <label className="import-dialog__toggle-row">
                      <span className="import-dialog__toggle-label">Cross-Layer Join</span>
                      <input
                        className="import-dialog__toggle-input"
                        type="checkbox"
                        checked={allowCrossLayerJoins}
                        onChange={(event) => setAllowCrossLayerJoins(event.target.checked)}
                      />
                    </label>
                  </>
                ) : null}

                {/* Warnings */}
                {inspectionWarnings.length > 0 ? (
                  <div className="export-warning-list">
                    {inspectionWarnings.map((warning) => (
                      <div key={warning} className="export-warning">{warning}</div>
                    ))}
                  </div>
                ) : null}

                {/* Progress */}
                {busy && loadingProgress !== null ? (
                  <div className="import-progress-container">
                    <div className="import-progress-label">Processing STL... {loadingProgress}%</div>
                    <div className="import-progress-track">
                      <div className="import-progress-fill" style={{ width: `${loadingProgress}%` }} />
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* Error */}
            {dialogError ? <div className="cam-field-message">{dialogError}</div> : null}
          </div>

          {/* ── Right column: layers ── */}
          {showLayers ? (
            <div className="import-dialog__layers-column">
              <div className="import-dialog__layers-header">
                <label className="dialog-section-title">Layers</label>
                <button
                  className="import-dialog__layers-toggle"
                  type="button"
                  onClick={() => setAllLayersSelected(!allLayersSelected)}
                >
                  {allLayersSelected ? 'Deselect all' : 'Select all'}
                </button>
              </div>
              <div className="import-dialog__layer-list import-dialog__layer-list--fill">
                {dxfLayers.map((layer) => (
                  <label key={layer} className="import-dialog__layer-row">
                    <input
                      type="checkbox"
                      checked={selectedLayers.has(layer)}
                      onChange={() => toggleLayer(layer)}
                    />
                    <span className="import-dialog__layer-name">{layer}</span>
                  </label>
                ))}
              </div>
              {!someLayersSelected ? (
                <div className="cam-field-message">Select at least one layer to import.</div>
              ) : null}
            </div>
          ) : null}
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
