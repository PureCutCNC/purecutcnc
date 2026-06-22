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
 * Tests for Slice 07 duplicate semantics: copyMode, Duplicate as Reference,
 * Duplicate Independent, Select Linked Instances, and the no-double-bake
 * invariant.
 *
 * Run with: npx tsx src/store/duplicateReference.test.ts
 */

import {
  IDENTITY_MATRIX,
  inferFeatureKind,
  newProject,
  rectProfile,
  type FeatureDefinition,
  type Matrix2D,
  type Point,
  type Project,
  type SketchFeature,
} from '../types/project'
import { useProjectStore } from './projectStore'
import { normalizeProject } from './projectStore'
import {
  buildCopiedFeatures,
  extractClonedDefinitions,
} from './helpers/copyFeatures'
import {
  getDefinitionId,
  getInstanceIdsForDefinition,
} from './helpers/featureDefinitions'
import { resolveFeatureInstance } from './helpers/resolveFeatures'
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// ── Helpers ────────────────────────────────────────────────────────

function resetStore(project?: Project): void {
  useProjectStore.setState({
    project: project ?? newProject(),
    selection: { selectedFeatureIds: [] },
    history: { past: [], future: [], transactionStart: null },
  } as any)
}

function getProject(): Project {
  return useProjectStore.getState().project
}

/** Make a minimal project with one rect definition + instance. */
function makeSingleRectProject(): { project: Project; rect: SketchFeature } {
  const base = newProject()
  const profile = rectProfile(0, 0, 100, 50)
  const definitionId = 'f-rect'
  const definition: FeatureDefinition = {
    id: definitionId,
    kind: inferFeatureKind(profile),
    profile,
    dimensions: [],
    text: null,
    stl: null,
    operation: 'add',
  }
  const feature: SketchFeature = {
    id: 'f0001',
    name: 'Rect',
    kind: 'rect',
    operation: 'add',
    visible: true,
    locked: false,
    z_top: 5,
    z_bottom: 0,
    folderId: null,
    sketch: {
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
      profile,
    },
    text: null,
    stl: null,
    definitionId,
    transform: IDENTITY_MATRIX,
  } as SketchFeature & { definitionId: string; transform: Matrix2D }

  const project: Project = {
    ...base,
    featureDefinitions: { [definitionId]: definition },
    features: [feature],
  }
  return { project, rect: feature }
}

// ── copyMode ───────────────────────────────────────────────────────

{
  // Default for legacy (no copyMode field)
  const base = newProject()
  const legacyProject = {
    ...base,
    meta: { ...base.meta },
  }
  delete (legacyProject.meta as any).copyMode
  const normalized = normalizeProject(legacyProject)
  assert(
    normalized.meta.copyMode === 'reference',
    'copyMode defaults to "reference" for legacy projects',
  )

  // Setter updates and survives normalize
  resetStore(normalized)
  useProjectStore.getState().setCopyMode('independent')
  const updated = getProject()
  assert(
    updated.meta.copyMode === 'independent',
    'setCopyMode updates copyMode to "independent"',
  )
  const renormalized = normalizeProject(updated)
  assert(
    renormalized.meta.copyMode === 'independent',
    'copyMode survives re-normalize',
  )

  // Set back to reference
  useProjectStore.getState().setCopyMode('reference')
  assert(
    getProject().meta.copyMode === 'reference',
    'setCopyMode updates copyMode back to "reference"',
  )
}

// ── Duplicate as Reference (buildCopiedFeatures, reference mode) ──

