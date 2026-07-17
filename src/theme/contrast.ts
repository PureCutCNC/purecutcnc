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
 * Contrast and semantic-separation validation for theme palettes.
 *
 * Ratio checks measure WCAG 2.x contrast for critical foreground/background
 * pairs (translucent layers are composited first). Distance checks measure
 * perceptual ΔE between semantic drawing/CAM colors that must stay
 * distinguishable. Failing a `block`-severity check prevents a custom theme
 * from being applied; `warn` results are surfaced but do not block.
 *
 * These are automated spot checks of representative states — they cannot
 * prove global WCAG compliance, so delivery keeps a manual review step.
 */

import { contrastRatio, flattenStack, parseColor, perceptualDistance, type RgbaColor } from './color'
import type { ThemeValues } from './registry'
import type { ThemeTokenKey } from './tokens'

export type ContrastSeverity = 'block' | 'warn'

interface RatioCheck {
  id: string
  label: string
  /** Foreground token. */
  fg: ThemeTokenKey
  /** Background stack, topmost first; flattened over the last entry. */
  bg: ThemeTokenKey[]
  /** Measured below this ratio → blocker. */
  blockBelow?: number
  /** Measured below this ratio (but above blockBelow) → warning. */
  warnBelow?: number
}

interface DistanceCheck {
  id: string
  label: string
  a: ThemeTokenKey
  b: ThemeTokenKey
  /** Both colors are composited over this base before measuring. */
  base: ThemeTokenKey
  /** Measured ΔE below this → warning. */
  warnBelow: number
}

/**
 * Critical text/surface, control, focus, warning, and danger combinations.
 * Core readability blocks Apply; secondary affordances only warn.
 */
const RATIO_CHECKS: readonly RatioCheck[] = [
  { id: 'text-panel', label: 'Primary text on panels', fg: 'text', bg: ['surface-panel', 'surface-app'], blockBelow: 4.5 },
  { id: 'text-app', label: 'Primary text on app background', fg: 'text', bg: ['bg'], blockBelow: 4.5 },
  { id: 'text-raised', label: 'Primary text on dialogs', fg: 'text', bg: ['surface-raised', 'surface-app'], blockBelow: 4.5 },
  { id: 'text-input', label: 'Primary text in inputs', fg: 'text', bg: ['surface-input', 'surface-panel', 'surface-app'], blockBelow: 4.5 },
  { id: 'text-dim-panel', label: 'Muted text on panels', fg: 'text-dim', bg: ['surface-panel', 'surface-app'], blockBelow: 3, warnBelow: 4.5 },
  { id: 'status-text', label: 'Status bar text', fg: 'status-text', bg: ['surface-translucent', 'bg'], blockBelow: 4.5 },
  // The shipped dark accent (white on amber) measures ≈2.2:1, so this gate
  // is calibrated to catch catastrophic edits, not to re-litigate the
  // existing accent design.
  { id: 'on-accent', label: 'Text on accent controls', fg: 'on-accent', bg: ['accent', 'surface-panel', 'surface-app'], blockBelow: 2 },
  { id: 'danger-panel', label: 'Danger text on panels', fg: 'danger-text', bg: ['surface-panel', 'surface-app'], blockBelow: 4.5 },
  { id: 'warning-panel', label: 'Warning text on panels', fg: 'warning-text', bg: ['surface-panel', 'surface-app'], blockBelow: 4.5 },
  { id: 'focus-panel', label: 'Focus indicator on panels', fg: 'accent', bg: ['surface-panel', 'surface-app'], blockBelow: 3 },
  { id: 'focus-raised', label: 'Focus indicator on dialogs', fg: 'accent', bg: ['surface-raised', 'surface-app'], warnBelow: 3 },
  { id: 'canvas-label', label: 'Canvas measurement labels', fg: 'canvas.labelText', bg: ['canvas.labelBackground', 'canvas.background'], blockBelow: 4.5 },
  { id: 'canvas-muted', label: 'Muted geometry on canvas', fg: 'canvas.mutedGeometry', bg: ['canvas.background'], warnBelow: 3 },
  { id: 'role-line-text', label: 'Line role text on panels', fg: 'role-line-text', bg: ['surface-panel', 'surface-app'], warnBelow: 4.5 },
  { id: 'role-region-text', label: 'Region role text on panels', fg: 'role-region-text', bg: ['surface-panel', 'surface-app'], warnBelow: 4.5 },
  { id: 'role-construction-text', label: 'Construction role text on panels', fg: 'role-construction-text', bg: ['surface-panel', 'surface-app'], warnBelow: 4.5 },
  { id: 'add-panel', label: 'Positive/add color on panels', fg: 'add', bg: ['surface-panel', 'surface-app'], warnBelow: 3 },
  { id: 'cut-panel', label: 'Cut color on panels', fg: 'cut', bg: ['surface-panel', 'surface-app'], warnBelow: 3 },
  { id: 'role-line-canvas', label: 'Line role on canvas', fg: 'role-line', bg: ['canvas.background'], warnBelow: 2 },
  { id: 'role-region-canvas', label: 'Region role on canvas', fg: 'role-region', bg: ['canvas.background'], warnBelow: 2 },
  { id: 'role-construction-canvas', label: 'Construction role on canvas', fg: 'role-construction', bg: ['canvas.background'], warnBelow: 2 },
  { id: 'three-grid', label: '3D grid on viewport background', fg: 'three.gridMajor', bg: ['three.background'], warnBelow: 1.15 },
]

