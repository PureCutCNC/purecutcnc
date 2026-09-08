/**
 * Pre-extraction parity baseline capture (issue #675, slice 1).
 *
 * Renders the **real, unmodified** `useToolpathGeneration` hook over the
 * parity corpus and writes the golden file the extraction is then asserted
 * against. React's `useMemo`/`useState`/`useRef` all run under
 * `renderToString`, and `useEffect` does not — which is exactly what is wanted
 * here: the generation callbacks are produced by the genuine hook, while the
 * rAF-driven background pipeline never starts.
 *
 * Why this and not a transcription of the dispatch: an oracle copied by hand
 * bakes any transcription slip into the expected values, so the parity test
 * would then confirm the slip rather than catch it. This script calls the
 * shipped code path.
 *
 * ## Regenerating
 *
 * Do **not** run this after the extraction has landed — it would then capture
 * the new implementation and the test would be asserting against itself. The
 * goldens are captured once, from a checkout that predates
 * `generateOperation.ts`, and committed:
 *
 *     git checkout <pre-extraction SHA>
 *     npx tsx scripts/issue-675/capture-baseline.ts
 *
 * The `baseSha` field in the golden file records which checkout produced it.
 */

import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildParityCorpus, postParityCase, type ParityCase } from '../../src/engine/toolpaths/parityCorpus'
import { useToolpathGeneration } from '../../src/app/useToolpathGeneration'
import { canonicalize, summarize, type ParityRecord } from '../../src/engine/toolpaths/parityRecord'
import type { Operation } from '../../src/types/project'
import type { ToolpathGenerationTrace, ToolpathResult } from '../../src/engine/toolpaths'

const OUT = new URL('../../src/engine/toolpaths/__baseline__/issue-675-parity.json', import.meta.url)

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Drive the genuine hook once and hand back both generation entry points' output. */
function captureCase(parityCase: ParityCase): ParityRecord {
  const { project, operationId } = parityCase
  const operation = project.operations.find((op) => op.id === operationId)
  if (!operation) throw new Error(`${parityCase.id}: operation ${operationId} not in project`)

  let direct: ToolpathResult | null = null
  let trace: ToolpathGenerationTrace | null = null

  function Harness(): null {
    const hook = useToolpathGeneration(project, operation as Operation, false)
    direct = hook.generateToolpathForOperation(operation as Operation)
    trace = hook.getGenerationTrace(operation as Operation)
    return null
  }
  renderToString(createElement(Harness))

  const result = direct as ToolpathResult | null
  if (!result) throw new Error(`${parityCase.id}: generation returned null`)
  const captured = trace as ToolpathGenerationTrace | null
  if (!captured) throw new Error(`${parityCase.id}: trace capture returned null`)

  // Generation must be deterministic for the corpus to be an oracle at all:
  // the cold-cache call and the trace's forced recompute have to agree.
  const directJson = canonicalize(result)
  if (directJson !== canonicalize(captured.optimized)) {
    throw new Error(`${parityCase.id}: generation is not deterministic — direct and trace results differ`)
  }

  return {
    resultHash: sha256(directJson),
    rawHash: sha256(canonicalize(captured.raw)),
    gcodeHash: sha256(postParityCase(project, operation, result)),
    ...summarize(result, captured.raw, postParityCase(project, operation, result)),
  }
}

// `PARITY_ONLY=<substring>` runs a subset and writes nothing — for checking a
// case while building the corpus, never for producing goldens.
const only = process.env.PARITY_ONLY ?? ''
const corpus = buildParityCorpus().filter((entry) => entry.id.includes(only))
const records: Record<string, ParityRecord> = {}
let empty = 0

for (const parityCase of corpus) {
  const record = captureCase(parityCase)
  records[parityCase.id] = record
  if (record.moves === 0) empty += 1
  console.log(`${record.moves === 0 ? '!' : ' '} ${parityCase.id.padEnd(52)} moves=${String(record.moves).padStart(6)} raw=${String(record.rawMoves).padStart(6)} gcode=${String(record.gcodeLines).padStart(6)} warn=[${record.warnings.join(',')}]`)
}

if (only) {
  console.log(`\nPARITY_ONLY=${only} — dry run over ${corpus.length} case(s); golden file not written`)
  process.exit(empty > 0 ? 1 : 0)
}

const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
mkdirSync(dirname(fileURLToPath(OUT)), { recursive: true })
writeFileSync(fileURLToPath(OUT), `${JSON.stringify({
  issue: 675,
  what: 'Pre-extraction generation baseline. Captured from the real useToolpathGeneration hook; never regenerate from the extracted implementation.',
  command: 'npx tsx scripts/issue-675/capture-baseline.ts',
  baseSha,
  cases: records,
}, null, 2)}\n`, 'utf8')

console.log(`\ncaptured ${corpus.length} cases at ${baseSha}${empty > 0 ? ` (${empty} produced no moves)` : ''}`)
console.log(`wrote ${fileURLToPath(OUT)}`)
