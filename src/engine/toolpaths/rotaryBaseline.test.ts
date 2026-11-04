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
 * #1103 slice ca-a: the baseline table's own contract.
 *
 * `scripts/issue-1103-baseline.md` is the reference every later slice of #1103
 * compares against, so the table has to stay consistent with the protocol it
 * was measured under. A repaste that carries a discarded generation, a median
 * copied from a different set of runs, or rows recorded under another protocol
 * would silently move that reference, and every comparison made against it
 * afterwards would be meaningless. Those are the errors checked here.
 *
 * The timings themselves are a measurement: this asserts their shape and the
 * recorded protocol, never a millisecond value. The fixtures stay in the
 * gitignored `work/` directory, so the table is the only committed record of
 * what was measured.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const doc = readFileSync(
  fileURLToPath(new URL('../../../scripts/issue-1103-baseline.md', import.meta.url)),
  'utf8',
)

// ca-a review finding 2: the saved probe did an extra, discarded generation
// after the single warm-up, so the three timed runs were not measured under
// the required one-warm-up protocol. The protocol is recorded in the document
// and must stay one warm-up and three timed serial runs; the table below is
// checked against it.
const protocol = /warm-ups: (\d+), timed runs: (\d+), serial: (true|false)/.exec(doc)
assert.ok(protocol, 'the baseline records the measurement protocol (warm-ups, timed runs, serial)')
assert.deepEqual(
  {
    warmUps: Number(protocol[1]),
    runs: Number(protocol[2]),
    serial: protocol[3] === 'true',
  },
  { warmUps: 1, runs: 3, serial: true },
  'the baseline protocol is one warm-up and three timed serial runs',
)
const measuredRuns = Number(protocol[2])

interface TimingRow {
  fixture: string
  operation: string
  kind: string
  timings: number[]
  median: number
}

const SHA256 = /^[0-9a-f]{64}$/
const TIMINGS = /^\d+(, \d+)+$/
const rows: TimingRow[] = []
for (const text of doc.split('\n')) {
  if (!text.startsWith('|')) continue
  const cells = text.split('|').slice(1, -1).map((cell) => cell.trim())
  // The timing tables carry ten columns; the candidate-column table has seven
  // and its timing cells are still `—`, so it is skipped by the timing match.
  if (cells.length !== 10) continue
  if (!TIMINGS.test(cells[6])) continue
  const timings = cells[6].split(',').map((value) => Number(value.trim()))
  const median = Number(cells[7])
  for (const value of timings) {
    assert.ok(Number.isInteger(value) && value > 0, `${cells[0]} ${cells[1]}: every timing is a positive integer (${cells[6]})`)
  }
  assert.equal(timings.length, measuredRuns,
    `${cells[0]} ${cells[1]}: the row records exactly the ${measuredRuns} timed runs (${cells[6]})`)
  assert.equal(median, [...timings].sort((left, right) => left - right)[1],
    `${cells[0]} ${cells[1]}: the median is the median of those ${measuredRuns} runs (${median})`)
  const movesDigest = cells[8].replaceAll('`', '')
  const postedDigest = cells[9].replaceAll('`', '')
  assert.match(movesDigest, SHA256, `${cells[0]} ${cells[1]}: the moves hash is a SHA-256`)
  assert.match(postedDigest, SHA256, `${cells[0]} ${cells[1]}: the posted-text hash is a SHA-256`)
  rows.push({
    fixture: cells[0],
    operation: cells[1],
    kind: cells[2],
    timings,
    median,
  })
}

