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
 * The toolpath cache's operation-to-operation dependency (issue #749).
 *
 * #739 made `discoverNonTargetSubtracts` read every *other* operation's target
 * list and enabled flag: a non-target subtract folds into the resolved region
 * only when nothing else machines it. The cache never modelled that read —
 * `diffToolpathInputs` diffs features and never looks at `project.operations`,
 * and `cacheInputsValid` compared only the operation's own row — so adding an
 * operation that claimed a folded subtract left every other operation serving
 * a stale path. The maintainer hit exactly that: an enclosed feature given its
 * own operation did not mark the enclosing pocket for recalculation.
 *
 * Every variant here is an **immutable update of `operations` alone** on one
 * shared base project, exactly as the store does it. That matters: build the
 * variants with separate `newProject` calls and `stock`/`tools`/`tabs`/`clamps`
 * get fresh identities, every case invalidates for the wrong reason, and the
 * suite passes while testing nothing.
 */

import { defaultTool, newProject, rectProfile } from '../../types/project'
import type { Operation, Project, SketchFeature } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { captureCacheInputs, cacheInputsValid } from './cacheInputs'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail: string): void {
  if (condition) { passed += 1; console.log(`   ✓ ${name}`); return }
  failed += 1
  console.log(`   ✗ ${name}: ${detail}`)
}

function feature(
  id: string,
  operation: SketchFeature['operation'],
  x: number,
  y: number,
  w: number,
  h: number,
  zBottom: number,
  zTop = 20,
): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(x, y, w, h),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation,
    z_top: zTop,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

function makeOperation(
  id: string,
  kind: Operation['kind'],
  featureIds: string[],
): Operation {
  return {
    id,
    name: id,
    kind,
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds },
    toolRef: 't1',
    stepdown: 2,
    stepover: 0.5,
    feed: 100,
    plungeFeed: 50,
    rpm: 10000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: false,
    finishFloor: false,
    carveDepth: 0,
    maxCarveDepth: 0,
  }
}

// mm explicitly: the inch default's 4 x 3 x 0.75 stock would clip this away.
// `far` sits outside the pocket's footprint so the spatial narrowing has
// something to narrow — without it, "unrelated" and "related" are the same
// test and the narrowing could be deleted with every case still green.
const FEATURES = [
  feature('body', 'add', 10, 10, 80, 60, 0),
  feature('pocket', 'subtract', 20, 20, 40, 40, 14),
  feature('island', 'add', 30, 30, 20, 20, 0),
  feature('eater', 'subtract', 30, 30, 10, 20, 14),
  feature('far', 'subtract', 70, 15, 15, 10, 14),
]

const tool = { ...defaultTool('mm', 1), id: 't1', diameter: 3 }
const BASE: Project = {
  ...projectWithFeatures(
    newProject('cache-op-dependency', 'mm'),
    FEATURES.map((row) => ({ ...row, definitionId: row.id })),
  ),
  tools: [tool],
  operations: [],
}

/** A variant of BASE differing in `operations` alone — every other identity shared. */
function withOperations(operations: Operation[]): Project {
  return { ...BASE, operations }
}

const pocketOp = makeOperation('op1', 'pocket', ['pocket'])
const eaterOwner = makeOperation('op2', 'pocket', ['eater'])
const farOwner = makeOperation('op3', 'pocket', ['far'])
const vcarveOp = makeOperation('op1', 'v_carve', ['pocket'])

console.log('\nToolpath cache: another operation claiming a folded subtract')

// ── 1. Adding an owner invalidates ──────────────────────────────────
{
  const before = withOperations([pocketOp])
  const inputs = captureCacheInputs(before, pocketOp)
  check(
    'adding an operation that targets a folded subtract invalidates',
    !cacheInputsValid(inputs, pocketOp, withOperations([pocketOp, eaterOwner])),
    'the enclosing pocket kept a path resolved when the subtract was still unowned',
  )
}

// ── 2. Removing an owner invalidates ────────────────────────────────
{
  const before = withOperations([pocketOp, eaterOwner])
  const inputs = captureCacheInputs(before, pocketOp)
  check(
    'removing that operation invalidates',
    !cacheInputsValid(inputs, pocketOp, withOperations([pocketOp])),
    'the subtract folds again once nothing machines it, so the path must regenerate',
  )
}

// ── 3. Enabling and disabling an owner invalidates ──────────────────
{
  const disabled = { ...eaterOwner, enabled: false }
  const withDisabled = withOperations([pocketOp, disabled])
  check(
    'enabling that operation invalidates',
    !cacheInputsValid(
      captureCacheInputs(withDisabled, pocketOp),
      pocketOp,
      withOperations([pocketOp, eaterOwner]),
    ),
    'a disabled operation cuts nothing, so its target folds; enabling it stops the fold',
  )
  check(
    'disabling that operation invalidates',
    !cacheInputsValid(
      captureCacheInputs(withOperations([pocketOp, eaterOwner]), pocketOp),
      pocketOp,
      withDisabled,
    ),
    'disabling the owner returns the subtract to the fold',
  )
}

