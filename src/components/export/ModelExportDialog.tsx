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

import { useEffect, useMemo, useState } from 'react'
import { useProjectStore } from '../../store/projectStore'
import { useRestoreCanvasFocus } from '../../utils/useRestoreCanvasFocus'
import { Select } from '../Select'
import { platform } from '../../platform'
import {
  MODEL_EXPORT_FORMATS,
  STL_DEFAULT_OPTIONS,
  assembleModelExportMesh,
  countTriangles,
  estimateStlFileSize,
  getModelExportFormat,
  type CurveQuality,
  type ExportTriangleMesh,
  type STLExportOptions,
} from '../../engine/modelExport'

interface ModelExportDialogProps {
  onClose: () => void
}

interface AssembledMesh {
  mesh: ExportTriangleMesh
  warnings: string[]
}

export function ModelExportDialog({ onClose }: ModelExportDialogProps) {
  useRestoreCanvasFocus()
  const { project, lastModelExportPath, markModelExported } = useProjectStore()

  const [formatId, setFormatId] = useState<string>(MODEL_EXPORT_FORMATS[0]?.id ?? 'stl')
  const [stlOptions, setStlOptions] = useState<STLExportOptions>(STL_DEFAULT_OPTIONS)
  const [curveQuality, setCurveQuality] = useState<CurveQuality>('normal')
  const [fileName, setFileName] = useState<string>(() => sanitizeFileName(project.meta.name))
  const [assembled, setAssembled] = useState<AssembledMesh | null>(null)
  const [assembling, setAssembling] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  const format = useMemo(() => getModelExportFormat(formatId) ?? MODEL_EXPORT_FORMATS[0], [formatId])

  // Re-assemble whenever the user toggles "include imported meshes" — the
  // assembled mesh is the only piece of state that depends on that option.
  useEffect(() => {
    let cancelled = false
    setAssembling(true)
    setErrorMessage(null)
    assembleModelExportMesh(project, {
      includeImportedMeshes: stlOptions.includeImportedMeshes,
      curveQuality,
    })
      .then((result) => {
        if (cancelled) return
        setAssembled({ mesh: result.mesh, warnings: result.warnings })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setErrorMessage(error instanceof Error ? error.message : String(error))
        setAssembled(null)
      })
      .finally(() => {
        if (!cancelled) setAssembling(false)
      })
    return () => {
      cancelled = true
    }
  }, [project, stlOptions.includeImportedMeshes, curveQuality])

  const triangleCount = assembled ? countTriangles(assembled.mesh) : 0
  const estimatedSize = assembled && format?.id === 'stl'
    ? estimateStlFileSize(assembled.mesh, stlOptions.format)
    : null

  const warnings = useMemo(() => {
    const list = [...(assembled?.warnings ?? [])]
    if (assembled && triangleCount === 0) {
      list.push('No solid geometry to export — add visible features first.')
    }
    return list
  }, [assembled, triangleCount])

  async function handleExport() {
    if (!assembled || !format || triangleCount === 0) return
    setExporting(true)
    try {
      const output = await format.export(
        { project, mesh: assembled.mesh },
        format.id === 'stl' ? stlOptions : format.defaultOptions,
      )
      const suggestedName = sanitizeFileName(fileName || project.meta.name)
      const savedPath = output.encoding === 'binary'
        ? await platform.saveBinaryFile(
            suggestedName,
            output.data as Uint8Array,
            format.extension,
            format.mimeType,
            lastModelExportPath,
          )
        : await platform.saveTextFile(
            suggestedName,
            output.data as string,
            format.extension,
            lastModelExportPath,
          )
      if (savedPath) {
        markModelExported(savedPath)
        onClose()
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-header">
          <h2 className="dialog-title">Export Model</h2>
          <button className="dialog-close" onClick={onClose} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="dialog-body">
          <div className="dialog-section">
            <div className="dialog-section-group">
              <label className="dialog-section-title">Format</label>
              <Select
                value={formatId}
                options={MODEL_EXPORT_FORMATS.map((f) => ({ value: f.id, label: f.name }))}
                onChange={setFormatId}
              />
            </div>

            <div className="dialog-section-group">
              <label className="dialog-section-title" htmlFor="model-export-name">File name</label>
              <div className="properties-field">
                <input
                  id="model-export-name"
                  type="text"
                  value={fileName}
                  onChange={(event) => setFileName(event.target.value)}
                  spellCheck={false}
                />
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                Saved as <code>{`${sanitizeFileName(fileName || project.meta.name)}.${format?.extension ?? ''}`}</code>. The location is chosen in the next dialog.
              </div>
            </div>

            <div className="dialog-section-group">
              <label className="dialog-section-title">Curve quality</label>
              <Select<CurveQuality>
                value={curveQuality}
                options={CURVE_QUALITY_OPTIONS}
                onChange={setCurveQuality}
              />
              <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                Controls how finely arcs and bezier curves are tessellated. Finer = more triangles, smoother curves.
              </div>
            </div>

            {format?.id === 'stl' && (
              <StlOptionsPanel options={stlOptions} onChange={setStlOptions} />
            )}

            <div className="dialog-section-group">
              <label className="dialog-section-title">Summary</label>
              <div style={{ fontSize: '13px', color: 'var(--text)', display: 'grid', gap: '4px' }}>
                <div>{assembling ? 'Assembling mesh…' : `${triangleCount.toLocaleString()} triangles`}</div>
                {estimatedSize !== null && (
                  <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                    Estimated file size: {formatBytes(estimatedSize)}
                  </div>
                )}
              </div>
            </div>

            {warnings.length > 0 && (
              <div className="dialog-section-group">
                <label className="dialog-section-title">Warnings</label>
                <div className="export-warning-list">
                  {warnings.map((warning, index) => (
                    <div key={index} className="export-warning">{warning}</div>
                  ))}
                </div>
              </div>
            )}

            {errorMessage && (
              <div className="dialog-section-group">
                <label className="dialog-section-title">Error</label>
                <div className="export-warning">{errorMessage}</div>
              </div>
            )}
          </div>
        </div>

        <div className="dialog-footer">
          <button className="btn-secondary" onClick={onClose} type="button" disabled={exporting}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={handleExport}
            disabled={!assembled || triangleCount === 0 || assembling || exporting}
            type="button"
          >
            {exporting ? 'Exporting…' : `Export .${format?.extension ?? ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}

function StlOptionsPanel({
  options,
  onChange,
}: {
  options: STLExportOptions
  onChange: (next: STLExportOptions) => void
}) {
  return (
    <>
      <div className="dialog-section-group">
        <label className="dialog-section-title">STL encoding</label>
        <div className="export-option-group">
          <label className="export-option">
            <input
              type="radio"
              name="stl-format"
              checked={options.format === 'binary'}
              onChange={() => onChange({ ...options, format: 'binary' })}
            />
            Binary (recommended — smaller, faster)
          </label>
          <label className="export-option">
            <input
              type="radio"
              name="stl-format"
              checked={options.format === 'ascii'}
              onChange={() => onChange({ ...options, format: 'ascii' })}
            />
            ASCII (human-readable)
          </label>
        </div>
      </div>
      <div className="dialog-section-group">
        <label className="dialog-section-title">Contents</label>
        <div className="export-option-group">
          <label className="export-option">
            <input
              type="checkbox"
              checked={options.includeImportedMeshes}
              onChange={(event) => onChange({ ...options, includeImportedMeshes: event.target.checked })}
            />
            Include imported meshes
          </label>
        </div>
      </div>
    </>
  )
}

const CURVE_QUALITY_OPTIONS: { value: CurveQuality, label: string }[] = [
  { value: 'coarse', label: 'Coarse (10° — matches 3D viewport)' },
  { value: 'normal', label: 'Normal (5°)' },
  { value: 'fine', label: 'Fine (2°)' },
  { value: 'very_fine', label: 'Very fine (1°)' },
]

function sanitizeFileName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, '_').replace(/[\\/:*?"<>|]+/g, '')
  return trimmed || 'model'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

