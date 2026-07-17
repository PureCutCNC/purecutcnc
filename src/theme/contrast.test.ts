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

import { evaluateThemeContrast } from './contrast'
import { BUILTIN_THEMES, resolveBuiltinTheme } from './registry'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// Built-ins must pass every check cleanly — a shipped default that trips its
// own validation gate would read as broken in the editor.
for (const definition of BUILTIN_THEMES) {
  const report = evaluateThemeContrast(definition.values)
  assert(report.findings.length > 0, `${definition.id} produces findings`)
  const failures = [...report.blockers, ...report.warnings].map((finding) => `${finding.id}=${finding.measured}`)
  assert(
    failures.length === 0,
    `built-in ${definition.id} passes all contrast checks (failed: ${failures.join(', ')})`,
  )
}

// An unreadable panel (text ≈ background) must block.
const unreadable = { ...resolveBuiltinTheme('dark').values, text: '#101821' }
const unreadableReport = evaluateThemeContrast(unreadable)
assert(unreadableReport.blockers.some((finding) => finding.id === 'text-panel'), 'invisible panel text blocks')
assert(unreadableReport.blockers.every((finding) => finding.severity === 'block'), 'blockers carry block severity')

// A washed-out focus indicator must block (non-text contrast).
const noFocus = { ...resolveBuiltinTheme('light').values, accent: '#f4efe6' }
assert(
  evaluateThemeContrast(noFocus).blockers.some((finding) => finding.id === 'focus-panel'),
  'invisible focus indicator blocks',
)

// Muted text between 3:1 and 4.5:1 warns without blocking.
const dimmed = { ...resolveBuiltinTheme('dark').values, 'text-dim': '#5a6b7c' }
const dimmedReport = evaluateThemeContrast(dimmed)
const dimFinding = dimmedReport.findings.find((finding) => finding.id === 'text-dim-panel')
assert(dimFinding !== undefined && !dimFinding.pass, 'lowered muted text is flagged')
assert(
  dimmedReport.warnings.some((finding) => finding.id === 'text-dim-panel')
    || dimmedReport.blockers.some((finding) => finding.id === 'text-dim-panel'),
  'lowered muted text lands in warnings or blockers by measured value',
)

// Unreadable canvas labels must block (composited over translucent label chip).
const badLabels = {
  ...resolveBuiltinTheme('dark').values,
  'canvas.labelText': 'rgba(18, 26, 36, 0.9)',
}
assert(
  evaluateThemeContrast(badLabels).blockers.some((finding) => finding.id === 'canvas-label'),
  'unreadable canvas labels block',
)

// Semantic role colors collapsing together must warn (distance check).
const mergedRoles = {
  ...resolveBuiltinTheme('dark').values,
  'role-region': '#5a8fcc',
}
const mergedReport = evaluateThemeContrast(mergedRoles)
assert(
  mergedReport.warnings.some((finding) => finding.id === 'line-vs-region' && finding.kind === 'distance'),
  'indistinguishable line/region roles warn',
)
assert(!mergedReport.blockers.some((finding) => finding.id === 'line-vs-region'), 'semantic distance warns, never blocks')

// Add vs cut collapsing must warn.
const mergedOps = {
  ...resolveBuiltinTheme('dark').values,
  add: '#5a8fcc',
}
assert(
  evaluateThemeContrast(mergedOps).warnings.some((finding) => finding.id === 'add-vs-cut'),
  'indistinguishable add/cut colors warn',
)

// Findings expose measured values for the editor UI.
const report = evaluateThemeContrast(resolveBuiltinTheme('dark').values)
for (const finding of report.findings) {
  assert(Number.isFinite(finding.measured) && finding.measured > 0, `finding ${finding.id} has a measured value`)
  assert(finding.required > 0, `finding ${finding.id} has a required threshold`)
}

console.log('contrast tests passed')
