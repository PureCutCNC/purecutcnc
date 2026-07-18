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
import { dialogsEn } from '../../i18n/locales/en/dialogs'
import { dialogsZhCN } from '../../i18n/locales/zh-CN/dialogs'
import { interpolate } from '../../i18n/catalog'
import type { MessageParams } from '../../i18n/catalog'
import { useI18n } from '../../i18n/i18nContext'

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
  const { localeId } = useI18n()

  function td(key: keyof typeof dialogsEn, params?: MessageParams): string {
    const catalog = localeId === 'zh-CN' ? dialogsZhCN : dialogsEn
    const template = (catalog as Record<string, string>)[key] ?? dialogsEn[key]
    return interpolate(template, params)
  }

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
    { value: 'custom' as const, label: td('dialogs.printDesign.customSize') },
  ]

  // "Current sketch view" is offered only when the canvas reported its
  // viewport; the note below the picker explains the fallback.
  const areaOptions: { value: PrintAreaMode; label: string }[] = [
    { value: 'visible', label: td('dialogs.printDesign.printArea.visible') },
    { value: 'stock', label: td('dialogs.printDesign.printArea.stock') },
    ...(viewBounds !== null ? [{ value: 'view' as const, label: td('dialogs.printDesign.printArea.view') }] : []),
  ]

  const outputW = formatLength(layout.outputWidthMm / unitToMm(units), units)
  const outputH = formatLength(layout.outputHeightMm / unitToMm(units), units)

  const warnings: string[] = []
  if (options.scaleMode === 'custom' && !layout.customScaleValid) {
    warnings.push(td('dialogs.printDesign.warning.customScale'))
  }
  if (layout.clipped) {
    warnings.push(td('dialogs.printDesign.warning.clipped'))
  }

  const printDisabled = options.scaleMode === 'custom' && !layout.customScaleValid

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog dialog--print-design" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-header">
          <h2 className="dialog-title">{td('dialogs.printDesign.title')}</h2>
          <button className="dialog-close" onClick={onClose} aria-label={td('dialogs.common.close')}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="dialog-body dialog-body--print-design">
          <div className="dialog-section">
            <div className="dialog-section-group">
              <label className="dialog-section-title">{td('dialogs.printDesign.paper')}</label>
              <Select<PaperPresetId>
                value={options.paper}
                options={paperOptions}
                onChange={(paper) => update({ paper })}
              />
              {options.paper === 'custom' && (
                <div className="print-dialog__row">
                  <label className="print-dialog__row-label">
                    {td('dialogs.printDesign.size', { unit: unitSuffix })}
                  </label>
                  <input
                    type="number"
                    min={1}
                    step={units === 'inch' ? 0.5 : 10}
                    value={options.customPaperWidth}
                    aria-label={td('dialogs.printDesign.customPaperWidth', { unit: unitSuffix })}
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
                    aria-label={td('dialogs.printDesign.customPaperHeight', { unit: unitSuffix })}
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
                  {td('dialogs.printDesign.portrait')}
                </label>
                <label className="export-option">
                  <input
                    type="radio"
                    name="print-orientation"
                    checked={options.orientation === 'landscape'}
                    onChange={() => update({ orientation: 'landscape' })}
                  />
                  {td('dialogs.printDesign.landscape')}
                </label>
              </div>
              <div className="print-dialog__row">
                <label className="print-dialog__row-label" htmlFor="print-margin">
                  {td('dialogs.printDesign.margins', { unit: unitSuffix })}
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
              <label className="dialog-section-title">{td('dialogs.printDesign.printArea')}</label>
              <Select<PrintAreaMode>
                value={options.area}
                options={areaOptions}
                onChange={(area) => update({ area })}
              />
              {viewBounds === null && (
                <div className="print-dialog__note">
                  {td('dialogs.printDesign.currentViewUnavailable')}
                </div>
              )}
            </div>

            <div className="dialog-section-group">
              <label className="dialog-section-title">{td('dialogs.printDesign.scale')}</label>
              <div className="export-option-group">
                <label className="export-option">
                  <input
                    type="radio"
                    name="print-scale"
                    checked={options.scaleMode === 'fit'}
                    onChange={() => update({ scaleMode: 'fit' })}
                  />
                  {td('dialogs.printDesign.fitToPage')}
                </label>
                <label className="export-option">
                  <input
                    type="radio"
                    name="print-scale"
                    checked={options.scaleMode === 'actual'}
                    onChange={() => update({ scaleMode: 'actual' })}
                  />
                  {td('dialogs.printDesign.actualSize')}
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
                    {td('dialogs.printDesign.custom')}
                  </label>
                  <input
                    ref={customScaleInputRef}
                    type="text"
                    className="print-dialog__scale-input"
                    value={options.customScale}
                    disabled={options.scaleMode !== 'custom'}
                    aria-label={td('dialogs.printDesign.customScaleAria')}
                    placeholder="1:2"
                    spellCheck={false}
                    onChange={(event) => update({ customScale: event.target.value })}
                  />
                </div>
              </div>
              <div className="print-dialog__row">
                <label className="print-dialog__row-label">{td('dialogs.printDesign.offsetXY', { unit: unitSuffix })}</label>
                <input
                  type="number"
                  step={units === 'inch' ? 0.125 : 1}
                  value={options.offsetX}
                  aria-label={td('dialogs.printDesign.offsetX', { unit: unitSuffix })}
                  onChange={(event) => {
                    const value = parseNumber(event.target.value)
                    if (value !== null) update({ offsetX: value })
                  }}
                />
                <input
                  type="number"
                  step={units === 'inch' ? 0.125 : 1}
                  value={options.offsetY}
                  aria-label={td('dialogs.printDesign.offsetY', { unit: unitSuffix })}
                  onChange={(event) => {
                    const value = parseNumber(event.target.value)
                    if (value !== null) update({ offsetY: value })
                  }}
                />
              </div>
            </div>

            <div className="dialog-section-group">
              <label className="dialog-section-title">{td('dialogs.printDesign.content')}</label>
              <div className="export-option-group print-dialog__content-options">
                <label className="export-option">
                  <input
                    type="checkbox"
                    checked={options.content.grid}
                    onChange={(event) => updateContent({ grid: event.target.checked })}
                  />
                  {td('dialogs.printDesign.content.grid')}
                </label>
                <label className="export-option" title={!project.backdrop ? td('dialogs.printDesign.noBackdrop') : undefined}>
                  <input
                    type="checkbox"
                    checked={options.content.backdrop}
                    disabled={!project.backdrop}
                    onChange={(event) => updateContent({ backdrop: event.target.checked })}
                  />
                  {td('dialogs.printDesign.content.backdrop')}
                </label>
                <label className="export-option">
                  <input
                    type="checkbox"
                    checked={options.content.featureLabels}
                    onChange={(event) => updateContent({ featureLabels: event.target.checked })}
                  />
                  {td('dialogs.printDesign.content.featureLabels')}
                </label>
                <label className="export-option" title={project.tabs.length === 0 ? td('dialogs.printDesign.noTabs') : undefined}>
                  <input
                    type="checkbox"
                    checked={options.content.tabs}
                    disabled={project.tabs.length === 0}
                    onChange={(event) => updateContent({ tabs: event.target.checked })}
                  />
                  {td('dialogs.printDesign.content.tabs')}
                </label>
                <label className="export-option" title={project.clamps.length === 0 ? td('dialogs.printDesign.noClamps') : undefined}>
                  <input
                    type="checkbox"
                    checked={options.content.clamps}
                    disabled={project.clamps.length === 0}
                    onChange={(event) => updateContent({ clamps: event.target.checked })}
                  />
                  {td('dialogs.printDesign.content.clamps')}
                </label>
                <label
                  className="export-option"
                  title={toolpaths.length === 0 ? td('dialogs.printDesign.noToolpaths') : undefined}
                >
                  <input
                    type="checkbox"
                    checked={options.content.toolpaths}
                    disabled={toolpaths.length === 0}
                    onChange={(event) => updateContent({ toolpaths: event.target.checked })}
                  />
                  {td('dialogs.printDesign.content.toolpaths')}
                </label>
                <label className="export-option">
                  <input
                    type="checkbox"
                    checked={options.content.footer}
                    onChange={(event) => updateContent({ footer: event.target.checked })}
                  />
                  {td('dialogs.printDesign.content.titleBlock')}
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
                  {td('dialogs.printDesign.content.color')}
                </label>
                <label className="export-option">
                  <input
                    type="radio"
                    name="print-color"
                    checked={options.colorMode === 'monochrome'}
                    onChange={() => update({ colorMode: 'monochrome' })}
                  />
                  {td('dialogs.printDesign.content.monochrome')}
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
              {td('dialogs.printDesign.printedSize', {
                width: outputW,
                height: outputH,
                unit: unitSuffix,
                scale: formatScaleRatio(layout.scaleRatio),
              })}
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
            {td('dialogs.printDesign.close')}
          </button>
          <button className="btn-primary" onClick={handlePrint} disabled={printDisabled} type="button">
            {td('dialogs.printDesign.print')}
          </button>
        </div>
      </div>
    </div>
  )
}
