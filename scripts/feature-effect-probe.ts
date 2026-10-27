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
 * `public/examples`) and three generated stress projects, then times:
 *
 *   1. a cold full analysis (the first pass over the whole tree),
 *   2. a single-feature depth edit recheck, and
 *   3. a single-feature geometry edit recheck,
 *
 * through the same analyzer cache, printing how many earlier rows each edit
 * re-evaluated.
 *
 * The stress projects cover the three shapes of coverage work:
 *
 *   - identical outlines (300 features, 300 contours): every row overlaps
 *     every later row, but the first opposite outline already empties the
 *     difference, so this measures the box pre-filter, not the coverage walk;
 *   - fragmenting offsets (120 features, 120 contours): every Add is the same
 *     200 x 160 block and every Subtract is an 18 x 22 piece at a varied
 *     offset, with the right/top margins never reached. No union of later rows
 *     can empty an Add, so coverage walks every later outline and the
 *     remaining geometry fragments into a growing set of pieces;
 *   - text-like many-contour features (16 features, 16 contours each, 256
 *     contours): each row is a word of 8 glyph rectangles, each with its own
 *     hole, at varied offsets. It exercises many inner contours and partial
 *     overlap the way resolved Text geometry does.
 *
 * Run this alone: the reference laptop is shared and the timings mean nothing
 * under another build or test pool. To time only the shipped sample (and leave
 * the stress cases to the manager), pass `--sample-only`.
 *
 * Usage:
 *   npx tsx scripts/feature-effect-probe.ts
 *   npx tsx scripts/feature-effect-probe.ts --sample-only
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
import {
  FeatureEffectAnalyzer,
  type FeatureEffectFeature,
  type FeatureEffectShape,
} from '../src/engine/featureEffect'
import { rectProfile, type Point, type Segment, type SketchProfile } from '../src/types/project'

const EXAMPLE_DIR = 'public/examples'
const ROUNDS = 3
const IDENTICAL_FEATURE_COUNT = 300
const FRAGMENT_FEATURE_COUNT = 120
const TEXT_FEATURE_COUNT = 16
const TEXT_GLYPHS_PER_FEATURE = 8

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

function translatePoint(point: Point, dx: number, dy: number): Point {
  return { x: point.x + dx, y: point.y + dy }
}

function translateSegment(segment: Segment, dx: number, dy: number): Segment {
  switch (segment.type) {
    case 'line':
      return { ...segment, to: translatePoint(segment.to, dx, dy) }
    case 'arc':
      return {
        ...segment,
        to: translatePoint(segment.to, dx, dy),
        center: translatePoint(segment.center, dx, dy),
      }
    case 'bezier':
      return {
        ...segment,
        to: translatePoint(segment.to, dx, dy),
        control1: translatePoint(segment.control1, dx, dy),
        control2: translatePoint(segment.control2, dx, dy),
      }
    case 'circle':
      return {
        ...segment,
        to: translatePoint(segment.to, dx, dy),
        center: translatePoint(segment.center, dx, dy),
      }
  }
}

function translateProfile(profile: SketchProfile, dx: number, dy: number): SketchProfile {
  return {
    start: translatePoint(profile.start, dx, dy),
    segments: profile.segments.map((segment) => translateSegment(segment, dx, dy)),
    closed: profile.closed,
  }
}

function editLastDepth(features: readonly FeatureEffectFeature[]): FeatureEffectFeature[] {
  if (features.length === 0) return []
  return features.map((feature, index) => index === features.length - 1
    ? { ...feature, zTop: feature.zTop + 1, zBottom: feature.zBottom - 1 }
    : feature)
}

/** Moves the last row's outlines, so the cache sees a geometry edit, not a span. */
function editLastGeometry(features: readonly FeatureEffectFeature[]): FeatureEffectFeature[] {
  if (features.length === 0) return []
  return features.map((feature, index) => index === features.length - 1
    ? {
        ...feature,
        shapes: feature.shapes.map((shape) => ({
          ...shape,
          profile: translateProfile(shape.profile, 0.5, 0.25),
        })),
      }
    : feature)
}

function contourCount(features: readonly FeatureEffectFeature[]): number {
  return features.reduce((total, feature) => total + feature.shapes.length, 0)
}

/**
 * Flat features with the same outline and span. Every row overlaps every later
 * row, but the next opposite outline covers it exactly, so the coverage loop
 * ends at the first shape and only the box pre-filter is exercised.
 */
