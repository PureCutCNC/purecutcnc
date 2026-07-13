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
 * Tests for text-feature feature-reference behavior (issue #228):
 *   1. Creating a text feature mints a FeatureDefinition + instance link.
 *   2. A reference copy of a text feature shares that definition and resolves
 *      (so it is hit-testable / selectable in the canvas).
 *   3. Editing `text` on one linked instance propagates to the definition and
 *      every sibling instance.
 *   4. Auto-generated text feature names are truncated to 16 chars.
 *
 * Run with: npx tsx src/store/textReference.test.ts
 */

import { defaultTextToolConfig } from '../text'
import { newProject, type Project } from '../types/project'
import { useProjectStore } from './projectStore'
import type { ProjectStore } from './types'
import { buildCopiedFeatures } from './helpers/copyFeatures'
import { createFeatureInstance, getDefinitionId, getInstanceIdsForDefinition } from './helpers/featureDefinitions'
import { resolveFeatureInstance, resolvedProjectFeatures } from './helpers/resolveFeatures'
import { textFolderBaseName } from './helpers/naming'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function resetStore(project?: Project): void {
  useProjectStore.setState({
    project: project ?? newProject(),
    selection: { selectedFeatureIds: [] },
    history: { past: [], future: [], transactionStart: null },
  } as unknown as Partial<ProjectStore>)
}

function getProject(): Project {
  return useProjectStore.getState().project
}

// ── 1. Creating a text feature mints a definition ──────────────────

{
  resetStore(newProject())
  const config = defaultTextToolConfig('mm')
  useProjectStore.getState().startAddTextPlacement(config)
  const ids = useProjectStore.getState().placePendingTextAt({ x: 10, y: 10 })
  assert(ids.length === 1, 'placePendingTextAt creates exactly one feature')

  const project = getProject()
  const feature = project.features.find((f) => f.id === ids[0])!
  const resolved = resolveFeatureInstance(project, feature.id)
  assert(resolved?.kind === 'text', 'created feature is a text feature')

  assert(typeof feature.definitionId === 'string', 'text feature has an explicit definitionId')
  const definition = project.featureDefinitions[feature.definitionId]
  assert(definition !== undefined, 'a FeatureDefinition was minted for the text feature')
  assert(definition.kind === 'text', 'minted definition is kind text')
  assert(definition.text?.text === config.text, 'definition carries the text data')

  // The original resolves (sanity).
  assert(resolveFeatureInstance(project, feature.id) !== null, 'original text feature resolves')
}

// ── 2. Reference copy shares the definition and resolves ───────────

{
  resetStore(newProject())
  useProjectStore.getState().startAddTextPlacement(defaultTextToolConfig('mm'))
  const [originalId] = useProjectStore.getState().placePendingTextAt({ x: 10, y: 10 })
  const project = getProject()
  const original = project.features.find((f) => f.id === originalId)!
  const resolvedOriginal = resolveFeatureInstance(project, originalId)
  assert(resolvedOriginal, 'original text feature resolves')
  const defId = getDefinitionId(original)

  const copies = buildCopiedFeatures(
    [resolvedOriginal],
    project.features,
    200, 0, 1,
    project.featureDefinitions,
    'reference',
  )
  assert(copies.length === 1, 'one reference copy built')
  const copyDraft = copies[0]
  const copy = createFeatureInstance(copyDraft, copyDraft.definitionId, copyDraft.transform)
  assert(getDefinitionId(copy) === defId, 'reference copy shares the source definition')

  const copiedProject: Project = {
    ...project,
    features: [...project.features, copy],
  }

  // The copy must resolve through the references resolver — this is the path
  // canvas hit-testing uses, so a null result means it cannot be selected.
  assert(
    resolveFeatureInstance(copiedProject, copy.id) !== null,
    'reference copy resolves via resolveFeatureInstance (hit-testable)',
  )
  const resolvedIds = resolvedProjectFeatures(copiedProject).map((f) => f.id)
  assert(resolvedIds.includes(copy.id), 'reference copy is present in resolvedProjectFeatures')

  // Both rows are reported as linked instances of the one definition.
  assert(
    getInstanceIdsForDefinition(copiedProject, defId).length === 2,
    'source + copy are linked instances of the shared definition',
  )
}

// ── 3. Editing text propagates to the definition + siblings ────────

{
  resetStore(newProject())
  useProjectStore.getState().startAddTextPlacement(defaultTextToolConfig('mm'))
  const [originalId] = useProjectStore.getState().placePendingTextAt({ x: 10, y: 10 })
  let project = getProject()
  const original = project.features.find((f) => f.id === originalId)!
  const resolvedOriginal = resolveFeatureInstance(project, originalId)
  assert(resolvedOriginal, 'original text feature resolves')
  const defId = getDefinitionId(original)

  // Insert a reference copy directly so both rows live in the store.
  const copyDraft = buildCopiedFeatures(
    [resolvedOriginal], project.features, 200, 0, 1, project.featureDefinitions, 'reference',
  )[0]
  const copy = createFeatureInstance(copyDraft, copyDraft.definitionId, copyDraft.transform)
  resetStore({ ...project, features: [...project.features, copy] })

  // Edit the COPY's text.
  const originalText = resolvedOriginal.text!
  useProjectStore.getState().updateFeature(copy.id, {
    text: { ...originalText, text: 'CHANGED' },
  })

  project = getProject()
  const updatedOriginal = resolveFeatureInstance(project, originalId)
  const updatedCopy = resolveFeatureInstance(project, copy.id)
  assert(updatedOriginal && updatedCopy, 'linked text features resolve after edit')
  assert(updatedCopy.text?.text === 'CHANGED', 'edited copy carries the new text')
  assert(updatedOriginal.text?.text === 'CHANGED', 'linked original updated to the new text')
  assert(
    project.featureDefinitions[defId].text?.text === 'CHANGED',
    'shared definition updated to the new text',
  )
}

// ── 4. Auto-name truncation at 16 chars ────────────────────────────

{
  assert(textFolderBaseName('SHORT') === 'SHORT', 'short text used verbatim')
  const long = 'THIS IS A VERY LONG TEXT STRING'
  const truncated = textFolderBaseName(long)
  assert(truncated === `${long.slice(0, 16)}…`, 'long text truncated to 16 chars + ellipsis')
  assert(truncated.length === 17, 'truncated name is 16 chars plus the ellipsis')
}

console.log('✓ All text reference tests passed.')