{
  const { project, rect } = makeSingleRectProject()
  const features = project.features
  const definitions = project.featureDefinitions

  // Build one reference copy with dx=200, dy=0
  const copies = buildCopiedFeatures(
    [rect],
    features,
    200,
    0,
    1,
    definitions,
    'reference',
  )

  assert(copies.length === 1, 'one reference copy created')
  const copy = copies[0] as SketchFeature & { definitionId?: string; transform?: Matrix2D }

  // Same definitionId
  const copyDefId = getDefinitionId(copy)
  assert(copyDefId === 'f-rect', 'reference copy shares same definitionId as source')

  // No new definition created
  const clonedDefs = extractClonedDefinitions(copies)
  assert(Object.keys(clonedDefs).length === 0, 'reference mode creates no cloned definitions')

  // Transform includes the offset
  const copyTransform = copy.transform ?? IDENTITY_MATRIX
  assert(copyTransform.e >= 190 && copyTransform.e <= 210,
    `copy transform includes dx offset, got e=${copyTransform.e}`)

  // Resolved geometry: does NOT double-bake
  // The source resolved geometry has rect at (0,0)-(100,50)
  const sourceResolved = resolveFeatureInstance(
    { ...project, features: [rect], featureDefinitions: definitions },
    rect.id,
  )
  assert(sourceResolved !== null, 'source resolves')
  const sourceVerts = sourceResolved!.sketch.profile.segments.map(
    (s: { to?: Point }) => s.to ?? sourceResolved!.sketch.profile.start,
  )

  // The copy resolved geometry should be the source resolved + offset
  const copyResolved = resolveFeatureInstance(
    { ...project, features: [copy as SketchFeature], featureDefinitions: definitions },
    copy.id,
  )
  assert(copyResolved !== null, 'copy resolves')
  const copyVerts = copyResolved!.sketch.profile.segments.map(
    (s: { to?: Point }) => s.to ?? copyResolved!.sketch.profile.start,
  )

  // Check the copy vertices are the source vertices shifted by (200, 0)
  for (let i = 0; i < sourceVerts.length; i++) {
    const sv = sourceVerts[i]
    const cv = copyVerts[i]
    if (sv) {
      assert(
        Math.abs(cv.x - (sv.x + 200)) < 0.01 && Math.abs(cv.y - sv.y) < 0.01,
        `copy vertex ${i} matches source vertex shifted by (200,0), got delta=(${(cv.x - sv.x - 200).toFixed(3)}, ${(cv.y - sv.y).toFixed(3)})`,
      )
    }
  }

  // Definition edit propagates to reference copy (via rebake)
  const fullProject: Project = {
    ...project,
    features: [...features, ...copies.map((c) => {
      const { _clonedDefinition, ...clean } = c as any
      return clean as SketchFeature
    })],
    featureDefinitions: { ...definitions, ...extractClonedDefinitions(copies) },
  }
  const instanceIds = getInstanceIdsForDefinition(fullProject, 'f-rect')
  assert(instanceIds.length === 2, 'definition has 2 instances')
  assert(instanceIds.includes('f0001'), 'source is an instance')
  assert(instanceIds.includes(copy.id), 'copy is an instance')
}

// ── Reference copy of legacy/migrated feature (no explicit definitionId on source) ──