/**
 * Project/CAM semantics that must not silently become indistinguishable:
 * feature roles from each other, and add vs. cut operation colors.
 */
const DISTANCE_CHECKS: readonly DistanceCheck[] = [
  { id: 'line-vs-region', label: 'Line vs. region role', a: 'role-line', b: 'role-region', base: 'canvas.background', warnBelow: 12 },
  { id: 'line-vs-construction', label: 'Line vs. construction role', a: 'role-line', b: 'role-construction', base: 'canvas.background', warnBelow: 12 },
  { id: 'region-vs-construction', label: 'Region vs. construction role', a: 'role-region', b: 'role-construction', base: 'canvas.background', warnBelow: 12 },
  { id: 'add-vs-cut', label: 'Add vs. cut operation color', a: 'add', b: 'cut', base: 'surface-panel', warnBelow: 12 },
]

export interface ContrastFinding {
  id: string
  label: string
  kind: 'ratio' | 'distance'
  /** Contrast ratio (1–21) or perceptual ΔE, rounded for display. */
  measured: number
  /** The threshold the finding is judged against (block level if present). */
  required: number
  severity: ContrastSeverity
  /** True when the measured value meets the strictest applicable threshold. */
  pass: boolean
  /** False only for the pass=false subset that blocks Apply. */
  blocking: boolean
}

export interface ThemeContrastReport {
  findings: ContrastFinding[]
  blockers: ContrastFinding[]
  warnings: ContrastFinding[]
}

function color(values: ThemeValues, key: ThemeTokenKey): RgbaColor | null {
  return parseColor(values[key])
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/** Evaluate every check against a complete theme value map. */
export function evaluateThemeContrast(values: ThemeValues): ThemeContrastReport {
  const findings: ContrastFinding[] = []

  for (const check of RATIO_CHECKS) {
    const fg = color(values, check.fg)
    const bgLayers = check.bg.map((key) => color(values, key))
    if (!fg || bgLayers.some((layer) => layer === null)) continue
    const bg = flattenStack(bgLayers as RgbaColor[])
    const measured = contrastRatio(fg, bg)

    const blockLevel = check.blockBelow
    const warnLevel = check.warnBelow
    const strictest = Math.max(blockLevel ?? 0, warnLevel ?? 0)
    const pass = measured >= strictest
    const blocking = blockLevel !== undefined && measured < blockLevel
    findings.push({
      id: check.id,
      label: check.label,
      kind: 'ratio',
      measured: round(measured),
      required: strictest,
      severity: blockLevel !== undefined ? 'block' : 'warn',
      pass,
      blocking,
    })
  }

  for (const check of DISTANCE_CHECKS) {
    const a = color(values, check.a)
    const b = color(values, check.b)
    const base = color(values, check.base)
    if (!a || !b || !base) continue
    const measured = perceptualDistance(a, b, base)
    findings.push({
      id: check.id,
      label: check.label,
      kind: 'distance',
      measured: round(measured),
      required: check.warnBelow,
      severity: 'warn',
      pass: measured >= check.warnBelow,
      blocking: false,
    })
  }

  return {
    findings,
    blockers: findings.filter((finding) => finding.blocking),
    warnings: findings.filter((finding) => !finding.pass && !finding.blocking),
  }
}
