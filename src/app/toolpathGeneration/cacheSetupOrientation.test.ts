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
 * The toolpath cache and a setup's turn (issue #946).
 *
 * An operation row names its setup; the turn lives on the setup. Changing a
 * Bottom setup's flip axis keeps the setup id, so the operation row compares
 * equal — and a cache that looked no further would keep serving a path
 * generated for the other mirror. The same path, exported, cuts the part
 * mirrored across the wrong line.
 *
 * Every variant is an **immutable update of `setups` alone** on one shared
 * base project, as the store does it, so nothing else changes identity and a
 * case cannot invalidate for the wrong reason.
 *
 * Run with: npx tsx src/app/toolpathGeneration/cacheSetupOrientation.test.ts
 */

import { defaultTool, newProject, rectProfile } from '../../types/project'
import type { Operation, Project, SetupOrientation, SketchFeature } from '../../types/project'
import { computeOperationToolpath } from '../../engine/toolpaths/generateOperation'
import { syncProjectSetups } from '../../store/helpers/setups'
import { BOTTOM_SETUP_ID, projectWithFeatures, withBottomSetup } from '../../test/projectFixtures'
import { captureCacheInputs, cacheInputsValid } from './cacheInputs'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) { passed += 1; console.log(`   ✓ ${name}`); return }
  failed += 1
  console.log(`   ✗ ${name}${detail ? `: ${detail}` : ''}`)
}

function feature(id: string, face: 'top' | 'bottom', zTop: number, zBottom: number): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(12, 10, 30, 18),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: zTop,
    z_bottom: zBottom,
    authoringFace: face,
    visible: true,
    locked: false,
  }
}

function makeOperation(id: string, featureId: string): Operation {
  return {
    id,
    name: id,
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: [featureId] },
    toolRef: 't1',
    stepdown: 2,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 2,
    maxCarveDepth: 2,
  }
}

function makeProject(): Project {
  const base = newProject('cache-setup', 'mm')
  base.stock = { ...base.stock, profile: rectProfile(0, 0, 100, 80), thickness: 20 }
  base.tools = [{ ...defaultTool('mm', 1), id: 't1', diameter: 6, maxCutDepth: 25 }]
  const project = projectWithFeatures(base, [feature('upper', 'top', 20, 14), feature('lower', 'bottom', 6, 0)])
  return withBottomSetup(
    syncProjectSetups({ ...project, operations: [makeOperation('top', 'upper'), makeOperation('bottom', 'lower')] }),
    { axis: 'x', operationIds: ['bottom'] },
  )
}

/** The project with the Bottom setup changed and nothing else: same ids, same rows everywhere else. */
function withBottom(project: Project, patch: { orientation?: SetupOrientation; name?: string; notes?: string }): Project {
  return {
    ...project,
    setups: project.setups.map((setup) => (setup.id === BOTTOM_SETUP_ID ? { ...setup, ...patch } : setup)),
  }
}

console.log('\nToolpath cache — a setup turned another way under the same id')

const project = makeProject()
const topOp = project.operations.find((entry) => entry.id === 'top')!
const bottomOp = project.operations.find((entry) => entry.id === 'bottom')!
const topInputs = captureCacheInputs(project, topOp)
const bottomInputs = captureCacheInputs(project, bottomOp)

check('fixture: the Bottom operation is in the Bottom setup', bottomOp.setupId === BOTTOM_SETUP_ID)
check('an unchanged project is a hit for both', cacheInputsValid(topInputs, topOp, project) && cacheInputsValid(bottomInputs, bottomOp, project))

const aboutY = withBottom(project, { orientation: { axis: 'y', angleDeg: 180 } })
check('fixture: only the setups changed', aboutY.operations === project.operations && aboutY.features === project.features && aboutY.stock === project.stock)
check(
  'changing the flip axis invalidates the Bottom operation',
  !cacheInputsValid(bottomInputs, aboutY.operations.find((entry) => entry.id === 'bottom')!, aboutY),
  'a path generated for the X mirror was served for the Y mirror',
)
check(
  'and leaves the Top operation valid',
  cacheInputsValid(topInputs, aboutY.operations.find((entry) => entry.id === 'top')!, aboutY),
  'a Top operation regenerated for a turn it does not use',
)

// The reason it matters: the two turns export different programs from the same stock-space path.
const before = computeOperationToolpath(project, bottomOp)
const after = computeOperationToolpath(aboutY, bottomOp)
check(
  'fixture: the flip axis really changes the generated path',
  before !== null && after !== null && before.result.moves.length > 0
    && JSON.stringify(before.result.moves) !== JSON.stringify(after.result.moves),
)

const turnedTop = withBottom(project, { orientation: { axis: 'x', angleDeg: 0 } })
check('turning the setup to Top invalidates its operation', !cacheInputsValid(bottomInputs, bottomOp, turnedTop))

const sameTurn = withBottom(project, { orientation: { axis: 'x', angleDeg: 180 } })
check('an equal orientation object is still a hit', cacheInputsValid(bottomInputs, bottomOp, sameTurn), 'identity was compared instead of value')

const renamed = withBottom(project, { name: 'Underside', notes: 'Flip toward you.' })
check('renaming a setup or editing its notes is a hit', cacheInputsValid(bottomInputs, bottomOp, renamed), 'a header-only change regenerated a toolpath')

const removed: Project = { ...project, setups: project.setups.filter((setup) => setup.id !== BOTTOM_SETUP_ID) }
check('a setup that no longer exists invalidates its operation', !cacheInputsValid(bottomInputs, bottomOp, removed))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) throw new Error(`${failed} cache setup-orientation check(s) failed`)
