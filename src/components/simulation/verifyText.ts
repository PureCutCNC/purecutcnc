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
 * The Verify mode's words (issue #1269): every reason code of the model check
 * and the exported-motion parity maps to one catalog key, and each finding to
 * its line of text. Pure, so a test can hold the mapping without a DOM.
 */

import type { MessageParams } from '../../i18n/catalog'
import type { MessageKey } from '../../i18n/locales/en'
import type { VerifyComparison } from '../../app/verify/verifyRequest'
import type { VerifyFinding, VerifyFindingKind, VerifyReason, VerifyReasonCode, VerifyVerdict } from '../../app/verify/verifyRun'
import type { Units } from '../../utils/units'

type Translate = (key: MessageKey, params?: MessageParams) => string

/** One key per code. Typed as a full record, so a new engine code cannot go unworded. */
export const VERIFY_REASON_KEYS: Record<VerifyReasonCode, MessageKey> = {
  aroundSetup: 'verify.reason.aroundSetup',
  rotaryOperation: 'verify.reason.rotaryOperation',
  rotaryMotion: 'verify.reason.rotaryMotion',
  unsupportedSetup: 'verify.reason.unsupportedSetup',
  uptoOperationNotFound: 'verify.reason.uptoOperationNotFound',
  noModel: 'verify.reason.noModel',
  exportUnsupported: 'verify.reason.exportUnsupported',
  exportFailed: 'verify.reason.exportFailed',
  noCutMoves: 'verify.reason.noCutMoves',
  unparsedText: 'verify.reason.unparsedText',
  unsupportedCommand: 'verify.reason.unsupportedCommand',
  machineCoordinateRetract: 'verify.reason.machineCoordinateRetract',
  machineCoordinateMove: 'verify.reason.machineCoordinateMove',
  rapidAfterMachineRetract: 'verify.reason.rapidAfterMachineRetract',
  workZUnknown: 'verify.reason.workZUnknown',
  motionWithoutMode: 'verify.reason.motionWithoutMode',
  inverseTimeFeedMissing: 'verify.reason.inverseTimeFeedMissing',
  arcCentreMissing: 'verify.reason.arcCentreMissing',
  arcRadiusTooSmall: 'verify.reason.arcRadiusTooSmall',
  cannedCycleIncomplete: 'verify.reason.cannedCycleIncomplete',
  cannedCycleWithRotary: 'verify.reason.cannedCycleWithRotary',
  cannedRetractModeAssumed: 'verify.reason.cannedRetractModeAssumed',
  chipBreakRetractApproximate: 'verify.reason.chipBreakRetractApproximate',
  probeMove: 'verify.reason.probeMove',
  touchOffZ: 'verify.reason.touchOffZ',
  rotaryZeroed: 'verify.reason.rotaryZeroed',
  workOffsetChange: 'verify.reason.workOffsetChange',
  parseFailure: 'verify.reason.parseFailure',
  unsupportedStatement: 'verify.reason.unsupportedStatement',
  emptyProgram: 'verify.reason.emptyProgram',
  operationRefused: 'verify.reason.operationRefused',
  postFailed: 'verify.reason.postFailed',
  noTool: 'verify.reason.noTool',
  axisNotStated: 'verify.reason.axisNotStated',
  manualIndexTurnRemoved: 'verify.reason.manualIndexTurnRemoved',
  noToolpath: 'verify.reason.noToolpath',
  noMachine: 'verify.reason.noMachine',
  noOperations: 'verify.reason.noOperations',
}

export const VERIFY_COMPARISON_KEYS: Record<VerifyComparison, { label: MessageKey; hint: MessageKey }> = {
  modelInternal: { label: 'verify.comparison.modelInternal', hint: 'verify.comparisonHint.modelInternal' },
  modelExported: { label: 'verify.comparison.modelExported', hint: 'verify.comparisonHint.modelExported' },
  internalExported: { label: 'verify.comparison.internalExported', hint: 'verify.comparisonHint.internalExported' },
}

export const VERIFY_KIND_KEYS: Record<VerifyFindingKind | 'unverified', MessageKey> = {
  gouge: 'verify.kind.gouge',
  intendedLeftover: 'verify.kind.intendedLeftover',
  unintendedLeftover: 'verify.kind.unintendedLeftover',
  missingCut: 'verify.kind.missingCut',
  extraCut: 'verify.kind.extraCut',
  feed: 'verify.kind.feed',
  unverified: 'verify.kind.unverified',
}

export const VERIFY_VERDICT_KEYS: Record<VerifyVerdict, MessageKey> = {
  verified: 'verify.verdict.verified',
  deviation: 'verify.verdict.deviation',
  unverified: 'verify.verdict.unverified',
}

/** A reason as one sentence fragment, with its program line when it has one. */
export function verifyReasonText(t: Translate, reason: VerifyReason): string {
  const text = t(VERIFY_REASON_KEYS[reason.code], {
    command: reason.command ?? '—',
    axis: (reason.axis ?? '—').toUpperCase(),
  })
  return reason.line !== undefined ? t('verify.reasonAtLine', { reason: text, line: reason.line }) : text
}

function unitLabel(units: Units): string {
  return units === 'inch' ? 'in' : 'mm'
}

/** A length in project units, at the precision the program is written in. */
export function formatVerifyLength(value: number, units: Units): string {
  return `${value.toFixed(units === 'inch' ? 4 : 3)} ${unitLabel(units)}`
}

function formatArea(value: number, units: Units): string {
  return `${value.toFixed(units === 'inch' ? 3 : 2)} ${unitLabel(units)}²`
}

function formatFeed(value: number): string {
  return Number(value.toFixed(3)).toString()
}

/** The detail line of one finding. */
export function verifyFindingText(t: Translate, finding: VerifyFinding, units: Units): string {
  if (finding.kind === 'feed') {
    const expected = formatFeed(finding.expectedFeed ?? 0)
    return finding.actualFeed === undefined || !Number.isFinite(finding.size)
      ? t('verify.findingFeedMissing', { expected })
      : t('verify.findingFeed', { actual: formatFeed(finding.actualFeed), expected })
  }
  if (finding.area !== null) {
    return t('verify.findingRegion', { area: formatArea(finding.area, units), size: formatVerifyLength(finding.size, units) })
  }
  return Number.isFinite(finding.size)
    ? t('verify.findingDistance', { size: formatVerifyLength(finding.size, units) })
    : t('verify.findingNoCounterpart')
}