{
  // Simulate a legacy-project feature after normalizeProject migration:
  // definitionId is UNSET on the feature row, but featureDefinitions[feature.id] exists.
  // getDefinitionId(source) falls back to source.id, so the copy MUST bake
  // that value as its own explicit definitionId to remain linked.
  const base = newProject()
  const profile = rectProfile(0, 0, 80, 40)
  const featureId = 'f-legacy'
  const definition: FeatureDefinition = {
    id: featureId,
    kind: 'rect',
    profile,
    dimensions: [],
    text: null,
    stl: null,
    operation: 'add',
  }
  // Legacy feature: has NO definitionId, has NO transform
  const legacyFeature: SketchFeature = {
    id: featureId,
    name: 'LegacyRect',
    kind: 'rect',
    operation: 'add',
    visible: true,
    locked: false,
    z_top: 3,
    z_bottom: 0,
    folderId: null,
    sketch: {
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
      profile,
    },
    text: null,
    stl: null,
    // definitionId intentionally absent
    // transform intentionally absent
  }

  const definitions: Record<string, FeatureDefinition> = { [featureId]: definition }
  const sourceDefId = getDefinitionId(legacyFeature)
  assert(sourceDefId === featureId, 'getDefinitionId falls back to feature.id for legacy source')

  // Copy as reference
  const copies = buildCopiedFeatures(
    [legacyFeature],
    [legacyFeature],
    150,
    0,
    1,
    definitions,
    'reference',
  )
  assert(copies.length === 1, 'one reference copy of legacy feature created')
  const copy = copies[0] as SketchFeature & { definitionId?: string; transform?: Matrix2D }

  // Copy MUST have an explicit definitionId matching the source's effective definitionId
  assert(
    copy.definitionId !== undefined,
    'legacy copy has explicit definitionId',
  )
  assert(
    copy.definitionId === featureId,
    `legacy copy definitionId equals source's effective definitionId (got "${copy.definitionId}")`,
  )
  assert(
    getDefinitionId(copy) === featureId,
    'getDefinitionId(copy) returns source definition',
  )

  // No new definition created
  const clonedDefs = extractClonedDefinitions(copies)
  assert(Object.keys(clonedDefs).length === 0, 'reference mode creates no cloned definitions')

  // Both rows are linked under the same definition
  const fullProject: Project = {
    ...base,
    features: [legacyFeature, copy as SketchFeature],
    featureDefinitions: definitions,
  }
  const siblingIds = getInstanceIdsForDefinition(fullProject, featureId)
  assert(siblingIds.length === 2, 'legacy source + copy are 2 linked instances')
  assert(siblingIds.includes(featureId), 'source is an instance')
  assert(siblingIds.includes(copy.id), 'copy is an instance')

  // Both resolve (source at origin, copy at offset)
  const sourceResolved = resolveFeatureInstance(fullProject, featureId)
  assert(sourceResolved !== null, 'legacy source resolves')
  const copyResolved = resolveFeatureInstance(fullProject, copy.id)
  assert(copyResolved !== null, 'legacy copy resolves')
  const sourceVerts = sourceResolved!.sketch.profile.segments.map(
    (s: { to?: Point }) => s.to ?? sourceResolved!.sketch.profile.start,
  )
  const copyVerts = copyResolved!.sketch.profile.segments.map(
    (s: { to?: Point }) => s.to ?? copyResolved!.sketch.profile.start,
  )
  for (let i = 0; i < sourceVerts.length; i++) {
    const sv = sourceVerts[i]
    const cv = copyVerts[i]
    if (sv) {
      assert(
        Math.abs(cv.x - (sv.x + 150)) < 0.01 && Math.abs(cv.y - sv.y) < 0.01,
        `legacy copy vertex ${i} shifted by (150,0), delta=(${(cv.x - sv.x - 150).toFixed(3)}, ${(cv.y - sv.y).toFixed(3)})`,
      )
    }
  }
}

// ── Reference copy of created/normal feature still links (no regression) ──

{
  // Same shape as the existing "Duplicate as Reference" test but with explicit
  // assertions that the copy carries an explicit definitionId — guards against
  // regression where we might drop definitionId from the reference-copy branch.
  const { project, rect } = makeSingleRectProject()
  const copies = buildCopiedFeatures(
    [rect],
    project.features,
    200,
    0,
    1,
    project.featureDefinitions,
    'reference',
  )
  assert(copies.length === 1, 'reference copy created')
  const copy = copies[0] as SketchFeature & { definitionId?: string; transform?: Matrix2D }

  // Copy must have an explicit definitionId (not just picked up from spread)
  assert(
    copy.definitionId !== undefined,
    'reference copy of normal feature has explicit definitionId',
  )
  assert(
    copy.definitionId === 'f-rect',
    `reference copy definitionId is "f-rect" (got "${copy.definitionId}")`,
  )
  assert(
    getDefinitionId(copy) === 'f-rect',
    'getDefinitionId(copy) returns f-rect',
  )

  const fullProject: Project = {
    ...project,
    features: [...project.features, copy as SketchFeature],
  }
  const instanceIds = getInstanceIdsForDefinition(fullProject, 'f-rect')
  assert(instanceIds.length === 2, 'definition has 2 instances (normal feature copy still links)')
  assert(instanceIds.includes('f0001'), 'source is an instance')
  assert(instanceIds.includes(copy.id), 'copy is an instance')
}

// ── Duplicate Independent (buildCopiedFeatures, independent mode) ──

