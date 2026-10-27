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
 * Performance probe for the "no effect" analysis (issue #1112 slice N).
 *
 * This is the measured check decision 12 requires before the warning ships. It
 * loads the largest shipped sample project (by feature count, under
 * `public/examples`) and a generated stress project, then times:
 *
 *   1. a cold full analysis (the first pass over the whole tree), and
 *   2. a single-feature edit recheck through the same analyzer cache, printing
 *      how many earlier rows it re-evaluated.
 *
 * The stress project is 300 overlapping flat features, alternating Add /
 * Subtract with the same outline and span. That is the deliberately bad case
 * for the box pre-filter: every row overlaps every later row. The first later
 * opposite row already covers it, so the coverage work stays bounded while the
 * 45k span/box comparisons still run.
 *
 * Run this alone: the reference laptop is shared and the timings mean nothing
 * under another build or test pool.
 *
 * Usage:
 *   npx tsx scripts/feature-effect-probe.ts
 *
 * Compare the printed medians against the limit stated in the PR. This script
 * asserts nothing about the numbers — it reports them so the limit is measured,
 * not guessed.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { decodeProjectFormat } from '../src/store/helpers/projectFormat'
import { resolvedProjectFeatures } from '../src/store/helpers/resolveFeatures'
import { buildEffectFeatures } from '../src/app/featureEffect/effectInput'
import { FeatureEffectAnalyzer, type FeatureEffectFeature } from '../src/engine/featureEffect'
import { rectProfile } from '../src/types/project'

const EXAMPLE_DIR = 'public/examples'
const ROUNDS = 3
const STRESS_FEATURE_COUNT = 300

interface Measurement<T> {
  value: T
  ms: number
}

function measure<T>(work: () => T): Measurement<T> {
  const start = performance.now()
  const value = work()
  return { value, ms: performance.now() - start }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function formatMs(value: number): string {
  return `${value.toFixed(2)} ms`
}

interface SampleChoice {
  file: string
  features: number
  bytes: number
}

/**
 * The largest shipped sample by feature count. The analysis scales with the
 * number of rows, not with the bytes of an embedded mesh, so feature count is
 * the honest "largest" for this probe; bytes break a tie.
 */
function largestSample(): SampleChoice {
  const files = readdirSync(EXAMPLE_DIR).filter((name) => name.endsWith('.camj'))
  let best: SampleChoice | null = null
  for (const name of files) {
    const file = join(EXAMPLE_DIR, name)
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { features?: unknown[] }
    const features = Array.isArray(raw.features) ? raw.features.length : 0
    const bytes = statSync(file).size
    if (!best || features > best.features || (features === best.features && bytes > best.bytes)) {
      best = { file, features, bytes }
    }
  }
  if (!best) throw new Error(`no .camj files under ${EXAMPLE_DIR}`)
  return best
}

function loadSample(input: SampleChoice): FeatureEffectFeature[] {
  const parsed = JSON.parse(readFileSync(input.file, 'utf8')) as unknown
  const project = decodeProjectFormat(parsed).project
  const resolved = resolvedProjectFeatures(project)
  return buildEffectFeatures(project, resolved)
}

function editLast(features: readonly FeatureEffectFeature[]): FeatureEffectFeature[] {
  if (features.length === 0) return []
  return features.map((feature, index) => index === features.length - 1
    ? { ...feature, zTop: feature.zTop + 1, zBottom: feature.zBottom - 1 }
    : feature)
}

/**
 * 300 overlapping flat rectangles, alternating Add and Subtract with the same
 * outline and span. Every row overlaps every later row; the next opposite row
 * covers it exactly, so the full pass exercises the box pre-filter over the
 * whole square (45k comparisons) without asking Clipper to walk a long union.
 */
function stressFeatures(): FeatureEffectFeature[] {
  const profile = rectProfile(0, 0, 100, 80)
  const features: FeatureEffectFeature[] = []
  for (let index = 0; index < STRESS_FEATURE_COUNT; index += 1) {
    const operation = index % 2 === 0 ? 'add' : 'subtract'
    features.push({
      id: `stress-${index}`,
      operation,
      face: 'top',
      zTop: 10,
      zBottom: 0,
      visible: true,
      shapes: [{ profile, operation }],
    })
  }
  return features
}

interface RunTimes {
  full: number[]
  edit: number[]
  rechecked: number[]
}

function timeRuns(features: readonly FeatureEffectFeature[]): RunTimes {
  const full: number[] = []
  const edit: number[] = []
  const rechecked: number[] = []
  for (let round = 0; round < ROUNDS; round += 1) {
    const analyzer = new FeatureEffectAnalyzer()
    full.push(measure(() => analyzer.analyze(features)).ms)
    const edited = editLast(features)
    let evaluated = 0
    edit.push(measure(() => analyzer.analyze(edited, { onEvaluate: () => { evaluated += 1 } })).ms)
    rechecked.push(evaluated)
  }
  return { full, edit, rechecked }
}

function report(label: string, details: string, times: RunTimes): void {
  console.log(`\n${label}`)
  console.log(`  ${details}`)
  console.log(`  cold full analysis: ${formatMs(median(times.full))} (median of ${ROUNDS})`)
  const editMedian = median(times.edit)
  const recheckedMedian = median(times.rechecked)
  console.log(`  single-feature edit recheck: ${formatMs(editMedian)} (median of ${ROUNDS}; ${recheckedMedian} rows re-evaluated)`)
}

console.log('Feature-effect probe (issue #1112 N) — run alone, not beside a build or test pool\n')

const sample = largestSample()
const sampleInput = loadSample(sample)
report(
  `Sample: ${sample.file}`,
  `${sample.features} feature rows in the file, ${sampleInput.length} flat add/subtract rows in the analysis`,
  timeRuns(sampleInput),
)

const stress = stressFeatures()
report(
  `Stress: ${STRESS_FEATURE_COUNT} generated overlapping flat features`,
  'same 100 x 80 outline and 0..10 span, alternating Add/Subtract',
  timeRuns(stress),
)

console.log('\nReport these medians in the PR next to the limit, on the same machine and load.')
