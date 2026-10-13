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
 * The default operation of a shape drawn on the Around face (issue #395): the
 * bar is already solid, so every shape there is a cut into its surface — never
 * a base solid, whatever the project holds. Top and Bottom are unchanged.
 *
 * Run with: npx tsx src/store/helpers/manualFeatureOperation.test.ts
 */

import assert from 'node:assert/strict'
import { defaultTool, newProject, rectProfile, roundStock } from '../../types/project'
import type { MachiningSetup, Project, SetupFace, SketchFeature } from '../../types/project'
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

function aroundFeature(id: string, operation: 'add' | 'subtract'): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(20, 40, 10, 10),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation,
    z_top: 40,
    z_bottom: 36,
    authoringFace: 'around',
    visible: true,
    locked: false,
  }
}

function barProject(face: SetupFace, features: SketchFeature[] = []): Project {
  const base = newProject('manual-operation', 'mm')
  base.stock = roundStock(40, 200, 'x', { x: 10, y: 30 })
  base.tools = [{ ...defaultTool('mm', 1), id: 't1', diameter: 3, maxCutDepth: 40 }]
  const setup = setupFor(face)
  return projectWithFeatures({ ...base, setups: [setup], activeSetupId: setup.id }, features)
}

const box = rectProfile(30, 45, 8, 8)

// Around: always a cut, even as the first shape and over an Around add.
assert.equal(inferManualFeatureOperation(barProject('around'), box), 'subtract',
  'the first shape drawn on Around defaults to subtract')
assert.equal(inferManualFeatureOperation(barProject('around', [aroundFeature('a1', 'add')]), box), 'subtract',
  'an Around shape stays subtract over an Around add')
assert.equal(inferManualFeatureOperation(barProject('around', [aroundFeature('a2', 'subtract')]), box), 'subtract',
  'and over an Around subtract')

// Top and Bottom keep the base-solid rule untouched.
assert.equal(inferManualFeatureOperation(barProject('top'), box), 'add',
  'the first shape drawn on Top is still add')
assert.equal(inferManualFeatureOperation(barProject('bottom'), box), 'add',
  'the first shape drawn on Bottom is still add')

console.log('manualFeatureOperation.test.ts passed')
