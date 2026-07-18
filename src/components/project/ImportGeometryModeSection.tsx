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

import type { ClassificationResult, ImportGeometryMode, ImportSourceType } from '../../import'
import { dialogsEn } from '../../i18n/locales/en/dialogs'
import { dialogsZhCN } from '../../i18n/locales/zh-CN/dialogs'
import { interpolate } from '../../i18n/catalog'
import type { MessageParams } from '../../i18n/catalog'
import { useI18n } from '../../i18n/i18nContext'

export interface ImportGeometryModeSectionProps {
  sourceType: ImportSourceType
  geometryMode: ImportGeometryMode
  onGeometryModeChange: (mode: ImportGeometryMode) => void
  classification: { result: ClassificationResult } | null
  /** Combined and de-duplicated parse + classifier warnings. */
  combinedWarnings: string[]
  /** Non-null when the last parse produced an error. */
  parseError: string | null
  /** True when shapes are cached (analysis is available or pending). */
  hasShapes: boolean
}

function modeExplanation(
  mode: ImportGeometryMode,
  sourceType: ImportSourceType,
  td: (key: keyof typeof dialogsEn) => string,
): string {
  if (mode === 'auto') {
    return sourceType === 'svg'
      ? td('dialogs.importGeometry.mode.explain.autoSvg')
      : td('dialogs.importGeometry.mode.explain.autoDxf')
  }
  if (mode === 'paths') {
    return td('dialogs.importGeometry.mode.explain.paths')
  }
  return td('dialogs.importGeometry.mode.explain.solidRegions')
}

export function ImportGeometryModeSection({
  sourceType,
  geometryMode,
  onGeometryModeChange,
  classification,
  combinedWarnings,
  parseError,
  hasShapes,
}: ImportGeometryModeSectionProps) {
  const { localeId } = useI18n()

  function td(key: keyof typeof dialogsEn, params?: MessageParams): string {
    const catalog = localeId === 'zh-CN' ? dialogsZhCN : dialogsEn
    const template = (catalog as Record<string, string>)[key] ?? dialogsEn[key]
    return interpolate(template, params)
  }

  const selectId = 'import-geometry-mode'

  return (
    <>
      <div className="import-dialog__info-row">
        <label htmlFor={selectId}>{td('dialogs.importGeometry.mode.geometryMode')}</label>
        <select
          id={selectId}
          value={geometryMode}
          onChange={(event) =>
            onGeometryModeChange(event.target.value as ImportGeometryMode)
          }
          data-testid="import-geometry-mode"
        >
          <option value="auto">{td('dialogs.importGeometry.mode.auto')}</option>
          <option value="paths">{td('dialogs.importGeometry.mode.paths')}</option>
          <option value="solid-regions">{td('dialogs.importGeometry.mode.solidRegions')}</option>
        </select>
      </div>

      <div className="import-dialog__field-note">
        {modeExplanation(geometryMode, sourceType, td)}
      </div>

      {/* Parse error */}
      {parseError ? (
        <div className="export-warning">{parseError}</div>
      ) : null}

      {/* Analysis pending */}
      {!classification && hasShapes && !parseError ? (
        <div className="import-dialog__field-note">
          {td('dialogs.importGeometry.mode.analysing')}
        </div>
      ) : null}

      {/* Classification summary */}
      {classification ? (
        <div
          className="import-dialog__analysis"
          data-testid="import-analysis-summary"
        >
          <div className="import-dialog__analysis-title">{td('dialogs.importGeometry.mode.importSummary')}</div>
          <div className="import-dialog__analysis-rows">
            <div className="import-dialog__analysis-row" data-testid="import-summary-total">
              <span>{td('dialogs.importGeometry.mode.totalImportable')}</span>
              <strong>{classification.result.totalImportable}</strong>
            </div>
            {classification.result.openLineCount > 0 ? (
              <div className="import-dialog__analysis-row" data-testid="import-summary-open-line">
                <span>{td('dialogs.importGeometry.mode.openLines')}</span>
                <strong>{classification.result.openLineCount}</strong>
              </div>
            ) : null}
            {classification.result.closedLineCount > 0 ? (
              <div className="import-dialog__analysis-row" data-testid="import-summary-closed-line">
                <span>{td('dialogs.importGeometry.mode.closedLines')}</span>
                <strong>{classification.result.closedLineCount}</strong>
              </div>
            ) : null}
            {classification.result.addCount > 0 ? (
              <div className="import-dialog__analysis-row" data-testid="import-summary-add">
                <span>{td('dialogs.importGeometry.mode.addSolid')}</span>
                <strong>{classification.result.addCount}</strong>
              </div>
            ) : null}
            {classification.result.subtractCount > 0 ? (
              <div className="import-dialog__analysis-row" data-testid="import-summary-subtract">
                <span>{td('dialogs.importGeometry.mode.subtractSolid')}</span>
                <strong>{classification.result.subtractCount}</strong>
              </div>
            ) : null}
          </div>

          {combinedWarnings.length > 0 ? (
            <div className="export-warning-list">
              {combinedWarnings.map((w) => (
                <div key={w} className="export-warning">
                  {w}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
