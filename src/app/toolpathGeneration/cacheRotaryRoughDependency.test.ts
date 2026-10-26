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
 * The toolpath cache's rotary finish → preceding rough dependency (#1045 slice
 * V).
 *
 * `rotaryFinishWithoutRough` reads every enabled rotary rough before a finish
 * in the same setup and the STL models it targets. The cache never modelled
 * that read: `operationComputationEquals` deliberately excludes `enabled`, and
 * `diffToolpathInputs` never looks at `project.operations`, so disabling or
 * moving a rough left the finish serving a stale advisory. Every variant here
 * is an immutable update of `operations` alone on one shared base project, so
 * `stock`/`tools`/`tabs`/`clamps` keep the identities the cache compares.
 */

import { rotaryMultiModelFixture } from '../../test/rotaryOperationFixture'
import type { Operation, Project } from '../../types/project'
import { captureCacheInputs, cacheInputsValid } from './cacheInputs'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail: string): void {
  if (condition) { passed += 1; console.log(`   ✓ ${name}`); return }
  failed += 1
  console.log(`   ✗ ${name}: ${detail}`)
}

const BASE = rotaryMultiModelFixture('x', 'rotary_finish')
const finish: Operation = {
  ...BASE.operations[0],
  target: { source: 'features', featureIds: ['model', 'second'] },
}
const rough = (id: string, featureIds: string[], patch: Partial<Operation> = {}): Operation => ({
  ...finish,
  id,
  name: id,
  kind: 'rotary_rough',
  pass: 'rough',
  target: { source: 'features', featureIds },
  ...patch,
})
const roughA = rough('rough-a', ['model'])
const roughB = rough('rough-b', ['second'])
const roughAB = rough('rough-ab', ['model', 'second'])
const roughBA = rough('rough-ba', ['second', 'model'])
const disabledA = { ...roughA, enabled: false }
const topSetup = BASE.setups[0].id

/** A variant of BASE differing in `operations` alone. */
function withOperations(operations: Operation[]): Project {
  return { ...BASE, operations }
}

console.log('\nToolpath cache: a rotary finish depends on the roughs before it')

// ── 1. Adding and removing a preceding rough ─────────────────────────
{
  check(
    'adding a preceding rough invalidates',
    !cacheInputsValid(
      captureCacheInputs(withOperations([finish]), finish),
      finish,
      withOperations([roughA, finish]),
    ),
    'the finish kept a warning produced when it was the only operation in the setup',
  )
  check(
    'removing that rough invalidates',
    !cacheInputsValid(
      captureCacheInputs(withOperations([roughA, finish]), finish),
      finish,
      withOperations([finish]),
    ),
    'the rough is gone, so the warning must come back',
  )
}

// ── 2. Enabling and disabling a preceding rough ──────────────────────
{
  check(
    'enabling a preceding rough invalidates',
    !cacheInputsValid(
      captureCacheInputs(withOperations([disabledA, finish]), finish),
      finish,
      withOperations([roughA, finish]),
    ),
    'a disabled rough does not count, so enabling it changes the advisory',
  )
  check(
    'disabling a preceding rough invalidates',
    !cacheInputsValid(
      captureCacheInputs(withOperations([roughA, finish]), finish),
      finish,
      withOperations([disabledA, finish]),
    ),
    'disabling it returns the finish to the no-rough warning',
  )
}

// ── 3. Reordering the rough relative to the finish ───────────────────
{
  check(
    'moving the rough after the finish invalidates',
    !cacheInputsValid(
      captureCacheInputs(withOperations([roughA, finish]), finish),
      finish,
      withOperations([finish, roughA]),
    ),
    'a rough after the finish does not count, so the advisory changes',
  )
  check(
    'reordering two preceding roughs invalidates',
    !cacheInputsValid(
      captureCacheInputs(withOperations([roughA, roughB, finish]), finish),
      finish,
      withOperations([roughB, roughA, finish]),
    ),
    'the dependency is ordered; comparing only how many roughs precede loses the retarget',
  )
}

