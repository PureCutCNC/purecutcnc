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

import { cloneTextFeatureData, newProject, rectProfile, type Project, type TextLayout } from '../types/project'
import { projectWithFeatures } from '../test/projectFixtures'
import { normalizeProject } from './helpers/projectFormat'
import { resolveFeatureInstance } from './helpers/resolveFeatures'
import { defaultTextToolConfig } from '../text'
import { useProjectStore } from './projectStore'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function makeProject(): Project {
  return projectWithFeatures(newProject(), [
    {
      id: 'guide', name: 'Guide', kind: 'rect', operation: 'add', visible: true, locked: false,
      z_top: 5, z_bottom: 0, folderId: null, text: null, stl: null,
      sketch: { origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [], profile: rectProfile(0, 0, 40, 20) },
    },
  ])
}

function resetStore() {
  useProjectStore.setState({
    project: makeProject(),
    pendingAdd: null,
    history: { past: [], future: [], transactionStart: null },
    dirty: false,
  })
}

function startText() {
  useProjectStore.getState().startAddTextPlacement({ ...defaultTextToolConfig('mm'), text: 'ABC' })
}

function pendingText() {
  const pending = useProjectStore.getState().pendingAdd
  assert(pending?.shape === 'text', 'a text placement should be pending')
  return pending
}

const arcLayout: Extract<TextLayout, { kind: 'arc' }> = {
  kind: 'arc', radius: 30, angleDegrees: 270, sweepDegrees: 120,
  anchor: 'center', fit: 'natural', direction: 'cw', orientation: 'follow',
}

const pathLayout: Extract<TextLayout, { kind: 'path' }> = {
  kind: 'path', path: { start: { x: 0, y: 0 }, segments: [], closed: false },
  startOffset: 0, endOffset: 0, anchor: 'center', fit: 'natural', reversed: false, orientation: 'follow',
}

function testArcPlacesInTwoClicksAndTheFirstOnlySetsTheCentre() {
  resetStore()
  startText()
  useProjectStore.getState().updateTextLayout(arcLayout)

  const featuresBefore = useProjectStore.getState().project.features.length
  const first = useProjectStore.getState().placePendingTextAt({ x: 100, y: 100 })
  assert(first.length === 0, 'the first arc click creates nothing')
  assert(useProjectStore.getState().project.features.length === featuresBefore, 'no feature yet')
  const anchor = pendingText().anchor
  assert(anchor?.x === 100 && anchor.y === 100, 'the first click parks the centre')

  const second = useProjectStore.getState().placePendingTextAt({ x: 100, y: 60 })
  assert(second.length === 1, 'the second arc click commits the run')
  const created = resolveFeatureInstance(useProjectStore.getState().project, second[0]!)
  assert(created?.text?.layout?.kind === 'arc', 'the created feature carries its arc layout')
  // Radius came from the drag: 40 units from centre to cursor.
  assert(Math.abs(created.text.layout.radius - 40) < 1e-6, 'radius follows the drag distance')
  console.log('arc places in two clicks: PASSED')
}

function testTheDragInfersDirectionUntilTheUserSetsIt() {
  resetStore()
  startText()
  useProjectStore.getState().updateTextLayout(arcLayout)
  useProjectStore.getState().placePendingTextAt({ x: 100, y: 100 })
  // Cursor below the centre: the text belongs under the circle, reading upright.
  const below = useProjectStore.getState().placePendingTextAt({ x: 100, y: 160 })
  const inferred = resolveFeatureInstance(useProjectStore.getState().project, below[0]!)
  assert(inferred?.text?.layout?.kind === 'arc' && inferred.text.layout.direction === 'ccw', 'below the centre infers ccw')

  // Once the panel sets a direction, the cursor stops overriding it.
  resetStore()
  startText()
  useProjectStore.getState().updateTextLayout(arcLayout)
  useProjectStore.getState().updateTextLayout({ ...arcLayout, direction: 'ccw' })
  useProjectStore.getState().updateTextLayout({ ...arcLayout, direction: 'cw' })
  assert(pendingText().directionPinned, 'changing direction by hand pins it')
  useProjectStore.getState().placePendingTextAt({ x: 100, y: 100 })
  const pinnedIds = useProjectStore.getState().placePendingTextAt({ x: 100, y: 160 })
  const pinned = resolveFeatureInstance(useProjectStore.getState().project, pinnedIds[0]!)
  assert(pinned?.text?.layout?.kind === 'arc' && pinned.text.layout.direction === 'cw', 'a pinned direction survives a downward drag')
  console.log('direction is inferred until pinned: PASSED')
}

function testPathModeNeedsAGuideAndCommitsFromThePanel() {
  resetStore()
  startText()
  useProjectStore.getState().updateTextLayout(pathLayout)

  // Without a guide there is no baseline, and committing anyway would quietly
  // produce straight text instead of text on a path.
  assert(useProjectStore.getState().completeTextLayout().length === 0, 'it cannot commit without a guide')
  assert(useProjectStore.getState().project.features.length === 1, 'and creates nothing while refusing')

  useProjectStore.getState().setTextLayoutGuide('guide')
  const layout = pendingText().config.layout
  assert(layout?.kind === 'path', 'the guide is baked into a path layout')
  assert(layout.path.segments.length > 0, 'the guide outline is copied in')
  assert(layout.endOffset > 0, 'a new guide defaults to its whole length')

  const ids = useProjectStore.getState().completeTextLayout()
  assert(ids.length === 1, 'the panel commits the run')
  const created = resolveFeatureInstance(useProjectStore.getState().project, ids[0]!)
  assert(created?.text?.layout?.kind === 'path', 'the created feature carries its path layout')
  console.log('path mode needs a guide and commits from the panel: PASSED')
}

