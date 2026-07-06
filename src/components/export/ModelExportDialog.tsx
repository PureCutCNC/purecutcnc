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
  type SvgExportOptions,
} from '../../engine/modelExport'
import {
  defaultDesignSvgExportOptions,
  resolvePrintBounds,
  type DesignSvgExportArea,
  type DesignSvgExportContent,
} from '../../engine/designPrint'
import { formatLength } from '../../utils/units'
import type { Project } from '../../types/project'

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
  const [svgOptions, setSvgOptions] = useState<SvgExportOptions>(() =>
    defaultDesignSvgExportOptions(project),
  )
  const [curveQuality, setCurveQuality] = useState<CurveQuality>('normal')
  const [fileName, setFileName] = useState<string>(() => sanitizeFileName(project.meta.name))
  const [assembled, setAssembled] = useState<AssembledMesh | null>(null)
  const [assembling, setAssembling] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  const format = useMemo(() => getModelExportFormat(formatId) ?? MODEL_EXPORT_FORMATS[0], [formatId])
  const is2d = format?.kind === '2d'

  // Re-assemble whenever the user toggles "include imported meshes" — the
  // assembled mesh is the only piece of state that depends on that option.
  // 2D formats render from the project directly, so no mesh is assembled.
  useEffect(() => {
    if (is2d) return
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
  }, [project, stlOptions.includeImportedMeshes, curveQuality, is2d])

  const triangleCount = assembled ? countTriangles(assembled.mesh) : 0
  const estimatedSize = assembled && format?.id === 'stl'
    ? estimateStlFileSize(assembled.mesh, stlOptions.format)
    : null

  // Physical output size of the SVG export (world units are project units).
  const svgTabs = svgOptions.content.tabs
  const svgClamps = svgOptions.content.clamps
  const svgBounds = useMemo(
    () =>
      is2d
        ? resolvePrintBounds(project, svgOptions.area, null, {
            backdrop: false,
            tabs: svgTabs,
            clamps: svgClamps,
          })
        : null,
    [is2d, project, svgOptions.area, svgTabs, svgClamps],
  )

  const warnings = useMemo(() => {
    if (is2d) return []
    const list = [...(assembled?.warnings ?? [])]
    if (assembled && triangleCount === 0) {
      list.push('No solid geometry to export — add visible features first.')
    }
    return list
  }, [is2d, assembled, triangleCount])

  async function handleExport() {
    if (!format) return
    if (!is2d && (!assembled || triangleCount === 0)) return
    setExporting(true)
    try {
      const output = await format.export(
        { project, mesh: assembled?.mesh },
        format.id === 'stl' ? stlOptions : format.id === 'svg' ? svgOptions : format.defaultOptions,
      )
      const suggestedName = sanitizeFileName(fileName || project.meta.name)
      // The remembered path is written to without a dialog, so reuse it only
      // for the same file type — never overwrite a .stl target with SVG text.
      const rememberedPath =
        lastModelExportPath?.toLowerCase().endsWith(`.${format.extension}`)
          ? lastModelExportPath
          : null
      const savedPath = output.encoding === 'binary'
        ? await platform.saveBinaryFile(
            suggestedName,
            output.data as Uint8Array,
            format.extension,
            format.mimeType,
            rememberedPath,
          )
        : await platform.saveTextFile(
            suggestedName,
            output.data as string,
            format.extension,
            rememberedPath,
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

            {!is2d && (
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
            )}

            {format?.id === 'stl' && (
              <StlOptionsPanel options={stlOptions} onChange={setStlOptions} />
            )}

            {format?.id === 'svg' && (
              <SvgOptionsPanel project={project} options={svgOptions} onChange={setSvgOptions} />
            )}

            <div className="dialog-section-group">
              <label className="dialog-section-title">Summary</label>
              <div style={{ fontSize: '13px', color: 'var(--text)', display: 'grid', gap: '4px' }}>
                {is2d && svgBounds ? (
                  <>
                    <div>
                      Exported size: {formatLength(svgBounds.maxX - svgBounds.minX, project.meta.units)} ×{' '}
                      {formatLength(svgBounds.maxY - svgBounds.minY, project.meta.units)}{' '}
                      {project.meta.units === 'inch' ? 'in' : 'mm'} at 1:1
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                      Editable vector paths; hidden features are left out and dimensions follow the sketch setting.
                    </div>
                  </>
                ) : (
                  <div>{assembling ? 'Assembling mesh…' : `${triangleCount.toLocaleString()} triangles`}</div>
                )}
                {estimatedSize !== null && !is2d && (
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
            disabled={exporting || (!is2d && (!assembled || triangleCount === 0 || assembling))}
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

function SvgOptionsPanel({
  project,
  options,
  onChange,
}: {
  project: Project
  options: SvgExportOptions
  onChange: (next: SvgExportOptions) => void
}) {
  const areaOptions: { value: DesignSvgExportArea; label: string }[] = [
    { value: 'visible', label: 'Visible design extents' },
    { value: 'stock', label: 'Stock extents' },
  ]

  function updateContent(partial: Partial<DesignSvgExportContent>) {
    onChange({ ...options, content: { ...options.content, ...partial } })
  }

  return (
    <>
      <div className="dialog-section-group">
        <label className="dialog-section-title">Export area</label>
        <Select<DesignSvgExportArea>
          value={options.area}
          options={areaOptions}
          onChange={(area) => onChange({ ...options, area })}
        />
      </div>

      <div className="dialog-section-group">
        <label className="dialog-section-title">Content</label>
        <div className="export-option-group">
          <label className="export-option" title={project.tabs.length === 0 ? 'No tabs in this project' : undefined}>
            <input
              type="checkbox"
              checked={options.content.tabs}
              disabled={project.tabs.length === 0}
              onChange={(event) => updateContent({ tabs: event.target.checked })}
            />
            Tabs
          </label>
          <label className="export-option" title={project.clamps.length === 0 ? 'No clamps in this project' : undefined}>
            <input
              type="checkbox"
              checked={options.content.clamps}
              disabled={project.clamps.length === 0}
              onChange={(event) => updateContent({ clamps: event.target.checked })}
            />
            Clamps
          </label>
          <label className="export-option">
            <input
              type="checkbox"
              checked={options.content.featureLabels}
              onChange={(event) => updateContent({ featureLabels: event.target.checked })}
            />
            Feature labels
          </label>
          <label className="export-option">
            <input
              type="checkbox"
              checked={options.content.grid}
              onChange={(event) => updateContent({ grid: event.target.checked })}
            />
            Grid
          </label>
        </div>
        <div className="export-option-group">
          <label className="export-option">
            <input
              type="radio"
              name="svg-color"
              checked={options.colorMode === 'color'}
              onChange={() => onChange({ ...options, colorMode: 'color' })}
            />
            Color
          </label>
          <label className="export-option">
            <input
              type="radio"
              name="svg-color"
              checked={options.colorMode === 'monochrome'}
              onChange={() => onChange({ ...options, colorMode: 'monochrome' })}
            />
            Monochrome
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

