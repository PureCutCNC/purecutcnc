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
import type { CSSProperties, ChangeEvent } from 'react'
import { importDxfString, importSvgString, inspectDxfString, inspectSvgString, type ImportInspection, type ImportSourceType } from '../../import'
import {
  clampImportedMeshSilhouetteZSteps,
  extractImportedMeshProfileAndBounds,
  renderImportedMeshTopViewToDataUrl,
} from '../../import/stl'
import { useProjectStore } from '../../store/projectStore'
import {
  clearImportedSourceCaches,
  loadImportedTriangleMesh,
  normalizeImportedMeshForStorage,
  serializeImportedMesh,
  type ImportedModelFormat,
  type ModelAxisOrientation,
} from '../../engine/importedMesh'
import type { Units } from '../../utils/units'

interface LoadedImportFile {
  fileName: string
  text: string
  modelBuffer?: ArrayBuffer
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
  if (sourceType === 'obj') return 'OBJ'
  return 'Unknown'
}

function isModelSourceType(sourceType: ImportSourceType): sourceType is ImportedModelFormat {
  return sourceType === 'stl' || sourceType === 'obj'
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

function defaultSilhouetteZStepSize(units: Units): number {
  return units === 'inch' ? 0.02 : 0.5
}

function recommendedSilhouetteZSteps(modelHeight: number, units: Units): number {
  if (!(modelHeight > 0)) return clampImportedMeshSilhouetteZSteps(96)
  return clampImportedMeshSilhouetteZSteps(Math.ceil(modelHeight / defaultSilhouetteZStepSize(units)))
}

function parseSilhouetteZStepsInput(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed) || parsed < 8 || parsed > 512) {
    throw new Error('Silhouette Z steps must be between 8 and 512.')
  }
  return parsed
}

