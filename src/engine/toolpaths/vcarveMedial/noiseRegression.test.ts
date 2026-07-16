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

import { readFileSync } from 'node:fs'

import { normalizeProject } from '../../../store/helpers/projectFormat'
import { resolvePocketRegions } from '../resolver'
import {
  computeMedialAxis,
  extractChains,
  regionConvexCorners,
  resolveMedialResolution,
} from './index'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(a: number, b: number, epsilon = 1e-9): boolean {
  return Math.abs(a - b) < epsilon
}

interface RegionStats {
  resolution: number
  cornerCount: number
  nonCornerLeaves: number
  chainCount: number
}

function loadNoiseRegressionProject(): ReturnType<typeof normalizeProject> {
  const url = new URL('../../test-fixtures/v-carve-noise-test.camj', import.meta.url)
  const input = JSON.parse(readFileSync(url, 'utf8')) as Parameters<typeof normalizeProject>[0]
  return normalizeProject(input)
}

function quarterInchNoiseRegressionProject(): ReturnType<typeof normalizeProject> {
  const project = structuredClone(loadNoiseRegressionProject())
  const definition = project.featureDefinitions['f-0004']
  assert(definition?.text !== null && definition.text !== undefined, 'fixture text definition missing')
  const scale = 0.25 / definition.text.size
  const origin = definition.profile.start
  const scalePoint = (point: { x: number; y: number }): { x: number; y: number } => ({
    x: origin.x + (point.x - origin.x) * scale,
    y: origin.y + (point.y - origin.y) * scale,
  })
  definition.text = { ...definition.text, size: 0.25 }
  definition.profile = {
    ...definition.profile,
    start: scalePoint(definition.profile.start),
    segments: definition.profile.segments.map((segment) => ({
      ...segment,
      to: scalePoint(segment.to),
    })),
  }
  return project
}

function regionStats(
  region: ReturnType<typeof resolvePocketRegions>['bands'][number]['regions'][number],
): RegionStats {
  const resolved = resolveMedialResolution(region)
  assert(resolved !== null, 'fixture region should have a valid automatic resolution')
  const graph = computeMedialAxis(region, { resolution: resolved.resolution })
  const leaves = graph.adjacency.filter((neighbors) => neighbors.length === 1).length
  const zeroClearanceLeaves = graph.nodes.filter((node, index) =>
    node.clearance < 1e-9 && graph.adjacency[index].length === 1).length
  return {
    resolution: resolved.resolution,
    cornerCount: regionConvexCorners(region).length,
    nonCornerLeaves: leaves - zeroClearanceLeaves,
    chainCount: extractChains(graph).length,
  }
}

function testSavedGlyphProjectRejectsNoiseAcrossLinkedScales(): void {
  console.log('Testing saved linked gA project rejects medial noise across scales...')
  const project = loadNoiseRegressionProject()
  const operations = project.operations.filter((operation) => operation.kind === 'v_carve_medial')
  assert(operations.length === 2, `expected 2 medial operations, got ${operations.length}`)

  const stats = operations.map((operation) => {
    const regions = resolvePocketRegions(project, operation).bands.flatMap((band) => band.regions)
    assert(regions.length === 2, `${operation.name} should resolve the g and A regions separately`)
    return regions.map(regionStats)
  })

  const expectedResolutions = [
    [0.00241, 0.00248],
    [0.004403125, 0.004828125],
  ]
  const expectedTopology = [
    { cornerCount: 1, nonCornerLeaves: 2, chainCount: 9 },
    { cornerCount: 10, nonCornerLeaves: 0, chainCount: 20 },
  ]

  for (const [operationIndex, operationStats] of stats.entries()) {
    for (const [regionIndex, actual] of operationStats.entries()) {
      assert(
        approx(actual.resolution, expectedResolutions[operationIndex][regionIndex]),
        `operation ${operationIndex} region ${regionIndex} resolution was ${actual.resolution}`,
      )
      assert(actual.resolution <= 0.005, 'fixture glyph resolution must stay in the proven clean range')
      const expected = expectedTopology[regionIndex]
      assert(actual.cornerCount === expected.cornerCount, `unexpected corner count for region ${regionIndex}`)
      assert(
        actual.nonCornerLeaves === expected.nonCornerLeaves,
        `unexpected non-corner leaves for region ${regionIndex}`,
      )
      assert(actual.chainCount === expected.chainCount, `unexpected chain count for region ${regionIndex}`)
    }
  }

  console.log('saved linked gA noise regression PASSED')
}

function testFreshQuarterInchGlyphRejectsGridCornerNoise(): void {
  console.log('Testing freshly generated 0.25-inch gA rejects fixed-grid corner noise...')
  const project = quarterInchNoiseRegressionProject()
  const operation = project.operations.find((candidate) => candidate.id === 'op0005')
  assert(operation !== undefined, 'fixture small-glyph operation missing')
  const regions = resolvePocketRegions(project, operation).bands.flatMap((band) => band.regions)
  assert(regions.length === 2, `quarter-inch operation should resolve g and A, got ${regions.length}`)
  const stats = regions.map(regionStats)

  assert(approx(stats[0].resolution, 0.001506875), `quarter-inch g resolution was ${stats[0].resolution}`)
  assert(approx(stats[1].resolution, 0.00155), `quarter-inch A resolution was ${stats[1].resolution}`)
  assert(stats[0].cornerCount === 1, `quarter-inch g retained ${stats[0].cornerCount} corner tips`)
  assert(stats[1].cornerCount === 10, `quarter-inch A retained ${stats[1].cornerCount} corner tips`)
  assert(stats[0].nonCornerLeaves <= 2, `quarter-inch g retained ${stats[0].nonCornerLeaves} non-corner leaves`)
  assert(stats[1].nonCornerLeaves <= 2, `quarter-inch A retained ${stats[1].nonCornerLeaves} non-corner leaves`)
  assert(stats[0].chainCount <= 15, `quarter-inch g retained ${stats[0].chainCount} chains`)
  assert(stats[1].chainCount <= 24, `quarter-inch A retained ${stats[1].chainCount} chains`)

  console.log('fresh quarter-inch gA noise regression PASSED')
}

try {
  testSavedGlyphProjectRejectsNoiseAcrossLinkedScales()
  testFreshQuarterInchGlyphRejectsGridCornerNoise()
  console.log('noiseRegression.test.ts: all tests PASSED')
} catch (error) {
  console.error(error)
  throw error
}