// ── 4. Retargeting a third operation onto and off it invalidates ────
{
  const onFar = withOperations([pocketOp, farOwner])
  const onEater = withOperations([pocketOp, { ...farOwner, target: { source: 'features', featureIds: ['eater'] } }])
  check(
    'retargeting another operation onto the folded subtract invalidates',
    !cacheInputsValid(captureCacheInputs(onFar, pocketOp), pocketOp, onEater),
    'the subtract gained an owner without any feature changing',
  )
  check(
    'retargeting it away again invalidates',
    !cacheInputsValid(captureCacheInputs(onEater, pocketOp), pocketOp, onFar),
    'the subtract lost its owner without any feature changing',
  )
}

// ── 5. Narrowing: an owner change outside the footprint does not ────
{
  const before = withOperations([pocketOp])
  const inputs = captureCacheInputs(before, pocketOp)
  check(
    'claiming a subtract outside the footprint does NOT invalidate',
    cacheInputsValid(inputs, pocketOp, withOperations([pocketOp, farOwner])),
    '`far` cannot reach this pocket, so the spatial narrowing must dismiss it',
  )
}

// ── 6. Kind gate: an operation that never folds is unaffected ───────
{
  const before = withOperations([vcarveOp])
  const inputs = captureCacheInputs(before, vcarveOp)
  check(
    'a v_carve is not invalidated by an ownership change',
    cacheInputsValid(inputs, vcarveOp, withOperations([vcarveOp, eaterOwner])),
    'v_carve never folds non-target subtracts, so ownership is not one of its inputs',
  )
}

// ── 7. Control: an untouched project stays valid ────────────────────
{
  const before = withOperations([pocketOp, eaterOwner])
  const inputs = captureCacheInputs(before, pocketOp)
  check(
    'control - an identical project stays valid',
    cacheInputsValid(inputs, pocketOp, withOperations([pocketOp, eaterOwner])),
    'nothing changed, so the entry must survive or the cache is worthless',
  )
}

// ── 8. Chained subtracts reach past the target's own bbox (#751 §3) ─
{
  // Transitive discovery means the operation reads geometry the target bbox does
  // not cover. Measured before the footprint was widened: moving a subtract four
  // hops out changed the resolved region from 1800 to 1600 while the cache still
  // reported valid — a stale path served. The footprint now grows through
  // bbox-touching subtracts, which is a superset of real contact.
  const chainBase = withOperations([pocketOp])
  const chainFeatures = [
    feature('body', 'add', 0, 0, 100, 80, 0),
    feature('pocket', 'subtract', 20, 20, 20, 40, 14),
    ...[40, 50, 60, 70, 80].map((x, index) => feature(`c${index}`, 'subtract', x, 30, 10, 20, 14)),
  ]
  const chained = projectWithFeatures(
    newProject('chain', 'mm'),
    chainFeatures.map((row) => ({ ...row, definitionId: row.id })),
  )
  const chainProject: Project = { ...chainBase, ...chained, tools: [tool], operations: [pocketOp] }
  const chainInputs = captureCacheInputs(chainProject, pocketOp)

  const swap = (rows: SketchFeature[]): Project => {
    const next = projectWithFeatures(
      newProject('chain', 'mm'),
      rows.map((row) => ({ ...row, definitionId: row.id })),
    )
    return { ...chainProject, features: next.features, featureDefinitions: next.featureDefinitions }
  }

  const movedFar = swap(chainFeatures.map((row) => (
    row.id === 'c4' ? feature('c4', 'subtract', 80, 10, 10, 20, 14) : row
  )))
  check(
    'moving a subtract four hops along the chain invalidates',
    !cacheInputsValid(chainInputs, pocketOp, movedFar),
    'the chained subtract is outside the target bbox and was dismissed — a stale path',
  )

  const extended = swap([...chainFeatures, feature('c5', 'subtract', 90, 30, 8, 20, 14)])
  check(
    'adding a subtract that extends the chain invalidates',
    !cacheInputsValid(chainInputs, pocketOp, extended),
    'a new link joins the chain and grows the region, so the entry cannot stand',
  )

  const unconnected = swap([...chainFeatures, feature('stray', 'subtract', 5, 70, 6, 6, 14)])
  check(
    'a subtract touching nothing still does NOT invalidate',
    cacheInputsValid(chainInputs, pocketOp, unconnected),
    'the #518 narrowing has been lost — every distant edit now regenerates',
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
