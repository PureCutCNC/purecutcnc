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

import { useMemo, useRef, useState } from 'react'
import { useProjectStore } from '../../store/projectStore'
import { useRestoreCanvasFocus } from '../../utils/useRestoreCanvasFocus'
import { Select } from '../Select'
import {
  PAPER_PRESETS,
  buildDesignPrintHtml,
  buildDesignPrintSvg,
  computeDesignPrintLayout,
  defaultDesignPrintOptions,
  formatScaleRatio,
  resolvePrintBounds,
  unitToMm,
} from '../../engine/designPrint'
import type {
  DesignPrintContent,
  DesignPrintOptions,
  PaperPresetId,
  PrintAreaMode,
} from '../../engine/designPrint'
import { getVisibleSceneBounds2D } from '../../sketch/sceneBounds'
import { printHtmlDocument } from '../../platform/printDocument'
import { formatLength } from '../../utils/units'
import type { Bounds2D } from '../../types/project'
import type { ToolpathResult } from '../../engine/toolpaths/types'
import type { ToolpathVisibility } from '../toolpathVisibility'

interface PrintDesignDialogProps {
  onClose: () => void
  /** Current sketch pan/zoom window; null when the canvas is not laid out. */
  getCurrentViewBounds: () => Bounds2D | null
  /** Toolpaths currently shown in the sketch view (for the overlay toggle). */
  toolpaths: ToolpathResult[]
  toolpathVisibility: ToolpathVisibility
}