// Six around-the-bar operations plus the two along-mode byte-identical
// controls. Missing rows are as damaging as wrong ones: a later slice that
// cannot find its baseline row silently compares against nothing.
const expected = [
  ['busto-round-stock.camj', 'op0025'],
  ['busto-round-stock.camj', 'op0015'],
  ['busto-rect-stock.camj', 'op0021'],
  ['busto-rect-stock.camj', 'op0022'],
  ['square-to-round-test-01.camj', 'op0028'],
  ['square-to-round-test-01.camj', 'op0029'],
]
for (const [fixture, operation] of expected) {
  assert.ok(rows.some((row) => row.fixture === fixture && row.operation === operation),
    `the baseline carries ${fixture} ${operation}`)
}
assert.equal(rows.length, 8, 'the baseline carries eight timing rows: six around and two along')
assert.deepEqual(
  rows.filter((row) => row.kind.includes('along')).map((row) => row.kind).sort(),
  ['rotary finish (along)', 'rotary rough (along)'],
  'the along-mode byte-identical control has its two rows',
)

// ca-e review P1 (correction round 2): the handoff's generation target is a
// delivery condition, not a note. **Every** row of the ratio table must be at or
// under 1.2x, so there is no "accepted residual" for a document to declare and
// no phrase that can stand in for a measurement: the previous revision of this
// test accepted any row above the target as long as the document mentioned a
// sign-off nobody had given, which is exactly the gap the review found. Export
// is exempt: the fixed cylinder's 2-3 ms postings are timer resolution, which
// the document says.
const GEN_TARGET = 1.2
interface RatioRow {
  case: string
  baseMedian: number
  genRatio: number
  candidateMedian: number
}
const ratioRows: RatioRow[] = []
for (const text of doc.split('\n')) {
  if (!text.startsWith('|')) continue
  const cells = text.split('|').slice(1, -1).map((cell) => cell.trim())
  if (cells.length !== 7) continue
  if (!/^\d+\.\d{2}$/.test(cells[3]) || !/^\d+\.\d{2}$/.test(cells[6])) continue
  const baseMedian = Number(cells[1])
  const candidateMedian = Number(cells[2])
  assert.ok(Number.isFinite(baseMedian) && baseMedian > 0,
    `the ${cells[0]} row records its base median generation time`)
  assert.ok(Number.isFinite(candidateMedian) && candidateMedian > 0,
    `the ${cells[0]} row records its candidate median generation time`)
  // The ratio is the two medians it sits between, rounded to the table's two
  // decimals: a pasted ratio that no longer matches its own columns is a stale
  // measurement, and this is the table the target is judged on.
  assert.ok(Math.abs(cells.length > 0 ? Number(cells[3]) - candidateMedian / baseMedian : 1) <= 0.006,
    `the ${cells[0]} generation ratio is its candidate median over its base median `
    + `(${cells[3]} versus ${candidateMedian} / ${baseMedian})`)
  ratioRows.push({ case: cells[0], baseMedian, genRatio: Number(cells[3]), candidateMedian })
}
assert.equal(ratioRows.length, 9, 'the timing-target table carries all nine cases')
const overTarget = ratioRows.filter((row) => row.genRatio > GEN_TARGET)
assert.deepEqual(overTarget.map((row) => `${row.case} ${row.genRatio}x`), [],
  'every generation row meets the handoff\'s 1.2x target; an over-target row is a regression to fix, '
  + 'not an acceptance to record')
assert.equal(doc.includes('pending Frank'), false,
  'the document does not leave an acceptance pending: the target is met, so nothing needs signing off')

