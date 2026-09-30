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
 * The waterline machining envelope is built only when something reads it
 * (issue #926).
 *
 * The envelope is the union of every ring of every level. On LP-carved-top that
 * union was about a third of the operation, and the only reader is the
 * protected-footprint check for a non-target add or model feature, which that
 * project does not have. These tests count the work rather than time it.
 *
 * Run with: npx tsx src/engine/toolpaths/finishSurfaceWaterlineEnvelope.test.ts
 */

import { generateFinishSurfaceToolpath } from './finishSurface'
import { buildProtectedFootprintPaths } from './modelProtection'
import type { ClipperPath } from './types'
import { rectProfile, type SketchFeature } from '../../types/project'
import { replaceProjectFeatures } from '../../test/projectFixtures'
import { hillsModelFeature, hillsWaterlineProject, type HillsProjectOptions } from '../../test/waterlineHillsFixture'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const FIXTURE: HillsProjectOptions = { spanX: 30, spanY: 24, cell: 1.5, plateauZ: 8, stepdown: 1 }

/** A block standing on the stock beside the hills: protected, not intersecting. */
function standaloneBlock(): SketchFeature {
  return {
    id: 'standalone-block',
    name: 'Block beside the model',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(31, 2, 3, 3),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: 4,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function envelopeDebugLine(withBlock: boolean): string {
  const { project, operation } = hillsWaterlineProject(FIXTURE)
  if (withBlock) replaceProjectFeatures(project, [hillsModelFeature(FIXTURE), standaloneBlock()])
  const result = generateFinishSurfaceToolpath(project, { ...operation, debugToolpath: true })
  assert(result.moves.length > 0, 'expected the waterline to cut')
  const line = result.warnings
    .map((warning) => (warning.code === 'debug' ? String(warning.params?.text ?? '') : ''))
    .find((text) => text.startsWith('Debug: waterline machining envelope'))
  assert(line !== undefined, 'expected the envelope debug line')
  return line!
}

function testEnvelopeIsNotBuiltWithoutAReader(): void {
  const line = envelopeDebugLine(false)
  assert(line.endsWith('not built'), `expected no envelope on a model-only project, got "${line}"`)
}

function testEnvelopeIsBuiltForAProtectedFeature(): void {
  const line = envelopeDebugLine(true)
  assert(line.endsWith(' built'), `expected the envelope for a non-target add feature, got "${line}"`)
}

function testProtectedFootprintsCallTheEnvelopeOnlyForACandidate(): void {
  const { project } = hillsWaterlineProject(FIXTURE)
  let calls = 0
  const envelope = (): ClipperPath[] => {
    calls += 1
    return []
  }
  const options = { targetFeatureIds: new Set(['hills-model']), z: 1, featureExpansion: 1, machiningEnvelopePaths: envelope }
  buildProtectedFootprintPaths(project, options)
  assert(calls === 0, `expected no envelope call without a protected feature, got ${calls}`)

  replaceProjectFeatures(project, [hillsModelFeature(FIXTURE), standaloneBlock()])
  const paths = buildProtectedFootprintPaths(project, options)
  assert(calls === 1, `expected one envelope call for one protected feature, got ${calls}`)
  assert(paths.length > 0, 'expected the block to be protected against an empty envelope')
}

testEnvelopeIsNotBuiltWithoutAReader()
testEnvelopeIsBuiltForAProtectedFeature()
testProtectedFootprintsCallTheEnvelopeOnlyForACandidate()

console.log('finishSurfaceWaterlineEnvelope tests passed')