// ── 4. Moving the rough to another setup ─────────────────────────────
{
  check(
    'moving the rough to another setup invalidates',
    !cacheInputsValid(
      captureCacheInputs(withOperations([roughA, finish]), finish),
      finish,
      withOperations([{ ...roughA, setupId: topSetup }, finish]),
    ),
    'a rough in another setup does not count for this finish',
  )
}

// ── 5. Region targets and unrelated operations ───────────────────────
{
  const withRegion = rough('rough-a', ['model', 'region'])
  // #1096: a rough's region decides whether it covers the finish's area, so
  // adding one to a rough that used to cut the whole bar changes the advisory.
  check(
    'adding a region target to the rough invalidates',
    !cacheInputsValid(
      captureCacheInputs(withOperations([roughA, finish]), finish),
      finish,
      withOperations([withRegion, finish]),
    ),
    'a rough with a region no longer covers a whole-bar finish',
  )
  check(
    'removing the rough region invalidates',
    !cacheInputsValid(
      captureCacheInputs(withOperations([withRegion, finish]), finish),
      finish,
      withOperations([roughA, finish]),
    ),
    'a whole-bar rough covers the finish, so the warning must go away',
  )
  // A second region feature, so "same region" and "another region" differ.
  const regionFeature = BASE.features.find((feature) => feature.id === 'region')!
  const withTwoRegions: Project = {
    ...BASE,
    features: [...BASE.features, { ...regionFeature, id: 'region-2', name: 'Region 2' }],
  }
  const operationsFor = (project: Project, operations: Operation[]): Project => ({ ...project, operations })
  check(
    'swapping one region for another invalidates',
    !cacheInputsValid(
      captureCacheInputs(operationsFor(withTwoRegions, [withRegion, finish]), finish),
      finish,
      operationsFor(withTwoRegions, [rough('rough-a', ['model', 'region-2']), finish]),
    ),
    'the advisory compares the rough region ids, so a different region is a different input',
  )
  check(
    'reordering a rough\'s region targets does NOT invalidate',
    cacheInputsValid(
      captureCacheInputs(operationsFor(withTwoRegions, [rough('rough-a', ['model', 'region-2', 'region']), finish]), finish),
      finish,
      operationsFor(withTwoRegions, [rough('rough-a', ['model', 'region', 'region-2']), finish]),
    ),
    'region ids are compared as a sorted set',
  )
  const pocket: Operation = {
    ...finish,
    id: 'pocket',
    name: 'pocket',
    kind: 'pocket',
    pass: 'rough',
    target: { source: 'features', featureIds: ['model'] },
  }
  check(
    'editing an unrelated operation does NOT invalidate',
    cacheInputsValid(
      captureCacheInputs(withOperations([roughA, finish]), finish),
      finish,
      withOperations([pocket, roughA, finish]),
    ),
    'a non-rotary operation cannot change the preceding-rough advisory',
  )
  check(
    'reordering the rough\'s own model targets does NOT invalidate',
    cacheInputsValid(
      captureCacheInputs(withOperations([roughAB, finish]), finish),
      finish,
      withOperations([roughBA, finish]),
    ),
    'the advisory reads which models a rough covers, not the order inside its target',
  )
}

// ── 6. A non-finish operation keeps its cache behaviour ──────────────
{
  check(
    'a rotary rough is not invalidated by another rough',
    cacheInputsValid(
      captureCacheInputs(withOperations([roughA, finish]), roughA),
      roughA,
      withOperations([roughA, roughB, finish]),
    ),
    'only a finish reads the preceding-rough dependency, so other kinds must not regenerate for it',
  )
}

// ── 7. Control: an untouched project stays valid ─────────────────────
{
  check(
    'control - an identical project stays valid',
    cacheInputsValid(
      captureCacheInputs(withOperations([roughA, finish]), finish),
      finish,
      withOperations([roughA, finish]),
    ),
    'nothing changed, so the entry must survive or the cache is worthless',
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
