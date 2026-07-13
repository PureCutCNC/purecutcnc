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
 * Tests for text feature expansion.
 *
 * Run with: npx tsx src/store/textExpansion.test.ts
 *
 * Scenarios:
 * - Skeleton text expansion produces open line features grouped per letter
 * - Outline text expansion produces closed contour features per letter
 * - Expanded features inherit operation, z_top, z_bottom, visibility, and lock state
 * - Letter groups are created with grouped=true flag
 * - Features are mapped to correct letter group folders
 */

import { expandTextFeature } from './helpers/textExpansion'
import type { SketchFeature, Project } from '../types/project'
import { instantiateProjectTemplate } from './helpers/normalize'
import { resolvedProjectFeatures } from './helpers/resolveFeatures'

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\n  Expected: ${JSON.stringify(expected)}\n  Actual: ${JSON.stringify(actual)}`)
  }
}

function assertTrue(value: boolean, message: string) {
  if (!value) {
    throw new Error(message)
  }
}

function assertFalse(value: boolean, message: string) {
  if (value) {
    throw new Error(message)
  }
}

function assertGreaterThan(actual: number, threshold: number, message: string) {
  if (actual <= threshold) {
    throw new Error(`${message}: ${actual} should be > ${threshold}`)
  }
}

function assertGreaterThanOrEqual(actual: number, threshold: number, message: string) {
  if (actual < threshold) {
    throw new Error(`${message}: ${actual} should be >= ${threshold}`)
  }
}

function createTextFeature(text: string, style: 'skeleton' | 'outline'): SketchFeature {
  return {
    id: 'text-1',
    name: 'Test Text',
    kind: 'text',
    text: {
      text,
      style,
      fontId: style === 'skeleton' ? 'simple_stroke' : 'helvetiker_regular',
      size: 10,
    },
    folderId: null,
    sketch: {
      profile: {
        start: { x: 0, y: 0 },
        segments: [
          { type: 'line', to: { x: 100, y: 0 } },
          { type: 'line', to: { x: 100, y: 100 } },
          { type: 'line', to: { x: 0, y: 100 } },
          { type: 'line', to: { x: 0, y: 0 } },
        ],
        closed: true,
      },
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function createProject(): Project {
  return instantiateProjectTemplate()
}

function resolvedExpansion(
  project: Project,
  result: ReturnType<typeof expandTextFeature>,
) {
  return resolvedProjectFeatures({
    ...project,
    features: result.features,
    featureDefinitions: {
      ...project.featureDefinitions,
      ...result.definitions,
    },
  })
}

function runTests() {
  let passCount = 0
  let failCount = 0

  function test(name: string, fn: () => void) {
    try {
      fn()
      console.log(`✓ ${name}`)
      passCount += 1
    } catch (e) {
      console.error(`✗ ${name}`)
      console.error(`  ${(e as Error).message}`)
      failCount += 1
    }
  }

  test('should expand skeleton text into open line features', () => {
    const project = createProject()
    const textFeature = createTextFeature('AB', 'skeleton')

    const result = expandTextFeature(project, textFeature)

    assertGreaterThan(result.folders.length, 0, 'folders')
    assertGreaterThan(result.features.length, 0, 'features')

    // Check that folders have grouped flag set
    for (const folder of result.folders) {
      assertTrue(folder.grouped === true, 'folder should be grouped')
      assertTrue(!!folder.id && folder.id.length > 0, 'folder should have id')
      assertTrue(!!folder.name && /^[A-Z]$/.test(folder.name), 'folder name should be a single letter')
    }

    // Check that features inherit properties from source
    for (const feature of resolvedExpansion(project, result)) {
      assertEqual(feature.operation, 'subtract', 'operation should be subtract')
      assertEqual(feature.z_top, 5, 'z_top should be 5')
      assertEqual(feature.z_bottom, 0, 'z_bottom should be 0')
      assertTrue(feature.visible === true, 'should be visible')
      assertTrue(feature.locked === false, 'should not be locked')
      assertTrue(!!feature.folderId && feature.folderId.length > 0, 'should have folderId')
      // Skeleton fonts should have open profiles (line features)
      assertEqual(feature.sketch.profile.closed, false, 'skeleton font features should have open profiles')
      assertTrue(feature.text === null, 'text should be null')
    }
  })

  test('should expand outline text into closed contour features', () => {
    const project = createProject()
    const textFeature = createTextFeature('A', 'outline')

    const result = expandTextFeature(project, textFeature)

    assertGreaterThan(result.folders.length, 0, 'folders')
    assertGreaterThan(result.features.length, 0, 'features')

    // All expanded features should have closed profiles
    for (const feature of resolvedExpansion(project, result)) {
      assertTrue(feature.sketch.profile.closed === true, 'profile should be closed')
    }
  })

  test('should group shapes by letter index', () => {
    const project = createProject()
    const textFeature = createTextFeature('AAA', 'skeleton')

    const result = expandTextFeature(project, textFeature)

    // Each A in "AAA" gets its own index (1, 2, 3) so should have 3 folders
    assertEqual(result.folders.length, 3, 'should have 3 folders for AAA')

    // Each folder should have features (strokes) for that letter
    assertGreaterThan(result.features.length, 0, 'features')
  })

  test('should preserve feature visibility state', () => {
    const project = createProject()
    const textFeature = createTextFeature('TEST', 'skeleton')
    textFeature.visible = false

    const result = expandTextFeature(project, textFeature)

    for (const feature of resolvedExpansion(project, result)) {
      assertEqual(feature.visible, false, 'visible should be false')
    }
  })

  test('should preserve feature lock state', () => {
    const project = createProject()
    const textFeature = createTextFeature('TEST', 'skeleton')
    textFeature.locked = true

    const result = expandTextFeature(project, textFeature)

    for (const feature of resolvedExpansion(project, result)) {
      assertEqual(feature.locked, true, 'locked should be true')
    }
  })

  test('should map features to correct letter group folders', () => {
    const project = createProject()
    const textFeature = createTextFeature('AB', 'skeleton')

    const result = expandTextFeature(project, textFeature)

    assertGreaterThanOrEqual(result.folders.length, 2, 'should have at least 2 folders')

    // All features should have a folderId that exists in folders
    const folderIds = new Set(result.folders.map((f) => f.id))
    for (const feature of resolvedExpansion(project, result)) {
      assertTrue(feature.folderId !== null && folderIds.has(feature.folderId), 'feature should map to valid folder')
    }
  })

  test('should create definition refs for exploded features', () => {
    const project = createProject()
    const textFeature = createTextFeature('A', 'skeleton')

    const result = expandTextFeature(project, textFeature)

    for (const feature of resolvedExpansion(project, result)) {
      const withRefs = feature as SketchFeature & {
        definitionId?: string
        transform?: { a: number; b: number; c: number; d: number; e: number; f: number }
      }
      assertTrue(!!withRefs.definitionId && withRefs.definitionId.length > 0, 'should have definitionId')
      assertTrue(
        !!withRefs.transform && withRefs.transform.a === 1 && withRefs.transform.e === 0,
        'transform should be identity',
      )
    }
  })

  test('should preserve z range from source text feature', () => {
    const project = createProject()
    const textFeature = createTextFeature('TEST', 'skeleton')
    textFeature.z_top = 10
    textFeature.z_bottom = 2

    const result = expandTextFeature(project, textFeature)

    for (const feature of result.features) {
      assertEqual(feature.z_top, 10, 'z_top should be 10')
      assertEqual(feature.z_bottom, 2, 'z_bottom should be 2')
    }
  })

  test('should handle text feature with no text data gracefully', () => {
    const project = createProject()
    const textFeature = createTextFeature('TEST', 'skeleton')
    textFeature.text = null

    const result = expandTextFeature(project, textFeature)

    assertEqual(result.folders.length, 0, 'folders should be empty')
    assertEqual(result.features.length, 0, 'features should be empty')
  })

  test('should generate unique IDs for folders and features', () => {
    const project = createProject()
    const textFeature = createTextFeature('ABC', 'skeleton')

    const result = expandTextFeature(project, textFeature)

    const allIds = new Set<string>()
    for (const folder of result.folders) {
      assertFalse(allIds.has(folder.id), `duplicate id: ${folder.id}`)
      allIds.add(folder.id)
    }
    for (const feature of result.features) {
      assertFalse(allIds.has(feature.id), `duplicate id: ${feature.id}`)
      allIds.add(feature.id)
      const withRefs = feature
      if (withRefs.definitionId) {
        assertFalse(allIds.has(withRefs.definitionId), `duplicate id: ${withRefs.definitionId}`)
        allIds.add(withRefs.definitionId)
      }
    }
  })

  test('should name letter groups with text content and letter index', () => {
    const project = createProject()
    const textFeature = createTextFeature('AB', 'skeleton')

    const result = expandTextFeature(project, textFeature)

    for (const folder of result.folders) {
      assertTrue(/^[A-Z]$/.test(folder.name), `folder name should be a single letter, got: ${folder.name}`)
    }
  })

  test('should handle add and subtract operations correctly', () => {
    const project = createProject()

    // Test with add operation
    let textFeature = createTextFeature('A', 'skeleton')
    textFeature.operation = 'add'
    let result = expandTextFeature(project, textFeature)
    for (const feature of resolvedExpansion(project, result)) {
      assertEqual(feature.operation, 'add', 'operation should be add')
    }

    // Test with subtract operation
    textFeature = createTextFeature('A', 'skeleton')
    textFeature.operation = 'subtract'
    result = expandTextFeature(project, textFeature)
    for (const feature of resolvedExpansion(project, result)) {
      assertEqual(feature.operation, 'subtract', 'operation should be subtract')
    }
  })

  console.log(`\n${passCount} passed, ${failCount} failed`)
  if (failCount > 0) {
    process.exit(1)
  }
}

runTests()
