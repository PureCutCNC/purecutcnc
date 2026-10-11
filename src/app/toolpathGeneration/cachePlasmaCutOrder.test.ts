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
 * The toolpath cache and plasma cut order (issue #958).
 *
 * The cut order made a plasma path depend on two things the cache had no
 * reason to watch before: the machine origin (the first cut is the one
 * nearest it; no generator read the origin until now) and the plasma
 * operations that run after this one (they decide the outline-before-hole
 * warning). Neither changes a feature, so without its own check a moved origin
 * or a reordered operation list would keep serving the old path and the old
 * warning.
 *
 * As in `cacheOperationDependency.test.ts`, every variant is an immutable
 * update of one shared base project, so nothing invalidates for a reason
 * other than the one under test. Each case is checked against the generator
 * too: the cache must refuse exactly when the generated result differs.
 *
 * Run with: npx tsx src/app/toolpathGeneration/cachePlasmaCutOrder.test.ts
 */

import assert from 'node:assert/strict'
import { defaultTool, newProject, rectProfile } from '../../types/project'
import type { Operation, Project, SketchFeature } from '../../types/project'
import { defaultPlasmaTool } from '../../toolPolicy'
import { projectWithFeatures } from '../../test/projectFixtures'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { generatePlasmaProfileToolpath } from '../../engine/toolpaths'
import { captureCacheInputs, cacheInputsValid } from './cacheInputs'

function feature(id: string, operation: SketchFeature['operation'], x: number, y: number, w: number, h: number): SketchFeature {
  return {
    id, name: id, kind: 'rect', operation, folderId: null, visible: true, locked: false, z_top: 6, z_bottom: 0,
    sketch: { profile: rectProfile(x, y, w, h), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
  }
}

const seed = newProject('cache-plasma-order', 'mm')
seed.stock.thickness = 6
seed.origin = { ...seed.origin, x: 0, y: 0 }
seed.tools = [{ ...defaultPlasmaTool('mm'), id: 'torch', name: 'Torch', diameter: 2, cutHeight: 1.5, defaultFeed: 2200 }, { ...defaultTool('mm'), id: 'mill' }]
const BASE: Project = projectWithFeatures(seed, [
  feature('left', 'add', 20, 20, 60, 60),
  feature('left-hole', 'subtract', 35, 35, 30, 30),
  feature('right', 'add', 120, 20, 60, 60),
])

function plasma(id: string, featureIds: string[]): Operation {
  return { ...defaultOperationForTarget(BASE, 'plasma_profile', 'rough', { source: 'features', featureIds }, 0), id, name: id, toolRef: 'torch' }
}
const outlines = plasma('outlines', ['left', 'right'])
const holes = plasma('holes', ['left-hole'])
const pocket: Operation = { ...defaultOperationForTarget(BASE, 'pocket', 'rough', { source: 'features', featureIds: ['left-hole'] }, 0), id: 'pocket', name: 'pocket', toolRef: 'mill' }

/** A variant of BASE differing only in what is spread over it. */
const variant = (patch: Partial<Project>): Project => ({ ...BASE, ...patch })

/**
 * The cache may keep `operation`'s path across `before -> after` exactly when
 * generating it on both gives the same result.
 */
function expectCache(name: string, operation: Operation, before: Project, after: Project, expected: 'kept' | 'refused'): void {
  const same = JSON.stringify(generatePlasmaProfileToolpath(before, operation)) === JSON.stringify(generatePlasmaProfileToolpath(after, operation))
  assert.equal(same, expected === 'kept', `${name}: the fixture ${expected === 'kept' ? 'must not' : 'must'} change the generated result`)
  const valid = cacheInputsValid(captureCacheInputs(before, operation), operation, after)
  assert.equal(valid, expected === 'kept', `${name}: cache entry should be ${expected}`)
}

const alone = variant({ operations: [outlines] })

// The machine origin: the first cut is chosen from it.
expectCache('moving the origin across the sheet', outlines, alone, variant({ operations: [outlines], origin: { ...BASE.origin, x: 200 } }), 'refused')
// Z zero is not where the torch starts in XY; the path is in project coordinates either way.
{
  const lifted = variant({ operations: [outlines], origin: { ...BASE.origin, z: BASE.origin.z + 5 } })
  assert.ok(cacheInputsValid(captureCacheInputs(alone, outlines), outlines, lifted), 'moving Z zero alone keeps the entry')
  assert.ok(cacheInputsValid(captureCacheInputs(alone, outlines), outlines, variant({ operations: [outlines], origin: { ...BASE.origin, name: 'renamed', visible: !BASE.origin.visible } })), 'renaming or hiding the origin keeps the entry')
}
// A milling operation never read the origin and still does not.
assert.ok(
  cacheInputsValid(captureCacheInputs(variant({ operations: [pocket] }), pocket), pocket, variant({ operations: [pocket], origin: { ...BASE.origin, x: 200 } })),
  'a moved origin does not invalidate a milling operation',
)

// A later plasma operation cutting inside one of this operation's outlines.
expectCache('adding a later operation that cuts the hole', outlines, alone, variant({ operations: [outlines, holes] }), 'refused')
expectCache('removing it', outlines, variant({ operations: [outlines, holes] }), alone, 'refused')
expectCache('moving it ahead of the outlines', outlines, variant({ operations: [outlines, holes] }), variant({ operations: [holes, outlines] }), 'refused')
expectCache('disabling it', outlines, variant({ operations: [outlines, holes] }), variant({ operations: [outlines, { ...holes, enabled: false }] }), 'refused')
expectCache('retargeting it off the hole', outlines, variant({ operations: [outlines, holes] }), variant({ operations: [outlines, { ...holes, target: { source: 'features', featureIds: [] } }] }), 'refused')
expectCache('renaming it, since the warning names it', outlines, variant({ operations: [outlines, holes] }), variant({ operations: [outlines, { ...holes, name: 'Holes first' }] }), 'refused')

// What does not reach this operation leaves its entry alone.
expectCache('a change to an operation that runs before it', outlines, variant({ operations: [holes, outlines] }), variant({ operations: [{ ...holes, enabled: false }, outlines] }), 'kept')
expectCache('a later operation changing its own feed', outlines, variant({ operations: [outlines, holes] }), variant({ operations: [outlines, { ...holes, feed: holes.feed + 100 }] }), 'kept')
expectCache('a later milling operation', outlines, alone, variant({ operations: [outlines, pocket] }), 'kept')
expectCache('an identical project', outlines, variant({ operations: [outlines, holes] }), variant({ operations: [outlines, holes] }), 'kept')
// The later operation has nothing after it, so the earlier one is not its input.
expectCache('the later operation, when the earlier one changes', holes, variant({ operations: [outlines, holes] }), variant({ operations: [{ ...outlines, enabled: false }, holes] }), 'kept')

console.log('toolpath cache: plasma cut order follows the machine origin and later plasma operations')