// The candidate-columns table and the ratio table carry the same measurement
// twice, and the review found the first stale by 12 s. A candidate median that
// disagrees with the ratio row it is quoted in is a document that cannot be
// read as one record.
// The candidate-columns table names the fixture file; the ratio table names the
// case. The mapping is explicit so a renamed fixture cannot silently skip the
// comparison.
const FIXTURE_CASE: Record<string, string> = {
  'busto-round-stock': 'busto-round',
  'busto-rect-stock': 'busto-rect',
  'square-to-round-test-01': 'square',
}
const candidateByCase = new Map<string, { median: number; case: string }>()
for (const text of doc.split('\n')) {
  if (!text.startsWith('|')) continue
  const cells = text.split('|').slice(1, -1).map((cell) => cell.trim())
  if (cells.length !== 7) continue
  // The candidate table alone has an operation id in the second column; the
  // ratio table's second cell is the base median, and its export columns are
  // numbers too, so the operation id is what tells the two seven-column tables
  // apart.
  if (!/^op\d+/.test(cells[1])) continue
  // fixture | op | moves | rapids | A reversals | generation ms | export ms
  if (!/^\d+$/.test(cells[2]) || !/^\d+$/.test(cells[3]) || !/^\d+$/.test(cells[5]) || !/^\d+$/.test(cells[6])) continue
  const fixture = FIXTURE_CASE[cells[0].replace(/\.camj$/, '')]
  assert.ok(fixture !== undefined, `the candidate fixture ${cells[0]} has a ratio-table name`)
  const operation = /^op\d+/.exec(cells[1])
  assert.ok(operation !== null, `the candidate row ${cells[1]} names its operation`)
  const ratioCase = `${fixture} ${operation[0]}`
  assert.ok(!candidateByCase.has(ratioCase), `the candidate row ${ratioCase} appears once`)
  candidateByCase.set(ratioCase, { median: Number(cells[5]), case: ratioCase })
}
assert.equal(candidateByCase.size, 6, 'the candidate-columns table carries the six around rows')
// The ratio table spells the square cases `square op0028 (around)`; the candidate
// table's operation cell is just the id.
const ratioByShortCase = new Map(ratioRows.map((row) => [row.case.replace(' (around)', ''), row]))
for (const [name, entry] of candidateByCase) {
  const row = ratioByShortCase.get(name)
  assert.ok(row !== undefined, `the candidate row ${name} has a ratio-table case`)
  assert.equal(row.candidateMedian, entry.median,
    `the ${name} candidate median is the same in both tables (${entry.median} versus ${row.candidateMedian})`)
}

// #1103 ca-g correction round 1 (review P2): the previous revision reported
// square ratios above 1.2x and then substituted a same-session **ca-f**
// comparison for the ca-a base, and this test still only read the older tables,
// so nothing checked the numbers the ca-g section actually reports. The
// re-measured table is therefore parsed **by its heading** and required to be
// complete, internally consistent and at or under the target: every row, its
// ratio, and its hash against the byte-identical table (except op0025, whose
// ca-g hash the prose records because that row's motion changed).
const CAG_HEADING = '### Generation against the ca-a base, re-measured (correction round 1)'
const cagStart = doc.indexOf(CAG_HEADING)
assert.ok(cagStart >= 0, 'the baseline carries the ca-g ca-a re-measurement table')
interface CagRow {
  case: string
  baseMedian: number
  candidateMedian: number
  ratio: number
  baseMoves: number
  candidateMoves: number
  hash: string
}
const cagRows: CagRow[] = []
let inCagTable = false
for (const text of doc.slice(cagStart).split('\n')) {
  if (!text.startsWith('|')) {
    if (inCagTable) break
    continue
  }
  const cells = text.split('|').slice(1, -1).map((cell) => cell.trim())
  // Skip the header and its separator.
  if (!/^\d+$/.test(cells[1] ?? '')) continue
  inCagTable = true
  assert.equal(cells.length, 7,
    `the ca-g row ${cells[0]} carries case, base median, candidate median, ratio, both move counts and the hash`)
  const hash = cells[6].replaceAll('`', '')
  assert.match(hash, SHA256, `the ca-g row ${cells[0]} carries a moves SHA-256`)
  const baseMedian = Number(cells[1])
  const candidateMedian = Number(cells[2])
  assert.ok(Number.isInteger(baseMedian) && baseMedian > 0,
    `the ca-g row ${cells[0]} records its measured ca-a median`)
  assert.ok(Number.isInteger(candidateMedian) && candidateMedian > 0,
    `the ca-g row ${cells[0]} records its measured ca-g median`)
  assert.ok(Math.abs(Number(cells[3]) - candidateMedian / baseMedian) <= 0.006,
    `the ca-g row ${cells[0]} ratio is its candidate over its base median `
    + `(${cells[3]} versus ${candidateMedian} / ${baseMedian})`)
  cagRows.push({
    case: cells[0],
    baseMedian,
    candidateMedian,
    ratio: Number(cells[3]),
    baseMoves: Number(cells[4]),
    candidateMoves: Number(cells[5]),
    hash,
  })
}
// The handoff's measurement list: every around row, the square fixture's around
// rows and the single-deep-layer rough, plus the two along controls.
const CAG_REQUIRED = [
  'busto-round op0015',
  'busto-round op0025',
  'busto-rect op0021',
  'busto-rect op0022',
  'square op0028 (around)',
  'square op0029 (around)',
  'square op0028 (along)',
  'square op0029 (along)',
  'busto-round op0025, one deep layer',
]
assert.equal(cagRows.length, CAG_REQUIRED.length,
  `the ca-g table carries every measured case (${cagRows.length})`)
