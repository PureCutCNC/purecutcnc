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
        setDialogError(null)
      } catch (error) {
        setLoadedFile(null)
        setSourceUnits('')
        setDialogError(error instanceof Error ? error.message : 'Failed to inspect geometry file.')
      }
    }
    reader.readAsText(file)
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
              {dialogError ? <div className="cam-field-message">{dialogError}</div> : null}
            </div>
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
          <button className="btn-primary" onClick={handleImport} type="button" disabled={!loadedFile || !sourceUnits || busy}>
            Import
          </button>
        </div>
      </div>
    </div>
  )
}
