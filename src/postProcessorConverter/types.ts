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

import type { MachineDefinition } from '../engine/gcode/types'

/** Recursive partial of a MachineDefinition. Arrays are replaced wholesale
 *  (never merged element-by-element) since program/toolChange line arrays
 *  are ordered templates, not independent fields. */
export type DeepPartial<T> = T extends (infer U)[]
  ? U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T

/** Adapter output before it is overlaid onto the generic baseline. Never
 *  includes `id`/`name`/`description`/`vendor`/`builtin` — those describe the
 *  output definition and are set by the CLI, not derived from source content. */
export type MachineDefinitionDraft = Omit<
  DeepPartial<MachineDefinition>,
  'id' | 'name' | 'description' | 'vendor' | 'builtin'
>

export type SourceFormatId =
  | 'visual-mill'
  | 'vectric-estlcam'
  | 'artcam'
  | 'ecam'
  | 'sheetcam'
  | 'autodesk-cps'
  | 'mastercam-pst'

export type FindingStatus = 'mapped' | 'omitted' | 'unsupported' | 'conflicting'

/**
 * One source setting's fate, per the issue #402 contract: every source field
 * is recorded as mapped, omitted, unsupported, or conflicting — never
 * silently dropped. `blocksStrict` is a deliberate per-finding call by the
 * adapter (not derived from `status`): it means "if this were dropped
 * silently, the emitted G-code for a normal 3-axis job would differ from
 * what the source declares." Cosmetic/informational gaps (an unused vendor
 * capability, a formatting nuance our schema can't distinguish) leave it
 * false even when `status` is 'unsupported' or 'conflicting'.
 */
export interface ConversionFinding {
  status: FindingStatus
  /** Source key/section/callback this finding is about, e.g. "GENERAL_ShowLeadingZeros". */
  sourceField: string
  /** Dot-path into MachineDefinition, e.g. "numberFormat.leadingZero", when applicable. */
  targetField?: string
  sourceLocation?: { line?: number; section?: string }
  message: string
  blocksStrict: boolean
}

export interface ConversionReport {
  sourceFormat: SourceFormatId
  sourceFormatLabel: string
  sourceFile: string
  /** True for the SheetCAM/Autodesk/Mastercam extractors, which recognize
   *  known static patterns and never evaluate the source's own language. */
  staticAnalysisOnly: boolean
  findings: ConversionFinding[]
  /** Free-form, non-field-specific notes (e.g. "OnDrill implements a custom
   *  peck loop; static extraction does not evaluate Lua control flow"). */
  notes: string[]
}

export function isStrictSafe(report: ConversionReport): boolean {
  return !report.findings.some((finding) => finding.blocksStrict)
}

export interface ConversionSummary {
  mapped: number
  omitted: number
  unsupported: number
  conflicting: number
}

export function summarizeReport(report: ConversionReport): ConversionSummary {
  const summary: ConversionSummary = { mapped: 0, omitted: 0, unsupported: 0, conflicting: 0 }
  for (const finding of report.findings) {
    summary[finding.status] += 1
  }
  return summary
}

/** One adapter's output: draft overrides plus the findings that justify them. */
export interface AdapterResult {
  overrides: MachineDefinitionDraft
  findings: ConversionFinding[]
  notes?: string[]
}

export interface SourceAdapter {
  id: SourceFormatId
  label: string
  /** Lowercase, no leading dot, e.g. ['spm']. Used by extension-based auto-detection. */
  fileExtensions: string[]
  staticAnalysisOnly: boolean
  convert: (fileText: string, filePath: string) => AdapterResult
}
