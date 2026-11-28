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

/// <reference types="node" />

/**
 * The Verify mode's words (issue #1269): every reason code of the model check
 * and the exported-motion parity has a translated key in every built-in
 * locale, with the placeholders its English has, and findings read right.
 *
 * Run with: npx tsx src/components/simulation/verifyText.test.ts
 */

import { interpolate, placeholderNames, type MessageParams } from '../../i18n/catalog'
import { enMessages, type MessageKey } from '../../i18n/locales/en'
import { de } from '../../i18n/locales/de'
import { es } from '../../i18n/locales/es'
import { fr } from '../../i18n/locales/fr'
import { zhCN } from '../../i18n/locales/zh-CN'
import { verifyEn } from '../../i18n/locales/en/verify'
import type { VerifyFinding } from '../../app/verify/verifyRun'
import {
  VERIFY_COMPARISON_KEYS,
  VERIFY_KIND_KEYS,
  VERIFY_REASON_KEYS,
  VERIFY_VERDICT_KEYS,
  verifyFindingText,
  verifyReasonText,
} from './verifyText'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const t = (key: MessageKey, params?: MessageParams) => interpolate(enMessages[key], params)

function testEveryCodeIsWorded(): void {
  console.log('Testing every reason and label key exists in every locale...')
  const keys: MessageKey[] = [
    ...Object.values(VERIFY_REASON_KEYS),
    ...Object.values(VERIFY_KIND_KEYS),
    ...Object.values(VERIFY_VERDICT_KEYS),
    ...Object.values(VERIFY_COMPARISON_KEYS).flatMap((entry) => [entry.label, entry.hint]),
  ]
  assert(new Set(Object.values(VERIFY_REASON_KEYS)).size === Object.keys(VERIFY_REASON_KEYS).length, 'one key per reason code')
  for (const key of Object.keys(verifyEn) as MessageKey[]) keys.push(key)
  for (const [name, locale] of [['de', de], ['es', es], ['fr', fr], ['zh-CN', zhCN]] as const) {
    for (const key of keys) {
      const text = (locale as Record<string, string>)[key]
      assert(typeof text === 'string' && text.length > 0, `${name} has ${key}`)
      assert(placeholderNames(text).sort().join() === placeholderNames(enMessages[key]).sort().join(), `${name} ${key} keeps its placeholders`)
    }
  }
}

function testReasonText(): void {
  console.log('Testing reasons carry their command, axis and line...')
  assert(verifyReasonText(t, { code: 'noModel' }) === 'the project has no model to compare against', 'a plain reason')
  assert(verifyReasonText(t, { code: 'unsupportedCommand', command: 'G91', line: 12 }) === 'the reader cannot reconstruct the motion of G91 (line 12)', 'command and line')
  assert(verifyReasonText(t, { code: 'axisNotStated', axis: 'y' }) === 'the program never states the Y axis', 'the axis, upper case')
}

function finding(overrides: Partial<VerifyFinding>): VerifyFinding {
  return {
    id: 'f', kind: 'gouge', operationId: 'op', size: 1.5, area: 12.5,
    at: { x: 0, y: 0, z: 0 }, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, ...overrides,
  }
}

function testFindingText(): void {
  console.log('Testing a finding reads its size in project units...')
  assert(verifyFindingText(t, finding({}), 'mm') === '12.50 mm² · max 1.500 mm', 'a region in mm')
  assert(verifyFindingText(t, finding({ area: 0.02, size: 0.01 }), 'inch') === '0.020 in² · max 0.0100 in', 'a region in inch')
  assert(verifyFindingText(t, finding({ kind: 'missingCut', area: null, size: 0.25 }), 'mm') === '0.250 mm from the other path', 'a distance')
  assert(verifyFindingText(t, finding({ kind: 'extraCut', area: null, size: Infinity }), 'mm') === 'No matching cut on the other path', 'no counterpart')
  assert(verifyFindingText(t, finding({ kind: 'feed', area: null, size: 300, expectedFeed: 600, actualFeed: 300 }), 'mm') === 'Feed 300 instead of 600', 'a feed')
  assert(verifyFindingText(t, finding({ kind: 'feed', area: null, size: Infinity, expectedFeed: 600 }), 'mm') === 'No feed stated; 600 expected', 'a missing feed')
}

testEveryCodeIsWorded()
testReasonText()
testFindingText()
console.log('verifyText tests passed')
