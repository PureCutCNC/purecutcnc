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
import type { CSSProperties, ChangeEvent } from 'react'
import { useRestoreCanvasFocus } from '../../utils/useRestoreCanvasFocus'
import {
  inspectCamjString,
  inspectDxfString,
  inspectSvgString,
  type CamjInspection,
  type ImportGeometryMode,
  type ImportInspection,
  type ImportSourceType,
} from '../../import'
import { useProjectStore } from '../../store/projectStore'
import {
  type ImportedModelFormat,
  type ModelAxisOrientation,
} from '../../engine/importedMesh'
import type { Units } from '../../utils/units'
import { useImportGeometryAnalysis } from './useImportGeometryAnalysis'
import { ImportGeometryModeSection } from './ImportGeometryModeSection'
import { importModelFile } from './importModelFile'
import { dialogsEn } from '../../i18n/locales/en/dialogs'
import { dialogsZhCN } from '../../i18n/locales/zh-CN/dialogs'
import { interpolate } from '../../i18n/catalog'
import type { MessageParams } from '../../i18n/catalog'
import { useI18n } from '../../i18n/i18nContext'

interface LoadedImportFile {
  fileName: string
  text: string
  modelBuffer?: ArrayBuffer
  sourceType: ImportSourceType
  inspection: ImportInspection
  camj?: CamjInspection
}

interface ImportGeometryDialogProps {
  onClose: () => void
  onImportComplete?: () => void
}

function sourceTypeLabel(sourceType: ImportSourceType, td: (key: keyof typeof dialogsEn) => string): string {
  if (sourceType === 'svg') return 'SVG'
  if (sourceType === 'dxf') return 'DXF'
  if (sourceType === 'stl') return 'STL'
  if (sourceType === 'obj') return 'OBJ'
  if (sourceType === 'camj') return td('dialogs.importGeometry.formatLabel.camj')
  return td('dialogs.importGeometry.formatLabel.unknown')
}

function isModelSourceType(sourceType: ImportSourceType): sourceType is ImportedModelFormat {
  return sourceType === 'stl' || sourceType === 'obj'
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
  if (lowerName.endsWith('.obj')) return 'obj'
  if (lowerName.endsWith('.camj')) return 'camj'
  return null
}

