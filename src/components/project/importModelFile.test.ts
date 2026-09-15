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
 * A model import lands whole or not at all, and STEP bodies become model
 * features (issue #784).
 *
 * Tessellation is injected — the real worker needs a browser — so the STEP
 * bodies are built here; `src/import/stepTessellation.test.ts` covers what Open
 * CASCADE produces. Everything after tessellation is the real pipeline:
 * scaling, orientation, silhouette projection, feature creation, the `.camj`
 * decoder and the CAM target check.
 *
 * Run with: npx tsx src/components/project/importModelFile.test.ts
 */

import { computeMeshBounds, type ImportedTriangleMesh } from '../../engine/importedMesh'
import { StepImportError } from '../../import/stepProtocol'
import type { StepBody, TessellateStepFileOptions } from '../../import/stepImportClient'
import { decodeProjectFormat } from '../../store/helpers/projectFormat'
import { useProjectStore } from '../../store/projectStore'
import type { ProjectStore, SelectionState } from '../../store/types'
import { newProject, type PersistedImportedMesh, type Project } from '../../types/project'
import { getOperationAddHint } from '../cam/operationValidity'
import { importModelFile, type ImportModelFileParams } from './importModelFile'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (err: unknown) {
    failed += 1
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`   ✗ ${name}: ${msg}`)
  }
}

type Vec3 = [number, number, number]

/** A closed 8-vertex box, wound outward. */
function boxMesh(min: Vec3, max: Vec3): ImportedTriangleMesh {
  const positions = new Float32Array([
    min[0], min[1], min[2], max[0], min[1], min[2], max[0], max[1], min[2], min[0], max[1], min[2],
    min[0], min[1], max[2], max[0], min[1], max[2], max[0], max[1], max[2], min[0], max[1], max[2],
  ])
  const index = new Uint32Array([
    0, 2, 1, 0, 3, 2,
    4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4,
    2, 3, 7, 2, 7, 6,
    1, 2, 6, 1, 6, 5,
    3, 0, 4, 3, 4, 7,
  ])
  return { positions, index, bounds: computeMeshBounds(positions) }
}

function stepBody(name: string, min: Vec3, max: Vec3): StepBody {
  return { name, mesh: boxMesh(min, max) }
}

function asciiStl(boxes: ReadonlyArray<[Vec3, Vec3]>): ArrayBuffer {
  const facets: string[] = []
  for (const [min, max] of boxes) {
    const mesh = boxMesh(min, max)
    const vertex = (i: number): string =>
      `vertex ${mesh.positions[i * 3]} ${mesh.positions[i * 3 + 1]} ${mesh.positions[i * 3 + 2]}`
    for (let t = 0; t < mesh.index.length; t += 3) {
      facets.push([
        'facet normal 0 0 0',
        'outer loop',
        vertex(mesh.index[t]),
        vertex(mesh.index[t + 1]),
        vertex(mesh.index[t + 2]),
        'endloop',
        'endfacet',
      ].join('\n'))
    }
  }
  return new TextEncoder().encode(`solid parts\n${facets.join('\n')}\nendsolid parts\n`).buffer
}

function resetStore(): Project {
  useProjectStore.setState({
    project: newProject(),
    selection: { selectedFeatureIds: [], selectedTabIds: [], selectedClampIds: [] },
    pendingShapeAction: null,
    history: { past: [], future: [], transactionStart: null },
  } as unknown as Partial<ProjectStore>)
  return useProjectStore.getState().project
}

function project(): Project {
  return useProjectStore.getState().project
}

function featureOf(featureId: string) {
  const instance = project().features.find((feature) => feature.id === featureId)
  assert(instance, `feature ${featureId} exists`)
  const definition = project().featureDefinitions[instance.definitionId]
  assert(definition, `definition of ${featureId} exists`)
  return { instance, definition }
}

function assetOf(featureId: string, source: Project = project()): PersistedImportedMesh {
  const instance = source.features.find((feature) => feature.id === featureId)
  assert(instance, `feature ${featureId} exists`)
  const assetId = source.featureDefinitions[instance.definitionId]?.stl?.meshAssetId
  assert(assetId, 'the model is stored as a mesh asset')
  const asset = source.modelAssets?.[assetId]
  assert(asset, `asset ${assetId} exists`)
  return asset
}

function stepParams(bodies: StepBody[], overrides: Partial<ImportModelFileParams> = {}): ImportModelFileParams {
  return {
    modelFormat: 'step',
    modelBuffer: new ArrayBuffer(16),
    fileName: 'bracket.step',
    projectUnits: 'mm',
    sourceUnits: 'mm',
    axisSwap: 'none',
    silhouetteZSteps: '16',
    step: { outputUnit: 'mm', tolerance: '0.01' },
    onProgress: () => {},
    tessellateStep: async () => bodies,
    notify: () => {},
    ...overrides,
  }
}

