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
): string {
  if (mode === 'auto') {
    return sourceType === 'svg'
      ? 'Auto: stroke-only geometry → Lines; filled closed shapes → nesting-aware solids.'
      : 'Auto: closed profiles → nesting-aware solids. Use Paths for line-only import.'
  }
  if (mode === 'paths') {
    return 'Paths: all profiles → Lines (no solid features).'
  }
  return 'Solid regions: closed profiles → nesting-aware Add/Subtract solids.'
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
  const selectId = 'import-geometry-mode'

  return (
    <>
      <div className="import-dialog__info-row">
        <label htmlFor={selectId}>Geometry Mode</label>
        <select
          id={selectId}
          value={geometryMode}
          onChange={(event) =>
            onGeometryModeChange(event.target.value as ImportGeometryMode)
          }
          data-testid="import-geometry-mode"
        >
          <option value="auto">Auto</option>
          <option value="paths">Paths</option>
          <option value="solid-regions">Solid regions</option>
        </select>
      </div>

      <div className="import-dialog__field-note">
        {modeExplanation(geometryMode, sourceType)}
      </div>

      {/* Parse error */}
      {parseError ? (
        <div className="export-warning">{parseError}</div>
      ) : null}

      {/* Analysis pending */}
      {!classification && hasShapes && !parseError ? (
        <div className="import-dialog__field-note">
          Analysing geometry…
        </div>
      ) : null}

      {/* Classification summary */}
      {classification ? (
        <div
          className="import-dialog__analysis"
          data-testid="import-analysis-summary"
        >
          <div className="import-dialog__analysis-title">Import Summary</div>
          <div className="import-dialog__analysis-rows">
            <div className="import-dialog__analysis-row" data-testid="import-summary-total">
              <span>Total importable</span>
              <strong>{classification.result.totalImportable}</strong>
            </div>
            {classification.result.openLineCount > 0 ? (
              <div className="import-dialog__analysis-row" data-testid="import-summary-open-line">
                <span>Open Lines</span>
                <strong>{classification.result.openLineCount}</strong>
              </div>
            ) : null}
            {classification.result.closedLineCount > 0 ? (
              <div className="import-dialog__analysis-row" data-testid="import-summary-closed-line">
                <span>Closed Lines</span>
                <strong>{classification.result.closedLineCount}</strong>
              </div>
            ) : null}
            {classification.result.addCount > 0 ? (
              <div className="import-dialog__analysis-row" data-testid="import-summary-add">
                <span>Add (solid)</span>
                <strong>{classification.result.addCount}</strong>
              </div>
            ) : null}
            {classification.result.subtractCount > 0 ? (
              <div className="import-dialog__analysis-row" data-testid="import-summary-subtract">
                <span>Subtract (solid)</span>
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
