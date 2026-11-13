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
 * The default operation of a shape drawn on a bar (#395, #1054 slice 1, #1108):
 * the bar is already solid on every face of a rotary project, so the first
 * shape there is a cut into its surface — and shapes still nest inside it: a
 * shape inside a cut is an island, and a shape inside that island is a cut
 * again. A block project keeps the inferred base-solid role.
 *
 * Run with: npx tsx src/store/helpers/manualFeatureOperation.test.ts
 */

import assert from 'node:assert/strict'
import { defaultTool, newProject, polygonProfile, rectProfile, roundStock } from '../../types/project'
import type { MachiningSetup, Project, SetupFace, SketchFeature, SketchProfile, Stock } from '../../types/project'
import { squareStock } from '../../types/barStock'
import { projectWithFeatures } from '../../test/projectFixtures'
import { inferManualFeatureOperation } from './manualFeatureOperation'

function setupFor(face: SetupFace): MachiningSetup {
  return {
    ...(face === 'around' ? { kind: 'around' as const } : {}),
    id: `setup-${face}`,
    name: face,
    orientation: { axis: 'x', angleDeg: face === 'bottom' ? 180 : 0 },
    indexing: 'manual',
    registration: [],
    notes: '',
    operationIds: [],
  }
}

function faceFeature(
  id: string,
  operation: 'add' | 'subtract',
  face: SetupFace,
  profile: SketchProfile,
): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile,
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation,
    z_top: 40,
    z_bottom: 36,
    authoringFace: face,
    visible: true,
    locked: false,
  }
}

function barProject(
  face: SetupFace,
  stock: Stock,
  features: SketchFeature[] = [],
): Project {
  const base = newProject('manual-operation', 'mm')
  base.stock = stock
  base.meta = { ...base.meta, projectType: 'rotary' }
  base.tools = [{ ...defaultTool('mm', 1), id: 't1', diameter: 3, maxCutDepth: 40 }]
  const setup = setupFor(face)
  return projectWithFeatures({ ...base, setups: [setup], activeSetupId: setup.id }, features)
}

/** The same face on a block, so the base-solid rule still answers. */
function blockProject(face: SetupFace, features: SketchFeature[] = []): Project {
  const base = newProject('manual-operation-block', 'mm')
  base.tools = [{ ...defaultTool('mm', 1), id: 't1', diameter: 3, maxCutDepth: 40 }]
  const setup = setupFor(face)
  return projectWithFeatures({ ...base, setups: [setup], activeSetupId: setup.id }, features)
}

/** The new shape in every case: strictly inside `island`, which is inside `pocket`. */
const box = rectProfile(30, 45, 8, 8)
/** A subtract that really contains `box`. */
const pocket = rectProfile(20, 40, 20, 20)
/** An add strictly inside `pocket` that really contains `box`. */
const island = rectProfile(24, 42, 15, 15)
const line: SketchProfile = {
  start: { x: 0, y: 0 },
  segments: [{ type: 'line', to: { x: 10, y: 0 } }],
  closed: false,
}

// A self-intersecting outline (a bow tie) the classifier cannot nest.
const bowTie = polygonProfile([{ x: 30, y: 45 }, { x: 38, y: 53 }, { x: 38, y: 45 }, { x: 30, y: 53 }])

const barStocks: Array<[string, Stock]> = [
  ['round bar', roundStock(40, 200, 'x', { x: 10, y: 30 })],
  ['square blank', squareStock(40, 200, 'x', { x: 10, y: 30 })],
]

for (const [label, stock] of barStocks) {
  for (const face of ['top', 'bottom', 'around'] as const) {
    assert.equal(
      inferManualFeatureOperation(barProject(face, stock), box),
      'subtract',
      `a lone shape on a ${label} ${face} is a cut into the bar`,
    )
    assert.equal(
      inferManualFeatureOperation(
        barProject(face, stock, [faceFeature('pocket', 'subtract', face, pocket)]),
        box,
      ),
      'add',
      `a shape inside a ${label} ${face} cut is an island`,
    )
    assert.equal(
      inferManualFeatureOperation(barProject(face, stock, [
        faceFeature('pocket', 'subtract', face, pocket),
        faceFeature('island', 'add', face, island),
      ]), box),
      'subtract',
      `a shape inside a ${label} ${face} island is a cut again`,
    )
    assert.equal(
      inferManualFeatureOperation(barProject(face, stock), line),
      'subtract',
      `an open profile on a ${label} ${face} stays a cut`,
    )
    assert.equal(
      inferManualFeatureOperation(barProject(face, stock), bowTie),
      'subtract',
      `a self-intersecting shape on a ${label} ${face} stays a cut, never a base solid`,
    )
  }
}

// The two Around cases the old early return also answered, now nesting properly:
// over an Around add that contains the shape it stays a cut, and over an Around
// subtract that contains it the shape is now an island (#1108).
assert.equal(inferManualFeatureOperation(
  barProject('around', roundStock(40, 200, 'x', { x: 10, y: 30 }), [
    faceFeature('a1', 'add', 'around', pocket),
  ]),
  box,
), 'subtract',
'a shape inside an Around add is a cut')
assert.equal(inferManualFeatureOperation(
  barProject('around', roundStock(40, 200, 'x', { x: 10, y: 30 }), [
    faceFeature('a2', 'subtract', 'around', pocket),
  ]),
  box,
), 'add',
'and over an Around subtract')

// A block keeps the base-solid rule untouched.
assert.equal(inferManualFeatureOperation(blockProject('top'), box), 'add',
  'the first shape drawn on a block Top is still add')
assert.equal(inferManualFeatureOperation(blockProject('bottom'), box), 'add',
  'the first shape drawn on a block Bottom is still add')
assert.equal(inferManualFeatureOperation(
  blockProject('top', [faceFeature('base', 'add', 'top', pocket)]),
  box,
), 'subtract',
  'a shape inside a block base solid is still subtract')

console.log('manualFeatureOperation.test.ts passed')