export function ImportGeometryDialog({ onClose, onImportComplete }: ImportGeometryDialogProps) {
  useRestoreCanvasFocus()
  const { project, importShapes, importCamjFolders } = useProjectStore()
  const { localeId } = useI18n()

  function td(key: keyof typeof dialogsEn, params?: MessageParams): string {
    const catalog = localeId === 'zh-CN' ? dialogsZhCN : dialogsEn
    const template = (catalog as Record<string, string>)[key] ?? dialogsEn[key]
    return interpolate(template, params)
  }

  const [loadedFile, setLoadedFile] = useState<LoadedImportFile | null>(null)
  const [sourceUnits, setSourceUnits] = useState<Units | ''>('')
  const [joinTolerance, setJoinTolerance] = useState(defaultJoinTolerance(project.meta.units))
  const [allowCrossLayerJoins, setAllowCrossLayerJoins] = useState(false)
  const [selectedLayers, setSelectedLayers] = useState<Set<string>>(new Set())
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadingProgress, setLoadingProgress] = useState<number | null>(null)
  const [loadingStage, setLoadingStage] = useState<string>(() => td('dialogs.importGeometry.processingModel'))
  const [axisSwap, setAxisSwap] = useState<'none' | 'yz' | 'xz' | 'xy'>('none')
  const [silhouetteZSteps, setSilhouetteZSteps] = useState('')
  const [importStock, setImportStock] = useState(false)
  const [geometryMode, setGeometryMode] = useState<ImportGeometryMode>('auto')
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // ── analysis hook (SVG/DXF parse + classify) ──────────────────────────
  const sourceType = loadedFile?.sourceType
  const fileText = loadedFile?.text
  const parsedJoinTolerance = Number.parseFloat(joinTolerance)
  const effectiveSourceUnitScale =
    loadedFile?.inspection.detectedUnits === sourceUnits
      ? (loadedFile?.inspection.sourceUnitScale ?? 1)
      : 1

  const {
    cachedShapes,
    parseWarnings,
    parseError,
    classification,
  } = useImportGeometryAnalysis({
    sourceType,
    fileText,
    fileName: loadedFile?.fileName ?? '',
    sourceUnits,
    targetUnits: project.meta.units,
    joinTolerance: Number.isFinite(parsedJoinTolerance) && parsedJoinTolerance >= 0
      ? parsedJoinTolerance
      : 0,
    allowCrossLayerJoins,
    selectedLayers,
    geometryMode,
    sourceUnitScale: effectiveSourceUnitScale,
    hasDxfLayers: (loadedFile?.inspection.layers?.length ?? 0) > 0,
  })

  // ── combined warnings (deduplicated parse + classifier) ───────────────
  const combinedWarnings = useMemo(() => {
    const classWarnings = classification?.result.warnings ?? []
    const seen = new Set<string>()
    const out: string[] = []
    for (const w of [...parseWarnings, ...classWarnings]) {
      if (!seen.has(w)) {
        seen.add(w)
        out.push(w)
      }
    }
    return out
  }, [parseWarnings, classification])

  // ── file loading ──────────────────────────────────────────────────────
  function resetDialogState() {
    setSourceUnits('')
    setJoinTolerance(defaultJoinTolerance(project.meta.units))
    setAllowCrossLayerJoins(false)
    setSelectedLayers(new Set())
    setSilhouetteZSteps('')
    setImportStock(false)
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    const nextSourceType = detectSourceType(file.name)
    if (!nextSourceType) {
      setLoadedFile(null)
      resetDialogState()
      setDialogError(td('dialogs.importGeometry.error.unsupportedFormat'))
      return
    }

    const reader = new FileReader()
    reader.onload = (readerEvent) => {
      try {
        if (isModelSourceType(nextSourceType)) {
          const modelBuffer = readerEvent.target?.result
          if (!(modelBuffer instanceof ArrayBuffer)) throw new Error('Failed to read model file.')
          const label = sourceTypeLabel(nextSourceType, td)
          setLoadedFile({
            fileName: file.name,
            text: '',
            modelBuffer,
            sourceType: nextSourceType,
            inspection: {
              layers: [],
              warnings: [],
              sourceUnitScale: 1,
              detectedUnits: null,
              unitsReliable: false,
              summary: `${label} file - 3D mesh imported by top-down silhouette projection`,
            },
          })
          setSourceUnits(project.meta.units)
          setSelectedLayers(new Set())
        } else if (nextSourceType === 'camj') {
          const text = String(readerEvent.target?.result ?? '')
          const camjInspection = inspectCamjString(text)
          if (camjInspection.folderIds.length === 0) {
            throw new Error(td('dialogs.importGeometry.error.noCamjFolders'))
          }
          setLoadedFile({
            fileName: file.name,
            text,
            sourceType: nextSourceType,
            inspection: {
              layers: camjInspection.folderIds,
              warnings: camjInspection.warnings,
              sourceUnitScale: 1,
              detectedUnits: camjInspection.sourceUnits,
              unitsReliable: true,
              summary: `${sourceTypeLabel(nextSourceType, td)} - ${camjInspection.folderIds.length} importable folder${camjInspection.folderIds.length === 1 ? '' : 's'}`,
            },
            camj: camjInspection,
          })
          setSourceUnits(camjInspection.sourceUnits)
          setSelectedLayers(new Set(camjInspection.folderIds))
        } else {
          const text = String(readerEvent.target?.result ?? '')
          const inspection = nextSourceType === 'svg' ? inspectSvgString(text) : inspectDxfString(text)
          setLoadedFile({ fileName: file.name, text, sourceType: nextSourceType, inspection })
          setSourceUnits(inspection.detectedUnits ?? '')
          setSelectedLayers(new Set(inspection.layers))
        }
        setJoinTolerance(defaultJoinTolerance(project.meta.units))
        setAllowCrossLayerJoins(false)
        setSilhouetteZSteps('')
        setImportStock(false)
        setDialogError(null)
      } catch (error) {
        setLoadedFile(null)
        resetDialogState()
        setDialogError(error instanceof Error ? error.message : td('dialogs.importGeometry.error.inspectFailed'))
      }
    }
    if (isModelSourceType(nextSourceType)) {
      reader.readAsArrayBuffer(file)
    } else {
      reader.readAsText(file)
    }
  }

  // ── layer / folder selection ──────────────────────────────────────────
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

  // ── import ────────────────────────────────────────────────────────────
  async function handleImport() {
    if (!loadedFile) {
      setDialogError(td('dialogs.importGeometry.error.chooseFile'))
      return
    }
    if (!sourceUnits) {
      setDialogError(td('dialogs.importGeometry.error.sourceUnits'))
      return
    }

    setBusy(true)
    setLoadingProgress(0)
    setLoadingStage(td('dialogs.importGeometry.preparingImport'))
    setDialogError(null)

    try {
      const tolerance = Number.parseFloat(joinTolerance)
      if (loadedFile.sourceType === 'dxf' && (!Number.isFinite(tolerance) || tolerance < 0)) {
        setDialogError(td('dialogs.importGeometry.error.joinTolerance'))
        setBusy(false)
        return
      }

      let createdIds: string[] = []

      if (loadedFile.sourceType === 'camj') {
        const camj = loadedFile.camj
        if (!camj) throw new Error('Missing .camj inspection data.')
        const selectedFolderIds = [...selectedLayers]
        const wantsStock = importStock && camj.stockIsFeatureBased
        if (selectedFolderIds.length === 0 && !wantsStock) {
          setDialogError(td('dialogs.importGeometry.error.selectFolder'))
          setBusy(false)
          return
        }
        setLoadingStage(td('dialogs.importGeometry.mergingFolders'))
        createdIds = importCamjFolders({
          fileName: loadedFile.fileName,
          sourceProject: camj.project,
          selectedFolderIds,
          importStock: wantsStock,
        })
        if (createdIds.length === 0 && !wantsStock) {
          setDialogError(td('dialogs.importGeometry.error.noFeaturesImported'))
          setBusy(false)
          return
        }
        setLoadingProgress(100)
      } else if (isModelSourceType(loadedFile.sourceType)) {
        const modelBuffer = loadedFile.modelBuffer
        if (!modelBuffer) throw new Error('Missing file data')
        createdIds = await importModelFile({
          modelFormat: loadedFile.sourceType,
          modelBuffer,
          fileName: loadedFile.fileName,
          projectUnits: project.meta.units,
          sourceUnits: sourceUnits as Units,
          axisSwap,
          silhouetteZSteps,
          onProgress: (stage, pct) => { setLoadingStage(stage); setLoadingProgress(pct) },
        })
      } else {
        // SVG / DXF import — use pre-parsed shapes and classification
        setLoadingStage(td('dialogs.importGeometry.importingGeometry'))
        if (!cachedShapes || cachedShapes.length === 0) {
          setDialogError(td('dialogs.importGeometry.error.noGeometryFound'))
          setBusy(false)
          return
        }

        createdIds = importShapes({
          fileName: loadedFile.fileName,
          sourceType: loadedFile.sourceType,
          shapes: cachedShapes,
          classified: classification?.classified,
        })

        if (combinedWarnings.length > 0) {
          const alertKey = createdIds.length === 1
            ? 'dialogs.importGeometry.importedFeaturesWarnings.one' as const
            : 'dialogs.importGeometry.importedFeaturesWarnings.other' as const
          window.alert(td(alertKey, { count: createdIds.length, warnings: combinedWarnings.join('\n') }))
        }

        if (createdIds.length === 0) {
          setDialogError(combinedWarnings[0] ?? td('dialogs.importGeometry.error.noGeometryFound'))
          setBusy(false)
          return
        }
      }

      onImportComplete?.()
      onClose()
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : td('dialogs.importGeometry.error.importFailed'))
      setBusy(false)
      setLoadingProgress(null)
      setLoadingStage(td('dialogs.importGeometry.processingModel'))
    }
  }

  // ── derived display values ────────────────────────────────────────────
  const inspectionWarnings = loadedFile?.inspection.warnings ?? []
  const isSvgDxf = sourceType === 'svg' || sourceType === 'dxf'
  const isCamj = loadedFile?.sourceType === 'camj'
  const showJoinTolerance = loadedFile?.sourceType === 'dxf'
  const dxfLayers = loadedFile?.sourceType === 'dxf' ? (loadedFile.inspection.layers ?? []) : []
  const camjFolderIds = isCamj ? (loadedFile?.camj?.folderIds ?? []) : []
  const showDxfLayers = dxfLayers.length > 0
  const showCamjFolders = camjFolderIds.length > 0
  const showLayers = showDxfLayers || showCamjFolders
  const allDxfLayersSelected = dxfLayers.length > 0 && dxfLayers.every((l) => selectedLayers.has(l))
  const someDxfLayersSelected = dxfLayers.some((l) => selectedLayers.has(l))
  const allCamjFoldersSelected = camjFolderIds.length > 0 && camjFolderIds.every((id) => selectedLayers.has(id))
  const someCamjFoldersSelected = camjFolderIds.some((id) => selectedLayers.has(id))
  const allLayersSelected = showDxfLayers ? allDxfLayersSelected : allCamjFoldersSelected
  const someLayersSelected = showDxfLayers ? someDxfLayersSelected : someCamjFoldersSelected
  const progressPercent = Math.min(100, Math.max(0, loadingProgress ?? 0))
  const progressStyle = { '--progress': String(progressPercent / 100) } as CSSProperties

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className={`dialog dialog--import${showLayers ? ' dialog--import-with-layers' : ''}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">
          <h2 className="dialog-title">{td('dialogs.importGeometry.title')}</h2>
          <button className="dialog-close" onClick={onClose} aria-label={td('dialogs.common.close')} type="button">
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
              <label className="dialog-section-title">{td('dialogs.importGeometry.sourceFile')}</label>
              <button
                className="btn-secondary import-dialog__file-button"
                type="button"
                onClick={() => fileInputRef.current?.click()}
              >
                {loadedFile ? td('dialogs.importGeometry.chooseDifferentFile') : td('dialogs.importGeometry.chooseFile')}
              </button>
              <input ref={fileInputRef} type="file" accept=".svg,.dxf,.stl,.obj,.camj" onChange={handleFileChange} style={{ display: 'none' }} />
              <div className="import-dialog__file-name">
                {loadedFile ? loadedFile.fileName : td('dialogs.importGeometry.noFileSelected')}
              </div>
            </div>

            {/* File info + settings — only shown once a file is loaded */}
            {loadedFile ? (
              <div className="dialog-section-group">
                <label className="dialog-section-title">{td('dialogs.importGeometry.settings')}</label>

                {/* Geometry mode — SVG/DXF only */}
                {isSvgDxf ? (
                  <ImportGeometryModeSection
                    sourceType={sourceType}
                    geometryMode={geometryMode}
                    onGeometryModeChange={setGeometryMode}
                    classification={classification}
                    combinedWarnings={combinedWarnings}
                    parseError={parseError}
                    hasShapes={cachedShapes !== null && cachedShapes.length > 0}
                  />
                ) : null}

                {/* Format */}
                <div className="import-dialog__info-row">
                  <span>{td('dialogs.importGeometry.format')}</span>
                  <strong>{sourceTypeLabel(loadedFile.sourceType, td)}</strong>
                </div>

                {/* Source Units */}
                <div className="import-dialog__info-row">
                  <span>{td('dialogs.importGeometry.sourceUnits')}</span>
                  {isCamj ? (
                    <strong>{sourceUnits === 'inch' ? td('dialogs.common.inch') : td('dialogs.common.millimeter')}</strong>
                  ) : (
                    <select
                      value={sourceUnits}
                      onChange={(event) => setSourceUnits(event.target.value as Units)}
                    >
                      <option value="">{td('dialogs.importGeometry.selectUnits')}</option>
                      <option value="mm">{td('dialogs.common.millimeter')}</option>
                      <option value="inch">{td('dialogs.common.inch')}</option>
                    </select>
                  )}
                </div>
                {!loadedFile.inspection.detectedUnits && !isModelSourceType(loadedFile.sourceType) && !isCamj ? (
                  <div className="import-dialog__field-note import-dialog__field-note--warn">
                    {td('dialogs.importGeometry.unitsNotDetected')}
                  </div>
                ) : null}
                {isCamj ? (
                  <div className="import-dialog__field-note">
                    {td('dialogs.importGeometry.camjImportNote')}
                  </div>
                ) : null}

                {/* Stock import (only when source stock is feature-based) */}
                {isCamj && loadedFile.camj?.stockIsFeatureBased ? (
                  <>
                    <label className="import-dialog__toggle-row">
                      <span className="import-dialog__toggle-label">{td('dialogs.importGeometry.importStock')}</span>
                      <input
                        className="import-dialog__toggle-input"
                        type="checkbox"
                        checked={importStock}
                        onChange={(event) => setImportStock(event.target.checked)}
                      />
                    </label>
                    {importStock ? (
                      <div className="import-dialog__field-note import-dialog__field-note--warn">
                        {td('dialogs.importGeometry.stockWillBeReplaced')}
                      </div>
                    ) : null}
                  </>
                ) : null}

                {/* Project Units */}
                <div className="import-dialog__info-row">
                  <span>{td('dialogs.importGeometry.projectUnits')}</span>
                  <strong>{project.meta.units === 'inch' ? td('dialogs.common.inch') : td('dialogs.common.millimeter')}</strong>
                </div>

                {/* Axis orientation for imported 3D models */}
                {isModelSourceType(loadedFile.sourceType) ? (
                  <div className="import-dialog__info-row">
                    <span>{td('dialogs.importGeometry.axisOrientation')}</span>
                    <select
                      value={axisSwap}
                      onChange={(event) => setAxisSwap(event.target.value as ModelAxisOrientation)}
                    >
                      <option value="none">{td('dialogs.importGeometry.axisOriginal')}</option>
                      <option value="yz">{td('dialogs.importGeometry.axisSwapYZ')}</option>
                      <option value="xz">{td('dialogs.importGeometry.axisSwapXZ')}</option>
                      <option value="xy">{td('dialogs.importGeometry.axisSwapXY')}</option>
                    </select>
                  </div>
                ) : null}

                {isModelSourceType(loadedFile.sourceType) ? (
                  <div className="import-dialog__info-row">
                    <span>{td('dialogs.importGeometry.silhouetteZSteps')}</span>
                    <input
                      type="number"
                      min="8"
                      max="512"
                      step="1"
                      placeholder={td('dialogs.importGeometry.silhouetteAuto')}
                      value={silhouetteZSteps}
                      onChange={(event) => setSilhouetteZSteps(event.target.value)}
                    />
                  </div>
                ) : null}

                {/* Join Tolerance */}
                {showJoinTolerance ? (
                  <>
                    <div className="import-dialog__info-row">
                      <span>{td('dialogs.importGeometry.joinTolerance', { unit: project.meta.units === 'inch' ? 'in' : 'mm' })}</span>
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
                      <span className="import-dialog__toggle-label">{td('dialogs.importGeometry.crossLayerJoin')}</span>
                      <input
                        className="import-dialog__toggle-input"
                        type="checkbox"
                        checked={allowCrossLayerJoins}
                        onChange={(event) => setAllowCrossLayerJoins(event.target.checked)}
                      />
                    </label>
                  </>
                ) : null}

                {/* Inspection warnings */}
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

          {/* ── Right column: layers / folders ── */}
          {showLayers ? (
            <div className="import-dialog__layers-column">
              <div className="import-dialog__layers-header">
                <label className="dialog-section-title">{showCamjFolders ? td('dialogs.importGeometry.folders') : td('dialogs.importGeometry.layers')}</label>
                <button
                  className="import-dialog__layers-toggle"
                  type="button"
                  onClick={() => setAllLayersSelected(!allLayersSelected)}
                >
                  {allLayersSelected ? td('dialogs.importGeometry.deselectAll') : td('dialogs.importGeometry.selectAll')}
                </button>
              </div>
              <div className="import-dialog__layer-list import-dialog__layer-list--fill">
                {showCamjFolders
                  ? camjFolderIds.map((folderId) => {
                      const name = loadedFile?.camj?.folderNames[folderId] ?? folderId
                      const count = loadedFile?.camj?.folderFeatureCount[folderId] ?? 0
                      return (
                        <label key={folderId} className="import-dialog__layer-row">
                          <input
                            type="checkbox"
                            checked={selectedLayers.has(folderId)}
                            onChange={() => toggleLayer(folderId)}
                          />
                          <span className="import-dialog__layer-name">
                            {name} ({count})
                          </span>
                        </label>
                      )
                    })
                  : dxfLayers.map((layer) => (
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
                <div className="cam-field-message">
                  {td('dialogs.importGeometry.selectAtLeastOne', {
                    type: showCamjFolders
                      ? (localeId === 'zh-CN' ? td('dialogs.importGeometry.folders') : 'folder')
                      : (localeId === 'zh-CN' ? td('dialogs.importGeometry.layers') : 'layer'),
                  })}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="dialog-footer">
          <button className="btn-secondary" onClick={onClose} type="button">{td('dialogs.common.cancel')}</button>
          <button
            className="btn-primary"
            onClick={handleImport}
            type="button"
            disabled={!loadedFile || !sourceUnits || busy || (showLayers && !someLayersSelected && !(isCamj && importStock))}
          >
            {td('dialogs.importGeometry.import')}
          </button>
        </div>
      </div>
    </div>
  )
}