function detectSourceType(fileName: string): ImportSourceType | null {
  const lowerName = fileName.toLowerCase()
  if (lowerName.endsWith('.svg')) return 'svg'
  if (lowerName.endsWith('.dxf')) return 'dxf'
  if (lowerName.endsWith('.stl')) return 'stl'
  if (lowerName.endsWith('.obj')) return 'obj'
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
  const [loadingStage, setLoadingStage] = useState<string>('Processing model')
  const [axisSwap, setAxisSwap] = useState<'none' | 'yz' | 'xz' | 'xy'>('none')
  const [silhouetteZSteps, setSilhouetteZSteps] = useState('')
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
      setSilhouetteZSteps('')
      setDialogError('Unsupported import format. Use .svg, .dxf, .stl, or .obj.')
      return
    }

    const reader = new FileReader()
    reader.onload = (readerEvent) => {
      try {
        if (isModelSourceType(nextSourceType)) {
          const modelBuffer = readerEvent.target?.result
          if (!(modelBuffer instanceof ArrayBuffer)) throw new Error('Failed to read model file.')
          const label = sourceTypeLabel(nextSourceType)
          setLoadedFile({
            fileName: file.name,
            text: '',
            modelBuffer,
            sourceType: nextSourceType,
            inspection: { layers: [], warnings: [], sourceUnitScale: 1, detectedUnits: null, unitsReliable: false, summary: `${label} file - 3D mesh imported by top-down silhouette projection` }
          })
          setSourceUnits(project.meta.units)
        } else {
          const text = String(readerEvent.target?.result ?? '')
          const inspection = nextSourceType === 'svg' ? inspectSvgString(text) : inspectDxfString(text)
          setLoadedFile({ fileName: file.name, text, sourceType: nextSourceType, inspection })
          setSourceUnits(inspection.detectedUnits ?? '')
        }
        setJoinTolerance(defaultJoinTolerance(project.meta.units))
        setAllowCrossLayerJoins(false)
        setSilhouetteZSteps('')
        if (!isModelSourceType(nextSourceType)) {
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
        setSilhouetteZSteps('')
        setDialogError(error instanceof Error ? error.message : 'Failed to inspect geometry file.')
      }
    }
    if (isModelSourceType(nextSourceType)) {
      reader.readAsArrayBuffer(file)
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
      setDialogError('Choose an SVG, DXF, STL, or OBJ file to import.')
      return
    }
    if (!sourceUnits) {
      setDialogError('Source units could not be detected. Choose the source units to continue.')
      return
    }

    setBusy(true)
    setLoadingProgress(0)
    setLoadingStage('Preparing import')
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

      if (isModelSourceType(loadedFile.sourceType)) {
        const modelFormat = loadedFile.sourceType
        const modelLabel = sourceTypeLabel(loadedFile.sourceType)
        const modelScale = sourceUnits === project.meta.units ? 1 : (sourceUnits === 'inch' ? 25.4 : 1/25.4)
        const requestedSilhouetteZSteps = parseSilhouetteZStepsInput(silhouetteZSteps)
        
        const fileData = loadedFile.modelBuffer
        if (!fileData) throw new Error('Missing file data')

        setLoadingStage('Parsing mesh')
        setLoadingProgress(5)
        let parsedMesh = loadImportedTriangleMesh(modelFormat, fileData, axisSwap)
        if (!parsedMesh) throw new Error(`Failed to parse ${modelLabel} mesh`)
        setLoadingProgress(12)

        setLoadingStage('Normalizing mesh')
        const importedMesh = normalizeImportedMeshForStorage(parsedMesh, modelScale)
        parsedMesh = null
        clearImportedSourceCaches()
        const automaticSilhouetteZSteps = recommendedSilhouetteZSteps(
          importedMesh.bounds.maxZ - importedMesh.bounds.minZ,
          project.meta.units,
        )
        const resolvedSilhouetteZSteps = requestedSilhouetteZSteps ?? automaticSilhouetteZSteps
        
        setLoadingStage(`Projecting silhouette (${resolvedSilhouetteZSteps} Z steps)`)
        setLoadingProgress(15)
        const modelInfo = await extractImportedMeshProfileAndBounds(importedMesh, (p) => {
          setLoadingProgress(15 + Math.round(p * 0.7))
        }, { silhouetteZSteps: resolvedSilhouetteZSteps })
        if (!modelInfo) throw new Error(`Failed to parse ${modelLabel} or generate silhouette`)

        setLoadingStage('Preparing preview')
        setLoadingProgress(88)
        let topViewDataUrl: string | undefined
        try {
          const url = renderImportedMeshTopViewToDataUrl(importedMesh)
          if (url) topViewDataUrl = url
        } catch {
          // top-view rendering is best-effort
        }

        setLoadingStage('Storing model')
        setLoadingProgress(95)
        const { addFeature } = useProjectStore.getState()
        const featureId = crypto.randomUUID()
        
        addFeature({
          id: featureId,
          name: loadedFile.fileName.replace(/\.(stl|obj)$/i, ''),
          kind: 'stl',
          folderId: null,
          stl: {
            format: modelFormat,
            filePath: undefined,
            mesh: serializeImportedMesh(importedMesh, modelFormat),
            scale: 1,
            axisSwap: 'none',
            silhouettePaths: modelInfo.silhouettePaths,
            topViewDataUrl,
          },
          sketch: {
            profile: modelInfo.profile,
            origin: { x: 0, y: 0 },
            orientationAngle: 0,
            dimensions: [],
            constraints: []
          },
          operation: 'model',
          z_top: modelInfo.z_top,
          z_bottom: modelInfo.z_bottom,
          visible: true,
          locked: false
        })
        setLoadingProgress(100)
        createdIds = [featureId]
      } else {
        setLoadingStage('Importing geometry')
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
      setLoadingStage('Processing model')
    }
  }

  const inspectionWarnings = loadedFile?.inspection.warnings ?? []
  const showJoinTolerance = loadedFile?.sourceType === 'dxf'
  const dxfLayers = loadedFile?.sourceType === 'dxf' ? (loadedFile.inspection.layers ?? []) : []
  const showLayers = dxfLayers.length > 0
  const allLayersSelected = dxfLayers.length > 0 && dxfLayers.every((l) => selectedLayers.has(l))
  const someLayersSelected = dxfLayers.some((l) => selectedLayers.has(l))
  const progressPercent = Math.min(100, Math.max(0, loadingProgress ?? 0))
  const progressStyle = { '--progress': String(progressPercent / 100) } as CSSProperties

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
                {loadedFile ? 'Choose Different File' : 'Choose SVG, DXF, STL, or OBJ'}
              </button>
              <input ref={fileInputRef} type="file" accept=".svg,.dxf,.stl,.obj" onChange={handleFileChange} style={{ display: 'none' }} />
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
                {!loadedFile.inspection.detectedUnits && !isModelSourceType(loadedFile.sourceType) ? (
                  <div className="import-dialog__field-note import-dialog__field-note--warn">
                    Units not detected — choose the source units before importing.
                  </div>
                ) : null}

                {/* Project Units */}
                <div className="import-dialog__info-row">
                  <span>Project Units</span>
                  <strong>{unitsLabel(project.meta.units)}</strong>
                </div>

                {/* Axis orientation for imported 3D models */}
                {isModelSourceType(loadedFile.sourceType) ? (
                  <div className="import-dialog__info-row">
                    <span>Axis Orientation</span>
                    <select
                      value={axisSwap}
                      onChange={(event) => setAxisSwap(event.target.value as ModelAxisOrientation)}
                    >
                      <option value="none">Original (Z-Up)</option>
                      <option value="yz">Swap Y / Z (Y-Up)</option>
                      <option value="xz">Swap X / Z</option>
                      <option value="xy">Swap X / Y</option>
                    </select>
                  </div>
                ) : null}

                {isModelSourceType(loadedFile.sourceType) ? (
                  <div className="import-dialog__info-row">
                    <span>Silhouette Z Steps</span>
                    <input
                      type="number"
                      min="8"
                      max="512"
                      step="1"
                      placeholder="Auto"
                      value={silhouetteZSteps}
                      onChange={(event) => setSilhouetteZSteps(event.target.value)}
                    />
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
                    <div className="import-progress-label">{loadingStage}... {progressPercent}%</div>
                    <div className="import-progress-track">
                      <div className="import-progress-fill" style={progressStyle} />
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
