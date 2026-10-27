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
 * Kept work that can no longer be cut (issue #1112 slice K, decision 5).
 *
 * Changing the round bar to a square blank keeps the Around sheet drawing and
 * the operation that cuts it. Both must say why they are left out, in the
 * user's terms, instead of silently generating nothing. Mutations checked one
 * at a time:
 * - returning a warning for a round bar → the "nothing is flagged while it
 *   cuts" assertion fails;
 * - dropping the square-blank feature rule → the feature reason is null and
 *   the tree row would lose its warning (the required mutation);
 * - dropping the operation mapping → the operation reason is null and the
 *   panel would show nothing;
 * - warning about a deliberately disabled operation → its null assertion
 *   fails.
 *
 * Run with: npx tsx src/components/cam/uncutWork.test.ts
 */

import {
  featureUncutWarning,
  featureUncutWork,
  operationUncutWarning,
  operationUncutWork,
  uncutWorkText,
} from './uncutWork'
import { camT } from './camI18n'
import { rotaryMultiModelFixture, rotaryOperationFixture } from '../../test/rotaryOperationFixture'
import { resolvedProjectFeatures } from '../../store/helpers/resolveFeatures'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { squareStock } from '../../types/barStock'
import type { Operation, Project } from '../../types/project'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function featureNamed(project: Project, id: string): ReturnType<typeof resolvedProjectFeatures>[number] {
  const feature = resolvedProjectFeatures(project).find((candidate) => candidate.id === id)
  if (!feature) throw new Error(`fixture is missing feature ${id}`)
  return feature
}

function pocketOn(project: Project, featureId: string, setupId: string): Operation {
  return {
    ...defaultOperationForTarget(project, 'pocket', 'rough', { source: 'features', featureIds: [featureId] }, 0),
    setupId,
  }
}

function square(project: Project): Project {
  return { ...project, stock: squareStock(12, 30, 'x') }
}

const ROUND = rotaryOperationFixture('x', 'rotary_rough')
const SQUARE = square(ROUND)
const AROUND_SETUP = ROUND.setups.find((setup) => setup.kind === 'around')!.id
const TOP_SETUP = ROUND.setups[0].id

// ── A feature on a round bar is cuttable and not flagged ───────────────

const sheet = featureNamed(ROUND, 'sketch')
const model = featureNamed(ROUND, 'model')
assert(featureUncutWork(ROUND, sheet) === null, 'Around sheet work on a round bar is cuttable')
assert(featureUncutWork(ROUND, model) === null, 'a model on a round bar is cuttable')

const pocket = pocketOn(ROUND, 'sketch', AROUND_SETUP)
assert(operationUncutWork(ROUND, pocket) === null, 'a pocket on Around sheet work is cuttable on a round bar')
assert(featureUncutWarning(ROUND, sheet) === null, 'nothing is flagged while the work still cuts')

// ── A square blank keeps it but cannot cut it ──────────────────────────

assert(
  featureUncutWork(SQUARE, sheet)?.reason === 'aroundNeedsRoundBar',
  'Around sheet work says a round bar is needed on a square blank',
)
assert(
  featureUncutWarning(SQUARE, sheet) === camT('cam.uncut.aroundNeedsRoundBar'),
  'the feature warning is the translated round-bar sentence',
)
assert(featureUncutWork(SQUARE, model) === null, 'a model can still be turned on a square blank')

assert(
  operationUncutWork(SQUARE, pocket)?.reason === 'operationNeedsRoundBar',
  'the pocket kept on a square blank says it cannot be cut',
)
assert(
  operationUncutWarning(SQUARE, pocket) === camT('cam.uncut.operationNeedsRoundBar'),
  'the operation warning is the translated square-blank sentence',
)

// ── The other rules the warning reuses ────────────────────────────────

// A project type that does not machine Around keeps the features but cuts none.
const milling = { ...ROUND, meta: { ...ROUND.meta, projectType: 'milling' as const } }
assert(
  featureUncutWork(milling, sheet)?.reason === 'aroundNeedsRotaryProject',
  'Around work in a non-rotary project is kept but not machined',
)

// A bar is what an Around face exists on; a block cannot cut it.
const block = { ...ROUND, stock: { ...ROUND.stock, shape: 'block' as const } }
assert(
  featureUncutWork(block, sheet)?.reason === 'aroundNeedsBar',
  'Around work on a block says it needs a bar',
)

// An operation whose targets the setup cannot reach says so, using the
// engine's own verdict rather than a second rule.
const topPocket = pocketOn(ROUND, 'sketch', TOP_SETUP)
assert(
  operationUncutWork(ROUND, topPocket)?.reason === 'operationTargetsOtherFace',
  'a Top operation targeting Around sheet work says the face cannot reach it',
)

// An operation switched off on purpose is not "left over".
assert(
  operationUncutWork(SQUARE, { ...pocket, enabled: false }) === null,
  'a disabled operation is not warned about',
)

// The rotary itself is admitted on a square blank by the engine's rule, so it
// is not reported as leftover sheet work.
const rotaryFinish = ROUND.operations.find((operation) => operation.kind === 'rotary_rough')!
assert(operationUncutWork(ROUND, rotaryFinish) === null, 'the rotary operation still cuts the model')

// A region is a filter, not sheet work; it never gets a warning.
const withRegion = rotaryMultiModelFixture('x', 'rotary_rough')
const region = featureNamed(withRegion, 'region')
assert(featureUncutWork(square(withRegion), region) === null, 'a closed region mask is not leftover work')

// Wording is the catalogue's, not a hard-coded English sentence.
assert(
  uncutWorkText({ reason: 'operationReachesCentreline', features: 'Slot' })
    === camT('cam.uncut.operationReachesCentreline', { feature: 'Slot' }),
  'the centreline warning names the feature through the catalogue',
)

console.log('uncut work tests passed')
