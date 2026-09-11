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
 * Warning severity (issue #755).
 *
 * The error tier blocks an export, so what it contains is a decision rather
 * than a default: promoting a code can refuse a program that cuts correctly for
 * someone today. This pins the one promotion and the default the rest rely on.
 */

import { warningSeverity } from './warningCodes'
import type { ToolpathWarningCode } from './warningCodes'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// The rule the issue is about: with M6 off, a program that changes tool
// machines B's paths with A's cutter, so it must not be saveable.
assert(
  warningSeverity('postToolChangesDisabled') === 'error',
  'an unexecuted tool change is an error, not a warning',
)

// Everything else defaults to warning — including the codes closest to it in
// the postprocessor group, which annotate a program rather than invalidate it.
const STILL_WARNINGS: readonly ToolpathWarningCode[] = [
  'postWcsNullSelect',
  'postNoCoolantCommands',
  'postCannedCycleUnsupported',
  'postArcNoCapability',
  'postArcFallbackLinear',
  'cutDepthExceedsToolMax',
  'entryStrategyFallback',
  'tabNoIntersect',
  'clampCrossedOne',
  'targetsMissing',
]
for (const code of STILL_WARNINGS) {
  assert(warningSeverity(code) === 'warning', `${code} must stay a warning`)
}

console.log('gcode warning severity tests passed')
