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

import type { ConversionFinding, ConversionReport } from './types'
import { isStrictSafe, summarizeReport } from './types'

const STATUS_LABEL: Record<ConversionFinding['status'], string> = {
  conflicting: 'CONFLICTING',
  unsupported: 'UNSUPPORTED',
  omitted: 'OMITTED',
  mapped: 'MAPPED',
}

// Most-actionable first: strict-blocking issues, then other flagged fields,
// then the routine mapped/omitted ledger.
const STATUS_RANK: Record<ConversionFinding['status'], number> = {
  conflicting: 0,
  unsupported: 1,
  mapped: 2,
  omitted: 3,
}

function sortedFindings(findings: ConversionFinding[]): ConversionFinding[] {
  return [...findings].sort((a, b) => {
    if (a.blocksStrict !== b.blocksStrict) {
      return a.blocksStrict ? -1 : 1
    }
    return STATUS_RANK[a.status] - STATUS_RANK[b.status]
  })
}

function formatFindingLine(finding: ConversionFinding): string {
  const label = STATUS_LABEL[finding.status].padEnd(12, ' ')
  const location = finding.sourceLocation?.line
    ? `${finding.sourceField}:${finding.sourceLocation.line}`
    : finding.sourceField
  const target = finding.targetField ? ` -> ${finding.targetField}` : ''
  const strictFlag = finding.blocksStrict ? ' [blocks --strict]' : ''
  return `[${label}] ${location}${target}${strictFlag}\n    ${finding.message}`
}

/** Renders a report as plain text for CLI stdout or a sibling `.report.txt` file. */
export function formatReportText(report: ConversionReport): string {
  const summary = summarizeReport(report)
  const lines: string[] = []
  lines.push(`Conversion report - ${report.sourceFile} (${report.sourceFormatLabel})`)
  lines.push(`Static analysis only: ${report.staticAnalysisOnly ? 'yes (source was never executed)' : 'n/a (declarative source)'}`)
  lines.push(`Strict-mode safe: ${isStrictSafe(report) ? 'yes' : 'no'}`)
  lines.push(
    `Summary: ${summary.mapped} mapped, ${summary.omitted} omitted, ${summary.unsupported} unsupported, ${summary.conflicting} conflicting`,
  )

  if (report.notes.length > 0) {
    lines.push('', 'Notes:')
    for (const note of report.notes) {
      lines.push(`  - ${note}`)
    }
  }

  lines.push('', 'Findings:')
  for (const finding of sortedFindings(report.findings)) {
    lines.push(formatFindingLine(finding))
  }

  return lines.join('\n') + '\n'
}