export function PrintDesignDialog({
  onClose,
  getCurrentViewBounds,
  toolpaths,
  toolpathVisibility,
}: PrintDesignDialogProps) {
  useRestoreCanvasFocus()
  const { project } = useProjectStore()
  const units = project.meta.units
  const unitSuffix = units === 'inch' ? 'in' : 'mm'

  // Default-orientation bounds exclude the backdrop, matching its
  // default-off content toggle.
  const [options, setOptions] = useState<DesignPrintOptions>(() =>
    defaultDesignPrintOptions(project, getVisibleSceneBounds2D(project, { includeBackdrop: false })),
  )
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const customScaleInputRef = useRef<HTMLInputElement>(null)

  // Snapshot once on open — the canvas cannot pan/zoom behind the modal.
  const [viewBounds] = useState<Bounds2D | null>(() => getCurrentViewBounds())
  const footerDate = useMemo(() => new Date().toLocaleDateString(), [])

  // Bounds follow the layers being printed, so toggling backdrop/tabs/clamps
  // rescales the page to exactly what the output will contain.
  const contentBackdrop = options.content.backdrop
  const contentTabs = options.content.tabs
  const contentClamps = options.content.clamps
  const bounds = useMemo(
    () => resolvePrintBounds(project, options.area, viewBounds, {
      backdrop: contentBackdrop,
      tabs: contentTabs,
      clamps: contentClamps,
    }),
    [project, options.area, viewBounds, contentBackdrop, contentTabs, contentClamps],
  )
  const layout = useMemo(
    () => computeDesignPrintLayout(options, bounds, units),
    [options, bounds, units],
  )
  const previewSvg = useMemo(
    () =>
      buildDesignPrintSvg(project, options, layout, {
        physicalSize: false,
        toolpaths,
        toolpathVisibility,
        footerDate,
      }),
    [project, options, layout, toolpaths, toolpathVisibility, footerDate],
  )

  function update(partial: Partial<DesignPrintOptions>) {
    setOptions((current) => ({ ...current, ...partial }))
  }

  function updateContent(partial: Partial<DesignPrintContent>) {
    setOptions((current) => ({ ...current, content: { ...current.content, ...partial } }))
  }

  function parseNumber(text: string): number | null {
    const value = Number(text)
    return Number.isFinite(value) ? value : null
  }

  async function handlePrint() {
    setErrorMessage(null)
    try {
      const svg = buildDesignPrintSvg(project, options, layout, {
        toolpaths,
        toolpathVisibility,
        footerDate,
      })
      const html = buildDesignPrintHtml({ svg, layout, title: project.meta.name })
      await printHtmlDocument(html)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const paperOptions: { value: PaperPresetId; label: string }[] = [
    ...PAPER_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
    { value: 'custom' as const, label: 'Custom size' },
  ]

  // "Current sketch view" is offered only when the canvas reported its
  // viewport; the note below the picker explains the fallback.
  const areaOptions: { value: PrintAreaMode; label: string }[] = [
    { value: 'visible', label: 'Visible design extents' },
    { value: 'stock', label: 'Stock extents' },
    ...(viewBounds !== null ? [{ value: 'view' as const, label: 'Current sketch view' }] : []),
  ]

  const outputW = formatLength(layout.outputWidthMm / unitToMm(units), units)
  const outputH = formatLength(layout.outputHeightMm / unitToMm(units), units)

  const warnings: string[] = []
  if (options.scaleMode === 'custom' && !layout.customScaleValid) {
    warnings.push('Custom scale not recognized — enter a ratio like 1:2, a percentage like 50%, or a factor like 0.5.')
  }
  if (layout.clipped) {
    warnings.push('The drawing is clipped on this paper at the selected scale. Use Fit to page, reduce the scale, or choose a larger paper size.')
  }

  const printDisabled = options.scaleMode === 'custom' && !layout.customScaleValid

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog dialog--print-design" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-header">
          <h2 className="dialog-title">Print Design</h2>
          <button className="dialog-close" onClick={onClose} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="dialog-body dialog-body--print-design">
          <div className="dialog-section">
            <div className="dialog-section-group">
              <label className="dialog-section-title">Paper</label>
              <Select<PaperPresetId>
                value={options.paper}
                options={paperOptions}
                onChange={(paper) => update({ paper })}
              />
              {options.paper === 'custom' && (
                <div className="print-dialog__row">
                  <label className="print-dialog__row-label">
                    Size ({unitSuffix})
                  </label>
                  <input
                    type="number"
                    min={1}
                    step={units === 'inch' ? 0.5 : 10}
                    value={options.customPaperWidth}
                    aria-label={`Custom paper width (${unitSuffix})`}
                    onChange={(event) => {
                      const value = parseNumber(event.target.value)
                      if (value !== null) update({ customPaperWidth: value })
                    }}
                  />
                  <span aria-hidden="true">×</span>
                  <input
                    type="number"
                    min={1}
                    step={units === 'inch' ? 0.5 : 10}
                    value={options.customPaperHeight}
                    aria-label={`Custom paper height (${unitSuffix})`}
                    onChange={(event) => {
                      const value = parseNumber(event.target.value)
                      if (value !== null) update({ customPaperHeight: value })
                    }}
                  />
                </div>
              )}
              <div className="export-option-group">
                <label className="export-option">
                  <input
                    type="radio"
                    name="print-orientation"
                    checked={options.orientation === 'portrait'}
                    onChange={() => update({ orientation: 'portrait' })}
                  />
                  Portrait
                </label>
                <label className="export-option">
                  <input
                    type="radio"
                    name="print-orientation"
                    checked={options.orientation === 'landscape'}
                    onChange={() => update({ orientation: 'landscape' })}
                  />
                  Landscape
                </label>
              </div>
              <div className="print-dialog__row">
                <label className="print-dialog__row-label" htmlFor="print-margin">
                  Margins ({unitSuffix})
                </label>
                <input
                  id="print-margin"
                  type="number"
                  min={0}
                  step={units === 'inch' ? 0.125 : 1}
                  value={options.margin}
                  onChange={(event) => {
                    const value = parseNumber(event.target.value)
                    if (value !== null) update({ margin: Math.max(0, value) })
                  }}
                />
              </div>
            </div>

            <div className="dialog-section-group">
              <label className="dialog-section-title">Print area</label>
              <Select<PrintAreaMode>
                value={options.area}
                options={areaOptions}
                onChange={(area) => update({ area })}
              />
              {viewBounds === null && (
                <div className="print-dialog__note">
                  Current sketch view is available when the sketch canvas is open.
                </div>
              )}
            </div>

            <div className="dialog-section-group">
              <label className="dialog-section-title">Scale</label>
              <div className="export-option-group">
                <label className="export-option">
                  <input
                    type="radio"
                    name="print-scale"
                    checked={options.scaleMode === 'fit'}
                    onChange={() => update({ scaleMode: 'fit' })}
                  />
                  Fit to page
                </label>
                <label className="export-option">
                  <input
                    type="radio"
                    name="print-scale"
                    checked={options.scaleMode === 'actual'}
                    onChange={() => update({ scaleMode: 'actual' })}
                  />
                  Actual size (1:1)
                </label>
                <div className="print-dialog__custom-scale">
                  <label className="export-option">
                    <input
                      type="radio"
                      name="print-scale"
                      checked={options.scaleMode === 'custom'}
                      onChange={() => {
                        update({ scaleMode: 'custom' })
                        // The field is disabled until this state lands.
                        window.requestAnimationFrame(() => {
                          customScaleInputRef.current?.focus()
                          customScaleInputRef.current?.select()
                        })
                      }}
                    />
                    Custom
                  </label>
                  <input
                    ref={customScaleInputRef}
                    type="text"
                    className="print-dialog__scale-input"
                    value={options.customScale}
                    disabled={options.scaleMode !== 'custom'}
                    aria-label="Custom scale (ratio, percentage, or factor)"
                    placeholder="1:2"
                    spellCheck={false}
                    onChange={(event) => update({ customScale: event.target.value })}
                  />
                </div>
              </div>
              <div className="print-dialog__row">
                <label className="print-dialog__row-label">Offset X / Y ({unitSuffix})</label>
                <input
                  type="number"
                  step={units === 'inch' ? 0.125 : 1}
                  value={options.offsetX}
                  aria-label={`Horizontal offset (${unitSuffix})`}
                  onChange={(event) => {
                    const value = parseNumber(event.target.value)
                    if (value !== null) update({ offsetX: value })
                  }}
                />
                <input
                  type="number"
                  step={units === 'inch' ? 0.125 : 1}
                  value={options.offsetY}
                  aria-label={`Vertical offset (${unitSuffix})`}
                  onChange={(event) => {
                    const value = parseNumber(event.target.value)
                    if (value !== null) update({ offsetY: value })
                  }}
                />
              </div>
            </div>

            <div className="dialog-section-group">
              <label className="dialog-section-title">Content</label>
              <div className="export-option-group print-dialog__content-options">
                <label className="export-option">
                  <input
                    type="checkbox"
                    checked={options.content.grid}
                    onChange={(event) => updateContent({ grid: event.target.checked })}
                  />
                  Grid
                </label>
                <label className="export-option" title={!project.backdrop ? 'No backdrop image in this project' : undefined}>
                  <input
                    type="checkbox"
                    checked={options.content.backdrop}
                    disabled={!project.backdrop}
                    onChange={(event) => updateContent({ backdrop: event.target.checked })}
                  />
                  Backdrop image
                </label>
                <label className="export-option">
                  <input
                    type="checkbox"
                    checked={options.content.featureLabels}
                    onChange={(event) => updateContent({ featureLabels: event.target.checked })}
                  />
                  Feature labels
                </label>
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
                <label
                  className="export-option"
                  title={toolpaths.length === 0 ? 'No toolpaths are visible in the sketch view' : undefined}
                >
                  <input
                    type="checkbox"
                    checked={options.content.toolpaths}
                    disabled={toolpaths.length === 0}
                    onChange={(event) => updateContent({ toolpaths: event.target.checked })}
                  />
                  Toolpath overlays
                </label>
                <label className="export-option">
                  <input
                    type="checkbox"
                    checked={options.content.footer}
                    onChange={(event) => updateContent({ footer: event.target.checked })}
                  />
                  Title block
                </label>
              </div>
              <div className="export-option-group print-dialog__content-options">
                <label className="export-option">
                  <input
                    type="radio"
                    name="print-color"
                    checked={options.colorMode === 'color'}
                    onChange={() => update({ colorMode: 'color' })}
                  />
                  Color
                </label>
                <label className="export-option">
                  <input
                    type="radio"
                    name="print-color"
                    checked={options.colorMode === 'monochrome'}
                    onChange={() => update({ colorMode: 'monochrome' })}
                  />
                  Monochrome
                </label>
              </div>
            </div>
          </div>

          <div className="dialog-preview-container">
            <div className="print-preview">
              <div
                className="print-preview__page"
                style={{ aspectRatio: `${layout.paperWidthMm} / ${layout.paperHeightMm}` }}
                dangerouslySetInnerHTML={{ __html: previewSvg }}
              />
            </div>
            <div className="print-dialog__summary">
              Printed size: {outputW} × {outputH} {unitSuffix} at {formatScaleRatio(layout.scaleRatio)}
            </div>
            {warnings.length > 0 && (
              <div className="export-warning-list">
                {warnings.map((warning, index) => (
                  <div key={index} className="export-warning">{warning}</div>
                ))}
              </div>
            )}
            {errorMessage && <div className="export-warning">{errorMessage}</div>}
          </div>
        </div>

        <div className="dialog-footer">
          <button className="btn-secondary" onClick={onClose} type="button">
            Close
          </button>
          <button className="btn-primary" onClick={handlePrint} disabled={printDisabled} type="button">
            Print…
          </button>
        </div>
      </div>
    </div>
  )
}
