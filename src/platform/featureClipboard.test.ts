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

import {
  buildPlacedClipboardFeatures,
  copySelectedFeatures,
  cutSelectedFeatures,
  featureClipboardAnchor,
  isEditableShortcutTarget,
  pasteClipboardFeatures,
  selectedVisibleClipboardFeatures,
} from './featureClipboard'
import {
  newProject,
  rectProfile,
  type Project,
  type SketchFeature,
} from '../types/project'
import { useProjectStore } from '../store/projectStore'
import { emptySelection } from '../store/slices/selectionSlice'
import { projectWithFeatures as buildProjectWithFeatures, resolvedFeature } from '../test/projectFixtures'
import { resolveFeatureInstance, resolvedProjectFeatures } from '../store/helpers/resolveFeatures'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertNear(actual: number, expected: number, message: string): void {
  assert(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`)
}

function rectFeature(id: string, name: string, x: number, y: number, visible = true): SketchFeature {
  return {
    id,
    name,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(x, y, 2, 2),
      origin: { x, y },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: 5,
    z_bottom: 0,
    visible,
    locked: false,
  }
}

function projectWithFeatures(features: SketchFeature[]): Project {
  return buildProjectWithFeatures({
    ...newProject(),
    featureTree: features.map((feature) => ({ type: 'feature', featureId: feature.id })),
  }, features)
}

function resetStore(project: Project): void {
  useProjectStore.setState({
    project,
    selection: emptySelection(),
    history: { past: [], future: [], transactionStart: null },
    dirty: false,
  })
}

function testCopyUsesSelectedVisibleFeaturesOnly(): void {
  const visible = rectFeature('f1', 'Visible', 0, 0)
  const hidden = rectFeature('f2', 'Hidden', 5, 0, false)
  const project = projectWithFeatures([visible, hidden])

  const copied = selectedVisibleClipboardFeatures(project, ['f1', 'f2'])

  assert(copied.length === 1, 'only one visible feature should be copied')
  assert(copied[0].id === 'f1', 'visible selected feature should be copied')
  assert(copied[0] !== visible, 'clipboard should hold a serialized feature copy')
}

function testCopyDoesNotDirtyProject(): void {
  const feature = rectFeature('f1', 'Feature', 0, 0)
  resetStore(projectWithFeatures([feature]))
  useProjectStore.getState().selectFeatures(['f1'])
  useProjectStore.setState({ dirty: false, history: { past: [], future: [], transactionStart: null } })

  const copied = copySelectedFeatures(useProjectStore.getState())

  assert(copied?.length === 1, 'copy should return selected feature')
  assert(useProjectStore.getState().dirty === false, 'copy should not dirty the project')
  assert(useProjectStore.getState().history.past.length === 0, 'copy should not add history')
}

function testCutCopiesThenDeletes(): void {
  const feature = rectFeature('f1', 'Feature', 0, 0)
  resetStore(projectWithFeatures([feature]))
  useProjectStore.getState().selectFeatures(['f1'])
  useProjectStore.setState({ dirty: false, history: { past: [], future: [], transactionStart: null } })

  const cut = cutSelectedFeatures(useProjectStore.getState())

  assert(cut?.length === 1, 'cut should copy selected feature')
  assert(cut[0].id === 'f1', 'cut clipboard should preserve original feature data')
  assert(useProjectStore.getState().project.features.length === 0, 'cut should delete original feature')
  assert(useProjectStore.getState().dirty === true, 'cut should dirty the project')
  assert(useProjectStore.getState().history.past.length === 1, 'cut should add one history entry')
}

function testCutThenPasteRestoresCanonicalDefinition(): void {
  const feature = rectFeature('f1', 'Feature', 0, 0)
  resetStore(projectWithFeatures([feature]))
  useProjectStore.getState().selectFeatures(['f1'])

  const clipboard = cutSelectedFeatures(useProjectStore.getState())
  assert(clipboard !== null, 'cut should produce a clipboard payload')
  assert(Object.keys(useProjectStore.getState().project.featureDefinitions).length === 0,
    'cutting the last instance should collect its project definition')

  const pastedIds = pasteClipboardFeatures(useProjectStore.getState(), clipboard, { x: 10, y: 10 })
  assert(pastedIds.length === 1, 'cut feature should paste after its project definition was collected')
  const pasted = resolveFeatureInstance(useProjectStore.getState().project, pastedIds[0])
  assert(pasted !== null, 'pasted cut feature should resolve through the restored definition')
  assertNear(pasted.sketch.profile.start.x, 9, 'restored pasted feature should retain geometry')
}

function testPastePlacesGroupCenterAndSelectsPastedFeatures(): void {
  const first = rectFeature('f1', 'First', 0, 0)
  const second = rectFeature('f2', 'Second', 5, 5)
  resetStore(projectWithFeatures([first, second]))
  useProjectStore.getState().selectFeatures(['f1', 'f2'])
  const clipboard = copySelectedFeatures(useProjectStore.getState())
  assert(clipboard !== null, 'copy should produce clipboard payload')
  useProjectStore.setState({ dirty: false, history: { past: [], future: [], transactionStart: null } })

  const pastedIds = pasteClipboardFeatures(useProjectStore.getState(), clipboard, { x: 20, y: 30 })
  const state = useProjectStore.getState()
  const pasted = resolvedProjectFeatures(state.project).filter((feature) => pastedIds.includes(feature.id))
  const pastedAnchor = featureClipboardAnchor(pasted)

  assert(pastedIds.length === 2, 'paste should create one feature per clipboard feature')
  assert(new Set(pastedIds).size === 2, 'pasted feature ids should be unique')
  assert(pasted.every((feature) => !['f1', 'f2'].includes(feature.id)), 'paste should not reuse source ids')
  assert(state.selection.selectedFeatureIds.length === 2, 'paste should select pasted features')
  assert(state.selection.selectedFeatureIds.every((id) => pastedIds.includes(id)), 'selection should contain pasted ids')
  assert(state.dirty === true, 'paste should dirty the project')
  assert(state.history.past.length === 1, 'multi-feature paste should add one history entry')
  assert(pastedAnchor !== null, 'pasted features should have an anchor')
  assertNear(pastedAnchor.x, 20, 'paste should place group center at clicked X')
  assertNear(pastedAnchor.y, 30, 'paste should place group center at clicked Y')
}

function testIndependentPasteClonesDefinitions(): void {
  const feature = rectFeature('f1', 'Feature', 0, 0)
  const project = {
    ...projectWithFeatures([feature]),
    meta: { ...newProject().meta, copyMode: 'independent' as const },
  }

  const source = resolvedFeature(project, feature.id)
  const pasted = buildPlacedClipboardFeatures([source], project, { x: 20, y: 20 })

  assert(pasted.length === 1, 'independent paste should create a feature')
  const sourceDefinitionId = source.definitionId
  const pastedDefinitionId = pasted[0].definitionId
  assert(pastedDefinitionId !== sourceDefinitionId, 'independent paste should assign a cloned definition id')
}

function testEditableShortcutTargetGuard(): void {
  const originalHTMLElement = globalThis.HTMLElement

  class MockElement {
    public readonly isContentEditable: boolean
    private readonly closestMatch: MockElement | null

    constructor(isContentEditable: boolean, closestMatch: MockElement | null) {
      this.isContentEditable = isContentEditable
      this.closestMatch = closestMatch
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- must match HTMLElement.closest signature
    closest(_selector: string): MockElement | null {
      return this.closestMatch
    }
  }

  Object.defineProperty(globalThis, 'HTMLElement', {
    configurable: true,
    value: MockElement,
  })

  try {
    const plain = new MockElement(false, null) as unknown as EventTarget
    const inputLike = new MockElement(false, new MockElement(false, null)) as unknown as EventTarget
    const editable = new MockElement(true, null) as unknown as EventTarget

    assert(!isEditableShortcutTarget(plain), 'plain elements should not block clipboard shortcuts')
    assert(isEditableShortcutTarget(inputLike), 'input-like targets should block clipboard shortcuts')
    assert(isEditableShortcutTarget(editable), 'contenteditable targets should block clipboard shortcuts')
  } finally {
    Object.defineProperty(globalThis, 'HTMLElement', {
      configurable: true,
      value: originalHTMLElement,
    })
  }
}

testCopyUsesSelectedVisibleFeaturesOnly()
testCopyDoesNotDirtyProject()
testCutCopiesThenDeletes()
testCutThenPasteRestoresCanonicalDefinition()
testPastePlacesGroupCenterAndSelectsPastedFeatures()
testIndependentPasteClonesDefinitions()
testEditableShortcutTargetGuard()

console.log('featureClipboard tests passed')
