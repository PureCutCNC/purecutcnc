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

/**
 * The Verify mode's panel (issue #1269): the comparison selector, the Run
 * button, the run's state (idle, running, stale, failed) and the results list
 * grouped by operation. Selecting a finding hands it to the viewport, which
 * frames and highlights it. Every operation the run covered is listed, an
 * unverified one with its reasons.
 */

import type { VerifyModel } from '../../app/verify/useVerifyModel'
import { VERIFY_COMPARISONS } from '../../app/verify/verifyRequest'
import type { VerifyFinding, VerifyFindingKind, VerifyOperationReport, VerifyRunResult } from '../../app/verify/verifyRun'
import { useI18n } from '../../i18n/i18nContext'
import type { Units } from '../../utils/units'
import {
  VERIFY_COMPARISON_KEYS,
  VERIFY_KIND_KEYS,
  VERIFY_VERDICT_KEYS,
  verifyFindingText,
  verifyReasonText,
} from './verifyText'

/** CSS colours of each finding kind and of an unverified operation's cells. */
export type VerifyKindColours = Record<VerifyFindingKind | 'unverified', string>

interface VerifyPanelProps {
  verify: VerifyModel
  units: Units
  /** The setup being verified and the operation the run is cumulative up to. */
  setupName: string
  uptoOperationName: string | null
  colours: VerifyKindColours
  selectedFindingId: string | null
  onSelectFinding: (finding: VerifyFinding) => void
}

const LEGEND_KINDS: ReadonlyArray<VerifyFindingKind | 'unverified'> = ['gouge', 'intendedLeftover', 'unintendedLeftover', 'unverified']
const MARKER_KINDS: ReadonlyArray<VerifyFindingKind | 'unverified'> = ['missingCut', 'extraCut', 'feed', 'unverified']

function summaryCounts(result: VerifyRunResult): { verified: number; deviation: number; unverified: number } {
  const counts = { verified: 0, deviation: 0, unverified: 0 }
  for (const operation of result.operations) counts[operation.verdict] += 1
  return counts
}