function stressIdenticalFeatures(): FeatureEffectFeature[] {
  const profile = rectProfile(0, 0, 100, 80)
  const features: FeatureEffectFeature[] = []
  for (let index = 0; index < IDENTICAL_FEATURE_COUNT; index += 1) {
    const operation = index % 2 === 0 ? 'add' : 'subtract'
    features.push({
      id: `identical-${index}`,
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

/**
 * Partially overlapping, varied offsets. Every Add is the same 200 x 160 block;
 * every Subtract is an 18 x 22 piece on an 8 x 6 grid that stops 35 units short
 * of the right edge and 13 short of the top edge. No union of later rows can
 * therefore empty an Add, so coverage walks every later outline and the
 * remaining material fragments into a growing set of pieces.
 */
function stressFragmentFeatures(): FeatureEffectFeature[] {
  const features: FeatureEffectFeature[] = []
  for (let index = 0; index < FRAGMENT_FEATURE_COUNT; index += 1) {
    const operation = index % 2 === 0 ? 'add' : 'subtract'
    const profile = operation === 'add'
      ? rectProfile(0, 0, 200, 160)
      : rectProfile(((index * 5) % 8) * 21, ((index * 7) % 6) * 25, 18, 22)
    features.push({
      id: `fragment-${index}`,
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

/**
 * Text-like rows: a word of glyph rectangles, each with its own hole. The
 * analysis prepares every contour but uses only the matching-operation outers
 * as cover, exactly as it does for resolved Text geometry.
 */
function stressTextFeatures(): FeatureEffectFeature[] {
  const features: FeatureEffectFeature[] = []
  for (let index = 0; index < TEXT_FEATURE_COUNT; index += 1) {
    const operation: FeatureEffectFeature['operation'] = index % 2 === 0 ? 'add' : 'subtract'
    const holeOperation: FeatureEffectFeature['operation'] = operation === 'add' ? 'subtract' : 'add'
    const offsetX = (index % 4) * 6
    const offsetY = (index % 3) * 4
    const shapes: FeatureEffectShape[] = []
    for (let glyph = 0; glyph < TEXT_GLYPHS_PER_FEATURE; glyph += 1) {
      const x = offsetX + glyph * 18
      const y = offsetY
      shapes.push({ profile: rectProfile(x, y, 14, 20), operation })
      shapes.push({ profile: rectProfile(x + 4, y + 6, 6, 8), operation: holeOperation })
    }
    features.push({
      id: `text-${index}`,
      operation,
      face: 'top',
      zTop: 10,
      zBottom: 0,
      visible: true,
      shapes,
    })
  }
  return features
}

interface RunTimes {
  full: number[]
  depthEdit: number[]
  geometryEdit: number[]
  recheckedDepth: number[]
  recheckedGeometry: number[]
}

function timeRuns(features: readonly FeatureEffectFeature[]): RunTimes {
  const full: number[] = []
  const depthEdit: number[] = []
  const geometryEdit: number[] = []
  const recheckedDepth: number[] = []
  const recheckedGeometry: number[] = []
  for (let round = 0; round < ROUNDS; round += 1) {
    const analyzer = new FeatureEffectAnalyzer()
    full.push(measure(() => analyzer.analyze(features)).ms)

    const depthEdited = editLastDepth(features)
    let evaluatedDepth = 0
    depthEdit.push(measure(() => analyzer.analyze(depthEdited, {
      onEvaluate: () => { evaluatedDepth += 1 },
    })).ms)
    recheckedDepth.push(evaluatedDepth)

    const geometryEdited = editLastGeometry(depthEdited)
    let evaluatedGeometry = 0
    geometryEdit.push(measure(() => analyzer.analyze(geometryEdited, {
      onEvaluate: () => { evaluatedGeometry += 1 },
    })).ms)
    recheckedGeometry.push(evaluatedGeometry)
  }
  return { full, depthEdit, geometryEdit, recheckedDepth, recheckedGeometry }
}

function report(label: string, details: string, times: RunTimes): void {
  console.log(`\n${label}`)
  console.log(`  ${details}`)
  console.log(`  cold full analysis: ${formatMs(median(times.full))} (median of ${ROUNDS})`)
  console.log(
    `  single-feature depth edit recheck: ${formatMs(median(times.depthEdit))} (median of ${ROUNDS}; `
    + `${median(times.recheckedDepth)} rows re-evaluated)`,
  )
  console.log(
    `  single-feature geometry edit recheck: ${formatMs(median(times.geometryEdit))} (median of ${ROUNDS}; `
    + `${median(times.recheckedGeometry)} rows re-evaluated)`,
  )
}

const sampleOnly = process.argv.slice(2).includes('--sample-only')

console.log('Feature-effect probe (issue #1112 N) — run alone, not beside a build or test pool\n')

const sample = largestSample()
const sampleInput = loadSample(sample)
report(
  `Sample: ${sample.file}`,
  `${sample.features} feature rows in the file, ${sampleInput.length} flat add/subtract rows in the analysis`,
  timeRuns(sampleInput),
)

if (sampleOnly) {
  console.log('\n--sample-only: stress cases skipped.')
} else {
  const identical = stressIdenticalFeatures()
  report(
    `Identical-outline stress: ${identical.length} generated flat features`,
    `one contour each (${contourCount(identical)} contours); same 100 x 80 outline and 0..10 span, `
    + 'alternating Add/Subtract',
    timeRuns(identical),
  )

  const fragment = stressFragmentFeatures()
  report(
    `Fragmenting-offset stress: ${fragment.length} generated flat features`,
    `one contour each (${contourCount(fragment)} contours); Adds share a 200 x 160 block, `
    + 'Subtract offsets leave the right/top margins uncovered, so coverage walks every later outline',
    timeRuns(fragment),
  )

  const text = stressTextFeatures()
  const textOuter = TEXT_FEATURE_COUNT * TEXT_GLYPHS_PER_FEATURE
  report(
    `Text-like stress: ${text.length} generated flat features`,
    `${TEXT_GLYPHS_PER_FEATURE} glyphs each: ${textOuter} outer + ${textOuter} hole contours `
    + `= ${contourCount(text)} contours; varied word offsets partially overlap`,
    timeRuns(text),
  )
}

console.log('\nReport these medians in the PR next to the limit, on the same machine and load.')