{
  const { project, rect } = makeSingleRectProject()
  const features = project.features
  const definitions = project.featureDefinitions

  const copies = buildCopiedFeatures(
    [rect],
    features,
    200,
    0,
    1,
    definitions,
    'independent',
  )

  assert(copies.length === 1, 'one independent copy created')
  const copy = copies[0] as SketchFeature & { definitionId?: string; transform?: Matrix2D; _clonedDefinition?: FeatureDefinition }

  // Has a distinct definitionId
  const copyDefId = getDefinitionId(copy)
  assert(copyDefId !== 'f-rect', 'independent copy has distinct definitionId')

  // Has a cloned definition
  const clonedDefs = extractClonedDefinitions(copies)
  assert(Object.keys(clonedDefs).length === 1, 'independent mode creates one cloned definition')

  const fullProject: Project = {
    ...project,
    features: [...features, ...copies.map((c) => {
      const { _clonedDefinition, ...clean } = c as any
      return clean as SketchFeature
    })],
    featureDefinitions: { ...definitions, ...clonedDefs },
  }

  // Source definition edit does NOT affect the copy
  const sourceInstances = getInstanceIdsForDefinition(fullProject, 'f-rect')
  assert(sourceInstances.length === 1, 'source definition has only 1 instance')
  assert(sourceInstances[0] === 'f0001', 'source definition only has original instance')

  const copyInstances = getInstanceIdsForDefinition(fullProject, copyDefId)
  assert(copyInstances.length === 1, 'copy definition has only 1 instance')
  assert(copyInstances[0] === copy.id, 'copy definition only has the copy')
}

// ── Default copy behavior follows project copyMode ──

{
  const { project, rect } = makeSingleRectProject()

  // With reference copyMode (default)
  const refCopies = buildCopiedFeatures(
    [rect],
    project.features,
    10,
    10,
    1,
    project.featureDefinitions,
    project.meta.copyMode, // 'reference'
  )
  assert(refCopies.length === 1, 'default copy mode (reference) creates copy')
  assert(
    getDefinitionId(refCopies[0]) === 'f-rect',
    'default copy mode preserves definitionId',
  )
}

// ── Select Linked Instances query ──

{
  const { project, rect } = makeSingleRectProject()
  // Create two reference copies
  const copies1 = buildCopiedFeatures(
    [rect],
    project.features,
    100, 0, 1,
    project.featureDefinitions,
    'reference',
  )
  const allSoFar = [...project.features, ...copies1.map((c) => {
    const { _clonedDefinition, ...clean } = c as any
    return clean as SketchFeature
  })]
  const copies2 = buildCopiedFeatures(
    [rect],
    allSoFar,
    200, 0, 1,
    project.featureDefinitions,
    'reference',
  )

  const allFeatures = [...allSoFar, ...copies2.map((c) => {
    const { _clonedDefinition, ...clean } = c as any
    return clean as SketchFeature
  })]
  const fullProject: Project = {
    ...project,
    features: allFeatures,
  }

  const siblings = getInstanceIdsForDefinition(fullProject, 'f-rect')
  assert(siblings.length === 3, '3 instances share the definition')
  assert(siblings.includes('f0001'), 'source is included')

  // Also create an independent copy — should NOT be in the siblings
  const indCopies = buildCopiedFeatures(
    [rect],
    allFeatures,
    300, 0, 1,
    fullProject.featureDefinitions,
    'independent',
  )
  const clonedDefs = extractClonedDefinitions(indCopies)
  const indCopy = indCopies[0] as SketchFeature & { definitionId?: string }
  const indDefId = getDefinitionId(indCopy)

  const finalFeatures = [...allFeatures, ...indCopies.map((c) => {
    const { _clonedDefinition, ...clean } = c as any
    return clean as SketchFeature
  })]
  const finalProject: Project = {
    ...fullProject,
    features: finalFeatures,
    featureDefinitions: { ...fullProject.featureDefinitions, ...clonedDefs },
  }

  const refSiblings = getInstanceIdsForDefinition(finalProject, 'f-rect')
  assert(refSiblings.length === 3, 'reference siblings unchanged after independent copy')

  const indSiblings = getInstanceIdsForDefinition(finalProject, indDefId)
  assert(indSiblings.length === 1, 'independent copy has no siblings')
  assert(indSiblings[0] === indCopy.id, 'independent copy is its own only instance')

  // Select linked query returns exactly the siblings
  const linkedForSource = getInstanceIdsForDefinition(finalProject, getDefinitionId(rect))
  assert(linkedForSource.length === 3, 'select linked for source returns 3')
  assert(
    linkedForSource.every((id) => refSiblings.includes(id)),
    'select linked returns exactly the reference siblings',
  )
}

console.log('✓ All duplicate reference tests passed.')