function stlParams(overrides: Partial<ImportModelFileParams> = {}): ImportModelFileParams {
  return {
    modelFormat: 'stl',
    modelBuffer: asciiStl([[[0, 0, 0], [10, 10, 10]], [[20, 0, 0], [30, 10, 10]]]),
    fileName: 'parts.stl',
    projectUnits: 'mm',
    sourceUnits: 'mm',
    axisSwap: 'none',
    silhouetteZSteps: '16',
    onProgress: () => {},
    ...overrides,
  }
}

/** Throws from the progress callback the first time the import reaches `label`. */
function failAt(label: string): (stage: string) => void {
  return (stage) => {
    if (stage.includes(label)) throw new Error(`injected failure at ${label}`)
  }
}

async function expectRejection(
  promise: Promise<unknown>,
  matches: (error: unknown) => boolean,
  description: string,
): Promise<void> {
  try {
    await promise
  } catch (error: unknown) {
    assert(matches(error), `${description}: got ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  throw new Error(`${description}: the import resolved`)
}

function names(ids: readonly string[]): string {
  return JSON.stringify(ids.map((id) => featureOf(id).instance.name))
}

console.log('importModelFile')

await test('a multi-body STEP file becomes a folder of named model features carrying its format', async () => {
  resetStore()
  const ids = await importModelFile(stepParams([
    stepBody('Plate', [0, 0, 0], [40, 20, 5]),
    stepBody('Bolt', [50, 0, 0], [56, 6, 20]),
    stepBody('Bolt', [60, 0, 0], [66, 6, 20]),
  ]))
  assert(ids.length === 3, `features: ${ids.length}`)
  assert(names(ids) === JSON.stringify(['Plate', 'Bolt', 'Bolt (2)']), names(ids))

  const folderIds = new Set(ids.map((id) => featureOf(id).instance.folderId))
  assert(folderIds.size === 1 && !folderIds.has(null), 'every body shares one folder')
  const folder = project().featureFolders.find((candidate) => folderIds.has(candidate.id))
  assert(folder?.name === 'bracket', `folder: ${folder?.name}`)

  for (const id of ids) {
    const { definition } = featureOf(id)
    assert(definition.kind === 'stl' && definition.operation === 'model', `${definition.kind} / ${definition.operation}`)
    assert(definition.stl?.format === 'step', `format: ${definition.stl?.format}`)
    assert(assetOf(id).sourceFormat === 'step', `asset source: ${assetOf(id).sourceFormat}`)
  }
  const plate = featureOf(ids[0]).instance
  assert(plate.z_bottom === 0 && plate.z_top === 5, `plate Z band: ${plate.z_bottom}..${plate.z_top}`)
})

await test('unnamed STEP bodies take the numbered file name', async () => {
  resetStore()
  const ids = await importModelFile(stepParams([
    stepBody('', [0, 0, 0], [10, 10, 10]),
    stepBody('', [20, 0, 0], [30, 10, 10]),
  ]))
  assert(names(ids) === JSON.stringify(['bracket', 'bracket (2)']), names(ids))
})

await test('STEP bodies that touch stay separate features, where connectivity would merge them', async () => {
  resetStore()
  const ids = await importModelFile(stepParams([
    stepBody('Left', [0, 0, 0], [10, 10, 10]),
    stepBody('Right', [10, 0, 0], [20, 10, 10]),
  ]))
  assert(names(ids) === JSON.stringify(['Left', 'Right']), names(ids))
})

await test('a single STEP body keeps the file name and gets no folder', async () => {
  const before = resetStore()
  const ids = await importModelFile(stepParams([stepBody('Part', [0, 0, 0], [10, 10, 10])]))
  assert(names(ids) === JSON.stringify(['bracket']), names(ids))
  assert(featureOf(ids[0]).instance.folderId === null, 'no folder for one body')
  assert(project().featureFolders.length === before.featureFolders.length, 'no folder was added')
})

await test('an inch STEP file lands at its physical size, with the tolerance handed over in inches', async () => {
  resetStore()
  const calls: TessellateStepFileOptions[] = []
  const [id] = await importModelFile(stepParams([], {
    sourceUnits: 'inch',
    step: { outputUnit: 'inch', tolerance: '0.01' },
    tessellateStep: async (_buffer, options) => {
      calls.push(options)
      return [stepBody('Part', [0, 0, 0], [2, 1, 0.5])]
    },
  }))
  assert(calls.length === 1 && calls[0].outputUnit === 'inch', JSON.stringify(calls))
  // 0.01 mm of chord error, expressed in the inch numbers OCCT emits.
  assert(Math.abs(calls[0].linearDeflection - 0.01 / 25.4) < 1e-12, `linearDeflection: ${calls[0].linearDeflection}`)
  const { bounds } = assetOf(id)
  assert(Math.abs(bounds.maxX - 50.8) < 1e-4 && Math.abs(bounds.maxZ - 12.7) < 1e-4, JSON.stringify(bounds))
})

await test('axis orientation applies to STEP bodies', async () => {
  resetStore()
  const [id] = await importModelFile(stepParams([stepBody('Part', [0, 0, 0], [10, 20, 5])], { axisSwap: 'yz' }))
  const { bounds } = assetOf(id)
  assert(bounds.maxY === 5 && bounds.maxZ === 20, JSON.stringify(bounds))
})

await test('a failure on a later STEP body leaves the project exactly as it was', async () => {
  const before = resetStore()
  await expectRejection(
    importModelFile(stepParams(
      [stepBody('A', [0, 0, 0], [10, 10, 10]), stepBody('B', [20, 0, 0], [30, 10, 10])],
      { onProgress: failAt('Body 2 / 2') },
    )),
    (error) => error instanceof Error && error.message.includes('injected failure'),
    'the injected failure surfaces',
  )
  assert(project() === before, 'the project changed, so part of the import was committed')
})

await test('a cancel before the commit leaves the project exactly as it was', async () => {
  const before = resetStore()
  const controller = new AbortController()
  await expectRejection(
    importModelFile(stepParams(
      [stepBody('A', [0, 0, 0], [10, 10, 10]), stepBody('B', [20, 0, 0], [30, 10, 10])],
      {
        signal: controller.signal,
        onProgress: (stage) => {
          if (stage.includes('Body 2 / 2')) controller.abort()
        },
      },
    )),
    (error) => error instanceof Error && error.name === 'AbortError',
    'the import reports the cancel',
  )
  assert(project() === before, 'the project changed after the cancel')
})

await test('an invalid surface tolerance is refused before tessellation starts', async () => {
  const before = resetStore()
  let tessellations = 0
  await expectRejection(
    importModelFile(stepParams([], {
      step: { outputUnit: 'mm', tolerance: '0' },
      tessellateStep: async () => {
        tessellations += 1
        return []
      },
    })),
    (error) => error instanceof StepImportError && error.code === 'invalid-tolerance',
    'the tolerance is refused',
  )
  assert(tessellations === 0, `tessellations: ${tessellations}`)
  assert(project() === before, 'the project changed')
})

await test('more STEP bodies than the cap import as one feature, with a warning', async () => {
  resetStore()
  const bodies = Array.from({ length: 65 }, (_, i) => stepBody(`Pin ${i}`, [i * 3, 0, 0], [i * 3 + 1, 1, 1]))
  const warnings: string[] = []
  const ids = await importModelFile(stepParams(bodies, { notify: (message) => warnings.push(message) }))
  assert(ids.length === 1, `features: ${ids.length}`)
  assert(assetOf(ids[0]).triangleCount === 65 * 12, `triangles: ${assetOf(ids[0]).triangleCount}`)
  assert(warnings.length === 1 && warnings[0].includes('65'), JSON.stringify(warnings))
})

await test('a STEP model survives a save and reload, and stays a 3D rough and finish target', async () => {
  resetStore()
  const [id] = await importModelFile(stepParams([stepBody('Part', [0, 0, 0], [30, 20, 10])]))
  const saved = project()
  const reopened = decodeProjectFormat(JSON.parse(JSON.stringify(saved))).project

  const instance = reopened.features.find((feature) => feature.id === id)
  assert(instance, 'the feature reopens')
  assert(reopened.featureDefinitions[instance.definitionId]?.stl?.format === 'step', 'the format reopens')
  const reopenedAsset = assetOf(id, reopened)
  assert(reopenedAsset.sourceFormat === 'step', `asset source: ${reopenedAsset.sourceFormat}`)
  assert(reopenedAsset.positions === assetOf(id, saved).positions, 'the mesh bytes reopen unchanged')

  const selection = { selectedFeatureIds: [id] } as unknown as SelectionState
  for (const kind of ['rough_surface', 'finish_surface'] as const) {
    const hint = getOperationAddHint(reopened, selection, kind)
    assert(hint === null, `${kind} refused the model: ${hint}`)
  }
})

await test('STL imports still find bodies by connectivity and number them', async () => {
  resetStore()
  const ids = await importModelFile(stlParams())
  assert(names(ids) === JSON.stringify(['parts', 'parts (2)']), names(ids))
  assert(ids.every((id) => featureOf(id).definition.stl?.format === 'stl'), 'the STL format is kept')
})

await test('a failure on a later STL body also leaves the project untouched', async () => {
  const before = resetStore()
  await expectRejection(
    importModelFile(stlParams({ onProgress: failAt('Body 2 / 2') })),
    (error) => error instanceof Error && error.message.includes('injected failure'),
    'the injected failure surfaces',
  )
  assert(project() === before, 'the project changed, so part of the import was committed')
})

console.log(`\n${passed} passed, ${failed} failed${failed > 0 ? ' ❌' : ' ✓'}\n`)

if (failed > 0) throw new Error(`${failed} test(s) failed`)