function testTheBakedGuideDoesNotAliasTheGuideFeature() {
  resetStore()
  startText()
  useProjectStore.getState().updateTextLayout(pathLayout)
  useProjectStore.getState().setTextLayoutGuide('guide')

  const layout = pendingText().config.layout
  assert(layout?.kind === 'path', 'path layout expected')
  const guide = resolveFeatureInstance(useProjectStore.getState().project, 'guide')
  assert(guide, 'guide should resolve')
  assert(layout.path !== guide.sketch.profile, 'the baked path is a copy, not the guide profile itself')
  assert(layout.path.start !== guide.sketch.profile.start, 'points are copied too, not shared')
  console.log('the baked guide is a real copy: PASSED')
}

function testSwitchingModesRestartsTheGesture() {
  resetStore()
  startText()
  useProjectStore.getState().updateTextLayout(arcLayout)
  useProjectStore.getState().placePendingTextAt({ x: 10, y: 10 })
  assert(pendingText().anchor !== null, 'the arc centre is parked')

  useProjectStore.getState().updateTextLayout(pathLayout)
  assert(pendingText().anchor === null, 'switching layout drops the centre picked for the old one')

  useProjectStore.getState().setTextLayoutGuide('guide')
  useProjectStore.getState().updateTextLayout(null)
  assert(pendingText().guideId === null, 'going back to horizontal drops the guide')
  console.log('switching modes restarts the gesture: PASSED')
}

function testLayoutSurvivesAProjectRoundTripWithoutAliasing() {
  resetStore()
  startText()
  useProjectStore.getState().updateTextLayout(pathLayout)
  useProjectStore.getState().setTextLayoutGuide('guide')
  useProjectStore.getState().completeTextLayout()

  const saved = JSON.parse(JSON.stringify(useProjectStore.getState().project)) as Project
  const reloaded = normalizeProject(saved)
  const text = reloaded.features
    .map((feature) => resolveFeatureInstance(reloaded, feature.id))
    .find((feature) => feature?.text?.layout)
  assert(text?.text?.layout?.kind === 'path', 'the layout survives a save and load')
  assert(text.text.layout.path.segments.length > 0, 'the baked guide survives too')

  // The definition and the resolved instance must not share one layout object,
  // or editing either would silently rewrite the other.
  const definition = reloaded.featureDefinitions[
    reloaded.features.find((feature) => feature.id === text.id)!.definitionId
  ]
  assert(definition?.text?.layout, 'the definition carries the layout')
  assert(definition.text.layout !== text.text.layout, 'definition and instance hold separate layout objects')
  console.log('layout survives a round trip without aliasing: PASSED')
}

function testCloneTextFeatureDataDeepCopiesAPathLayout() {
  const source = {
    text: 'A', style: 'skeleton' as const, fontId: 'simple_stroke' as const, size: 10,
    layout: {
      kind: 'path' as const,
      path: {
        start: { x: 0, y: 0 },
        segments: [
          { type: 'line' as const, to: { x: 1, y: 1 } },
          { type: 'bezier' as const, to: { x: 2, y: 2 }, control1: { x: 3, y: 3 }, control2: { x: 4, y: 4 } },
          { type: 'arc' as const, to: { x: 5, y: 5 }, center: { x: 6, y: 6 }, clockwise: true },
        ],
        closed: false,
      },
      startOffset: 0, endOffset: 5, anchor: 'center' as const, fit: 'natural' as const,
      reversed: false, orientation: 'follow' as const,
    },
  }
  const copy = cloneTextFeatureData(source)
  assert(copy?.layout?.kind === 'path', 'clone keeps the layout')
  assert(copy.layout !== source.layout, 'layout object is copied')
  assert(copy.layout.path !== source.layout.path, 'profile is copied')
  assert(copy.layout.path.segments[0] !== source.layout.path.segments[0], 'segments are copied')

  // Every point-bearing field of every segment kind, since a missed one aliases
  // silently and only shows up as a phantom edit much later.
  const bezier = copy.layout.path.segments[1]!
  const arc = copy.layout.path.segments[2]!
  assert(bezier.type === 'bezier' && arc.type === 'arc', 'segment kinds preserved')
  assert(bezier.control1 !== (source.layout.path.segments[1] as typeof bezier).control1, 'bezier control1 copied')
  assert(bezier.control2 !== (source.layout.path.segments[1] as typeof bezier).control2, 'bezier control2 copied')
  assert(arc.center !== (source.layout.path.segments[2] as typeof arc).center, 'arc centre copied')
  console.log('cloneTextFeatureData deep-copies a path layout: PASSED')
}

testArcPlacesInTwoClicksAndTheFirstOnlySetsTheCentre()
testTheDragInfersDirectionUntilTheUserSetsIt()
testPathModeNeedsAGuideAndCommitsFromThePanel()
testTheBakedGuideDoesNotAliasTheGuideFeature()
testSwitchingModesRestartsTheGesture()
testLayoutSurvivesAProjectRoundTripWithoutAliasing()
testCloneTextFeatureDataDeepCopiesAPathLayout()
