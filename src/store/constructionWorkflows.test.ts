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
 * Store-level tests for construction-geometry workflows (issue #199):
 * creation via the construction target, conversion construction ↔ feature ↔
 * region, section integrity for folders/moves, save-version stamping, and
 * open-profile survival across save/load.
 *
 * Run with: npx tsx src/store/constructionWorkflows.test.ts
 */

import { useProjectStore } from './projectStore'
import { newProject } from '../types/project'
import type { Project, SketchFeature } from '../types/project'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function freshStore(project?: Project): void {
  useProjectStore.setState({
    project: project ?? newProject('Construction Workflows', 'mm'),
    creationTarget: 'feature',
    pendingAdd: null,
    history: { past: [], future: [], transactionStart: null },
  })
}

function getFeature(id: string): SketchFeature {
  const feature = useProjectStore.getState().project.features.find((item) => item.id === id)
  assert(feature !== undefined, `feature ${id} exists`)
  return feature
}

function lastFeature(): SketchFeature {
  const features = useProjectStore.getState().project.features
  assert(features.length > 0, 'expected at least one feature')
  return features[features.length - 1]
}

// ── Creation via the construction target ─────────────────────────

function testConstructionCreation(): void {
  console.log('Testing construction creation target...')
  freshStore()
  useProjectStore.getState().setCreationTarget('construction')

  // A closed shape drawn under the construction target becomes a construction
  // feature — even as the very first feature (no forced-add).
  useProjectStore.getState().addRectFeature('Rect 1', 0, 0, 20, 10, 5)
  const constructionRect = lastFeature()
  assert(constructionRect.operation === 'construction', 'construction target creates construction features')
  assert(constructionRect.name === 'Construction 1', `construction naming, got ${constructionRect.name}`)

  // The next machinable feature is still subject to the first-machining=add rule.
  useProjectStore.getState().setCreationTarget('feature')
  useProjectStore.getState().addRectFeature('Rect 2', 0, 0, 8, 8, 5)
  const firstMachinable = lastFeature()
  assert(firstMachinable.operation === 'add', 'first machinable feature is still forced to add')
}

// ── Conversions ───────────────────────────────────────────────────

function testConversions(): void {
  console.log('Testing construction ↔ feature ↔ region conversions...')
  freshStore()
  useProjectStore.getState().addRectFeature('Base', 0, 0, 30, 30, 5) // forced add (first machinable)
  useProjectStore.getState().addRectFeature('Pocket', 2, 2, 10, 10, 5) // subtract
  const pocketId = lastFeature().id
  assert(getFeature(pocketId).operation === 'subtract', 'second feature defaults to subtract')

  // feature → construction: z edits are stripped, operation converts.
  useProjectStore.getState().updateFeature(pocketId, { operation: 'construction', z_top: 99 })
  assert(getFeature(pocketId).operation === 'construction', 'feature converts to construction')
  assert(getFeature(pocketId).z_top !== 99, 'z_top edits are stripped when converting to construction')

  // construction → region (closed profile): allowed.
  useProjectStore.getState().updateFeature(pocketId, { operation: 'region' })
  assert(getFeature(pocketId).operation === 'region', 'closed construction converts to region')

  // region → construction: allowed.
  useProjectStore.getState().updateFeature(pocketId, { operation: 'construction' })
  assert(getFeature(pocketId).operation === 'construction', 'region converts back to construction')

  // construction → feature (subtract).
  useProjectStore.getState().updateFeature(pocketId, { operation: 'subtract' })
  assert(getFeature(pocketId).operation === 'subtract', 'construction converts back to subtract')

  // Converting the FIRST row to construction is allowed (it leaves the model),
  // and does not get force-rewritten to add.
  const firstId = useProjectStore.getState().project.features[0].id
  useProjectStore.getState().updateFeature(firstId, { operation: 'construction' })
  assert(getFeature(firstId).operation === 'construction', 'first row may convert to construction')
}

// ── Section integrity: folders and moves ─────────────────────────

function testSectionIntegrity(): void {
  console.log('Testing folder/section integrity...')
  freshStore()
  useProjectStore.getState().setCreationTarget('construction')
  useProjectStore.getState().addRectFeature('C', 0, 0, 5, 5, 5)
  const constructionId = lastFeature().id
  useProjectStore.getState().setCreationTarget('feature')
  useProjectStore.getState().addRectFeature('F', 0, 0, 9, 9, 5)
  const machinableId = lastFeature().id

  const constructionFolderId = useProjectStore.getState().addFeatureFolder('construction')
  const featuresFolderId = useProjectStore.getState().addFeatureFolder('features')
  const constructionFolder = useProjectStore.getState().project.featureFolders.find((f) => f.id === constructionFolderId)
  assert(constructionFolder?.section === 'construction', 'construction folder carries its section')
  assert(constructionFolder?.name.startsWith('Construction Folder'), 'construction folder naming')

  // Cross-section tree moves are rejected outright.
  useProjectStore.getState().moveFeatureTreeFeature(constructionId, featuresFolderId)
  assert(getFeature(constructionId).folderId === null, 'construction cannot move into a features folder')
  useProjectStore.getState().moveFeatureTreeFeature(machinableId, constructionFolderId)
  assert(getFeature(machinableId).folderId === null, 'machinable feature cannot move into a construction folder')

  // Matching-section moves work.
  useProjectStore.getState().moveFeatureTreeFeature(constructionId, constructionFolderId)
  assert(getFeature(constructionId).folderId === constructionFolderId, 'construction moves into a construction folder')

  // assignFeaturesToFolder resolves mismatches to the section root.
  useProjectStore.getState().assignFeaturesToFolder([constructionId, machinableId], featuresFolderId)
  assert(getFeature(constructionId).folderId === null, 'mismatched assign falls back to root')
  assert(getFeature(machinableId).folderId === featuresFolderId, 'matching assign lands in the folder')

  // Converting a foldered construction feature moves it out of the folder.
  useProjectStore.getState().assignFeaturesToFolder([constructionId], constructionFolderId)
  useProjectStore.getState().updateFeature(constructionId, { operation: 'region' })
  assert(getFeature(constructionId).folderId === null, 'conversion clears a now-mismatched folder')

  // Visibility bulk toggles stay scoped per section.
  useProjectStore.getState().updateFeature(constructionId, { operation: 'construction' })
  useProjectStore.getState().setAllConstructionVisible(false)
  assert(!getFeature(constructionId).visible, 'setAllConstructionVisible hides construction')
  assert(getFeature(machinableId).visible, 'setAllConstructionVisible leaves machinable features alone')
  useProjectStore.getState().setAllFeaturesVisible(false)
  useProjectStore.getState().setAllConstructionVisible(true)
  assert(!getFeature(machinableId).visible, 'setAllFeaturesVisible hides machinable features')
  assert(getFeature(constructionId).visible, 'setAllFeaturesVisible leaves construction alone')
}

// ── Grouping stays within one section ────────────────────────────

function testGrouping(): void {
  console.log('Testing grouping stays within one section...')
  freshStore()
  useProjectStore.getState().setCreationTarget('construction')
  useProjectStore.getState().addRectFeature('C1', 0, 0, 5, 5, 5)
  const c1 = lastFeature().id
  useProjectStore.getState().addRectFeature('C2', 10, 0, 5, 5, 5)
  const c2 = lastFeature().id
  useProjectStore.getState().setCreationTarget('feature')
  useProjectStore.getState().addRectFeature('F1', 0, 10, 5, 5, 5)
  const f1 = lastFeature().id

  // Same-kind: two construction features group into a construction-section
  // grouped folder, and both land inside it.
  useProjectStore.getState().selectFeatures([c1, c2])
  const groupId = useProjectStore.getState().groupSelectedFeaturesIntoNewFolder()
  assert(groupId !== '', 'construction features group with their own kind')
  const groupFolder = useProjectStore.getState().project.featureFolders.find((f) => f.id === groupId)
  assert(groupFolder?.section === 'construction', 'construction group folder lives in the construction section')
  assert(groupFolder?.grouped === true, 'group folder is marked grouped')
  assert(getFeature(c1).folderId === groupId && getFeature(c2).folderId === groupId, 'both construction features joined the group')

  // Mixed sections: grouping construction with a machinable feature is a no-op.
  useProjectStore.getState().toggleFolderGrouped(groupId) // ungroup so c1 can be reselected freely
  useProjectStore.getState().selectFeatures([c1, f1])
  const folderCountBefore = useProjectStore.getState().project.featureFolders.length
  const mixedResult = useProjectStore.getState().groupSelectedFeaturesIntoNewFolder()
  assert(mixedResult === '', 'mixed-section grouping is rejected')
  assert(useProjectStore.getState().project.featureFolders.length === folderCountBefore, 'no folder is created for a mixed group')
  assert(getFeature(f1).folderId === null, 'machinable feature stays put after rejected group')
}

// ── Copying group members joins the original group ───────────────

function copyByMove(featureIds: string[]): string[] {
  const before = new Set(useProjectStore.getState().project.features.map((f) => f.id))
  useProjectStore.setState({
    pendingMove: {
      mode: 'copy',
      entityType: 'feature',
      entityIds: featureIds,
      fromPoint: { x: 0, y: 0 },
      toPoint: null,
      session: 1,
    },
  })
  useProjectStore.getState().completePendingMove({ x: 40, y: 0 })
  return useProjectStore.getState().project.features
    .filter((f) => !before.has(f.id))
    .map((f) => f.id)
}

function testCopyIntoGroup(): void {
  console.log('Testing copies of group members join the original group...')
  freshStore()
  useProjectStore.getState().setCreationTarget('construction')
  useProjectStore.getState().addRectFeature('C1', 0, 0, 5, 5, 5)
  const c1 = lastFeature().id
  useProjectStore.getState().addRectFeature('C2', 10, 0, 5, 5, 5)
  const c2 = lastFeature().id
  useProjectStore.getState().selectFeatures([c1, c2])
  const groupId = useProjectStore.getState().groupSelectedFeaturesIntoNewFolder()
  assert(groupId !== '', 'group created')

  // Copying a SINGLE member joins the original group — no new folder.
  const foldersBefore = useProjectStore.getState().project.featureFolders.length
  const [memberCopyId] = copyByMove([c1])
  assert(memberCopyId !== undefined, 'member copy created')
  assert(getFeature(memberCopyId).folderId === groupId, 'member copy joined the original group')
  assert(useProjectStore.getState().project.featureFolders.length === foldersBefore, 'no new folder for a member copy')
  assert(
    !useProjectStore.getState().project.featureTree.some((entry) => entry.type === 'feature' && entry.featureId === memberCopyId),
    'foldered copy gets no root tree entry',
  )

  // Copying the WHOLE group still clones the group into a new grouped folder.
  const memberIds = useProjectStore.getState().project.features
    .filter((f) => f.folderId === groupId)
    .map((f) => f.id)
  const wholeCopyIds = copyByMove(memberIds)
  assert(wholeCopyIds.length === memberIds.length, 'whole-group copy created one copy per member')
  const copyFolderIds = new Set(wholeCopyIds.map((id) => getFeature(id).folderId))
  assert(copyFolderIds.size === 1, 'whole-group copies share one folder')
  const [copyFolderId] = [...copyFolderIds]
  assert(copyFolderId !== null && copyFolderId !== groupId, 'whole-group copy landed in a NEW folder')
  const copyFolder = useProjectStore.getState().project.featureFolders.find((f) => f.id === copyFolderId)
  assert(copyFolder?.grouped === true, 'copied group folder is grouped')
  assert(copyFolder?.section === 'construction', 'copied group folder keeps the section')
}

// ── Base-solid rule tracks the first MACHINABLE feature ──────────

function testFirstMachinableRule(): void {
  console.log('Testing base-solid rule against the first machinable feature...')
  freshStore()
  useProjectStore.getState().setCreationTarget('construction')
  useProjectStore.getState().addRectFeature('C1', 0, 0, 5, 5, 5)
  useProjectStore.getState().setCreationTarget('feature')
  useProjectStore.getState().addRectFeature('Base', 0, 0, 30, 30, 5)
  const baseId = lastFeature().id
  assert(getFeature(baseId).operation === 'add', 'first machinable feature is forced to add')
  useProjectStore.getState().addRectFeature('Pocket', 2, 2, 8, 8, 5)
  const pocketId = lastFeature().id
  assert(getFeature(pocketId).operation === 'subtract', 'later feature stays subtract')

  // The first machinable feature is row 1 (construction sits at row 0) —
  // changing it to subtract must still be forced back to add.
  useProjectStore.getState().updateFeature(baseId, { operation: 'subtract' })
  assert(getFeature(baseId).operation === 'add', 'first machinable feature cannot become subtract')

  // Converting the base out of the model cascades the rule to the successor
  // (mirrors reorderFeatures): the pocket becomes the new base and turns add.
  useProjectStore.getState().updateFeature(baseId, { operation: 'construction' })
  assert(getFeature(baseId).operation === 'construction', 'base may convert to construction')
  assert(getFeature(pocketId).operation === 'add', 'successor is forced to add when the base leaves the model')
}

// ── Bulk operation changes propagate to definitions + linked siblings ──

function testBulkLinkedPropagation(): void {
  console.log('Testing updateFeatures propagates operation to definitions and linked siblings...')
  freshStore()
  useProjectStore.getState().addRectFeature('Base', 0, 0, 40, 40, 5)
  useProjectStore.getState().addRectFeature('Pocket', 2, 2, 8, 8, 5)
  const pocketId = lastFeature().id
  const [copyId] = copyByMove([pocketId])
  assert(copyId !== undefined, 'reference copy created')
  const defId = (getFeature(copyId) as SketchFeature & { definitionId?: string }).definitionId
  assert(defId !== undefined, 'reference copy is linked to a definition')

  // Bulk-convert only the copy: the shared definition AND the linked sibling
  // outside the selection must follow (same semantics as updateFeature).
  useProjectStore.getState().updateFeatures([copyId], { operation: 'construction' })
  assert(getFeature(copyId).operation === 'construction', 'selected instance converted')
  assert(getFeature(pocketId).operation === 'construction', 'linked sibling outside the selection followed')
  assert(
    useProjectStore.getState().project.featureDefinitions[defId].operation === 'construction',
    'shared definition operation followed',
  )

  useProjectStore.getState().updateFeatures([copyId], { operation: 'subtract' })
  assert(getFeature(copyId).operation === 'subtract', 'bulk conversion back to subtract')
  assert(getFeature(pocketId).operation === 'subtract', 'sibling follows back')
  assert(
    useProjectStore.getState().project.featureDefinitions[defId].operation === 'subtract',
    'definition follows back',
  )
}

// ── Constraints stay deferred on construction ────────────────────

function testConstraintDeferred(): void {
  console.log('Testing constraints are deferred on construction features...')
  freshStore()
  useProjectStore.getState().setCreationTarget('construction')
  useProjectStore.getState().addRectFeature('C', 0, 0, 5, 5, 5)
  const constructionId = lastFeature().id
  useProjectStore.getState().beginConstraint(constructionId)
  assert(useProjectStore.getState().pendingConstraint === null, 'beginConstraint on construction is a no-op')

  useProjectStore.getState().setCreationTarget('feature')
  useProjectStore.getState().addRectFeature('F', 0, 0, 9, 9, 5)
  const machinableId = lastFeature().id
  useProjectStore.getState().beginConstraint(machinableId)
  assert(useProjectStore.getState().pendingConstraint?.featureId === machinableId, 'beginConstraint still works on machinable features')
  useProjectStore.getState().cancelPendingConstraint()
}

// ── Save stamping + open-profile round trip ──────────────────────

function testSaveVersionStamping(): void {
  console.log('Testing save-version stamping and open-construction round trip...')
  freshStore()
  useProjectStore.getState().addRectFeature('Base', 0, 0, 30, 30, 5)
  const withoutConstruction = JSON.parse(useProjectStore.getState().saveProject()) as { version: string }
  assert(withoutConstruction.version === '2.0', 'no construction → file stays 2.0')

  // Add an OPEN construction polyline directly (as the open-path tool does).
  const open: SketchFeature = {
    id: 'f-open-construction',
    name: 'Construction 1',
    kind: 'polygon',
    folderId: null,
    sketch: {
      profile: {
        start: { x: 0, y: 0 },
        segments: [
          { type: 'line', to: { x: 10, y: 0 } },
          { type: 'line', to: { x: 20, y: 6 } },
        ],
        closed: false,
      },
      origin: { x: 0, y: 0 },
      orientationAngle: 90,
      dimensions: [],
      constraints: [],
    },
    operation: 'construction',
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
  useProjectStore.getState().addFeature(open)
  assert(lastFeature().operation === 'construction', 'open construction feature is inserted as construction')

  const saved = useProjectStore.getState().saveProject()
  const parsed = JSON.parse(saved) as { version: string }
  assert(parsed.version === '2.1', 'construction present → file stamped 2.1')

  // Round trip: the open construction profile must survive load untouched
  // (the legacy open-profile → line migration must skip construction).
  useProjectStore.getState().openProjectFromText(saved, null)
  const reloaded = useProjectStore.getState().project.features.find((f) => f.name === 'Construction 1')
  assert(reloaded !== undefined, 'open construction survives a save/load round trip')
  assert(reloaded.operation === 'construction', 'open construction keeps its operation on load')
  assert(!reloaded.sketch.profile.closed, 'open construction stays open on load')
  assert(useProjectStore.getState().loadWarning === null, 'a 2.1 file opens without a version warning in this build')
}

testConstructionCreation()
testConversions()
testSectionIntegrity()
testGrouping()
testCopyIntoGroup()
testFirstMachinableRule()
testBulkLinkedPropagation()
testConstraintDeferred()
testSaveVersionStamping()

console.log('constructionWorkflows.test.ts passed')