for (const name of CAG_REQUIRED) {
  assert.ok(cagRows.some((row) => row.case === name), `the ca-g table carries ${name}`)
}
const cagOverTarget = cagRows.filter((row) => row.ratio > GEN_TARGET)
assert.deepEqual(cagOverTarget.map((row) => `${row.case} ${row.ratio}x`), [],
  `every re-measured ca-g generation row meets the ${GEN_TARGET}x target against ca-a`)
// The ca-g hashes are the same programs the byte-identical table pins, so the
// table above cannot describe a measurement of anything else.
const normalizeCase = (value: string): string => value
  .replace(/[()]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
// The ca-f table names a fixture file and an operation; the ca-g table names the
// case. Both reduce to the same key.
const fixtureCase = (value: string): string => {
  const base = value.replace(/\.camj$/, '').replace(/-stock$/, '')
  return normalizeCase(base === 'square-to-round-test-01' ? 'square' : base)
}
const pinned = new Map<string, string>()
for (const text of doc.split('\n')) {
  if (!text.startsWith('|')) continue
  const cells = text.split('|').slice(1, -1).map((cell) => cell.trim())
  // `| case | moves sha256 |` (the ca-g table) and `| fixture | op | moves sha256 |`
  // (the ca-f table) both pin the same programs.
  const sha = (cell: string | undefined): string | undefined => {
    const found = /`([0-9a-f]{64})`/.exec(cell ?? '')
    return found === null ? undefined : found[1]
  }
  if (cells.length === 2 && sha(cells[1]) !== undefined) {
    pinned.set(normalizeCase(cells[0]), sha(cells[1])!)
  } else if (cells.length === 3 && /^op\d+/.test(cells[1]) && sha(cells[2]) !== undefined) {
    // The ca-f table's older row can carry "(was …)" after the curated hash; the
    // first backticked digest is the one that table records.
    pinned.set(`${fixtureCase(cells[0])} ${normalizeCase(cells[1])}`, sha(cells[2])!)
  }
}
assert.ok(pinned.size > 0, 'the baseline pins the byte-identical moves hashes')
const prose = /`busto-round op0025` moved to `([0-9a-f]{64})`/.exec(doc)
assert.ok(prose !== null, 'the ca-g hash of busto-round op0025 is recorded')
for (const row of cagRows) {
  if (row.case === 'busto-round op0025') {
    // That row's motion changed with this slice; the prose records its ca-g hash.
    assert.equal(row.hash, prose[1], 'the re-measured busto-round op0025 hash is the recorded one')
    continue
  }
  const known = pinned.get(normalizeCase(row.case))
  assert.ok(known !== undefined, `the ca-g row ${row.case} has a byte-identical hash to compare with`)
  assert.equal(row.hash, known, `the re-measured ${row.case} hash is the one the baseline pins`)
}

console.log(`  baseline: ${rows.length} rows, protocol 1 warm-up + ${measuredRuns} timed runs, medians consistent; `
  + `${ratioRows.length} generation ratios all <= ${GEN_TARGET}x; `
  + `${cagRows.length} re-measured ca-g rows against ca-a, all <= ${GEN_TARGET}x`)