export function VerifyPanel({ verify, units, setupName, uptoOperationName, colours, selectedFindingId, onSelectFinding }: VerifyPanelProps) {
  const { t } = useI18n()
  const { result, status, progress, staleness, comparison } = verify
  const running = status === 'running'
  const shownComparison = result?.request.comparison ?? comparison

  function findingRow(finding: VerifyFinding) {
    const selected = finding.id === selectedFindingId
    return (
      <li key={finding.id}>
        <button
          type="button"
          className={`verify-panel__finding${selected ? ' verify-panel__finding--selected' : ''}`}
          data-verify-finding={finding.kind}
          aria-pressed={selected}
          title={t('verify.findingFocus')}
          onClick={() => onSelectFinding(finding)}
        >
          <span className="verify-panel__swatch" style={{ background: colours[finding.kind] }} aria-hidden="true" />
          <span className="verify-panel__finding-kind">{t(VERIFY_KIND_KEYS[finding.kind])}</span>
          <span className="verify-panel__finding-detail">{verifyFindingText(t, finding, units)}</span>
        </button>
      </li>
    )
  }

  function operationGroup(operation: VerifyOperationReport) {
    const more = operation.deviationCount - operation.findings.length
    return (
      <li key={operation.operationId} className="verify-panel__operation" data-verify-operation={operation.operationId} data-verify-verdict={operation.verdict}>
        <div className="verify-panel__operation-head">
          <span className="verify-panel__operation-name">{operation.name}</span>
          <span className={`verify-panel__verdict verify-panel__verdict--${operation.verdict}`}>{t(VERIFY_VERDICT_KEYS[operation.verdict])}</span>
        </div>
        {operation.reasons.length > 0 && (
          <ul className="verify-panel__reasons">
            {operation.reasons.map((reason, index) => <li key={`${reason.code}:${index}`}>{verifyReasonText(t, reason)}</li>)}
          </ul>
        )}
        {operation.findings.length > 0 ? (
          <ul className="verify-panel__findings">{operation.findings.map(findingRow)}</ul>
        ) : operation.verdict !== 'unverified' ? (
          <p className="verify-panel__empty">{t('verify.noFindings')}</p>
        ) : null}
        {more > 0 && <p className="verify-panel__empty">{t('verify.moreDeviations', { count: more })}</p>}
      </li>
    )
  }

  const counts = result ? summaryCounts(result) : null
  const legend = shownComparison === 'internalExported' ? MARKER_KINDS : LEGEND_KINDS

  return (
    <section className="verify-panel" aria-label={t('verify.panelLabel')} data-verify-status={status} data-verify-stale={staleness ?? undefined}>
      <label className="verify-panel__field">
        <span className="verify-panel__label">{t('verify.comparisonLabel')}</span>
        <select
          className="verify-panel__select"
          value={comparison}
          disabled={running}
          onChange={(event) => verify.setComparison(event.target.value as typeof comparison)}
        >
          {VERIFY_COMPARISONS.map((entry) => (
            <option key={entry} value={entry}>{t(VERIFY_COMPARISON_KEYS[entry].label)}</option>
          ))}
        </select>
      </label>
      <p className="verify-panel__hint">{t(VERIFY_COMPARISON_KEYS[comparison].hint)}</p>
      <p className="verify-panel__hint">
        {uptoOperationName !== null
          ? t('verify.scopeUpto', { operation: uptoOperationName })
          : t('verify.scopeAll', { setup: setupName })}
      </p>
      <div className="verify-panel__actions">
        {running ? (
          <>
            <span className="verify-panel__progress" role="status">
              {t('verify.running', { done: progress?.done ?? 0, total: progress?.total ?? 0 })}
            </span>
            <button type="button" className="verify-panel__button" onClick={verify.cancel}>{t('verify.cancel')}</button>
          </>
        ) : (
          <button type="button" className="verify-panel__button verify-panel__button--primary" onClick={verify.run}>
            {t('verify.run')}
          </button>
        )}
      </div>
      {status === 'failed' && <p className="verify-panel__notice verify-panel__notice--error" role="alert">{t('verify.failed')}</p>}
      {!result && status !== 'running' && status !== 'failed' && <p className="verify-panel__hint">{t('verify.idle')}</p>}
      {result && staleness && staleness !== 'current' && (
        <p className="verify-panel__notice" role="status">
          {t(staleness === 'projectEdited' ? 'verify.stale.projectEdited' : 'verify.stale.requestChanged')}
        </p>
      )}
      {result && (
        <div className="verify-panel__results" aria-label={t('verify.resultsLabel')} data-verify-result={result.status}>
          <p className="verify-panel__comparison">{t(VERIFY_COMPARISON_KEYS[result.request.comparison].label)}</p>
          {result.reason && (
            <p className="verify-panel__notice">{t('verify.runUnverified', { reason: verifyReasonText(t, result.reason) })}</p>
          )}
          {counts && <p className="verify-panel__summary">{t('verify.summary', counts)}</p>}
          <ul className="verify-panel__legend" aria-label={t('verify.legendLabel')}>
            {legend.map((kind) => (
              <li key={kind}>
                <span className="verify-panel__swatch" style={{ background: colours[kind] }} aria-hidden="true" />
                {t(VERIFY_KIND_KEYS[kind])}
              </li>
            ))}
          </ul>
          <ul className="verify-panel__operations">
            {result.operations.map(operationGroup)}
            {result.unattributed.length > 0 && (
              <li className="verify-panel__operation" data-verify-operation="">
                <div className="verify-panel__operation-head">
                  <span className="verify-panel__operation-name">{t('verify.unattributed')}</span>
                </div>
                <ul className="verify-panel__findings">{result.unattributed.map(findingRow)}</ul>
              </li>
            )}
          </ul>
        </div>
      )}
    </section>
  )
}
