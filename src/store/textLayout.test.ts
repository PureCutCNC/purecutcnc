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

import { cloneTextFeatureData, getProfileBounds, newProject, rectProfile, type Project, type TextLayout } from '../types/project'
import { projectWithFeatures } from '../test/projectFixtures'
import { normalizeProject } from './helpers/projectFormat'
import { resolveFeatureInstance } from './helpers/resolveFeatures'
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
    {
      id: 'run', name: 'ABC', kind: 'text', operation: 'subtract', visible: true, locked: false,
      z_top: 5, z_bottom: 0, folderId: null, stl: null,
      text: { text: 'ABC', style: 'skeleton', fontId: 'simple_stroke', size: 10, layout: null },
      sketch: { origin: { x: 0, y: 0 }, orientationAngle: 90, dimensions: [], constraints: [], profile: rectProfile(200, 200, 30, 10) },
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

/** Select the placed run and open a baseline edit on it. */
function startLayout(kind: 'arc' | 'path' = 'arc') {
  useProjectStore.setState((s) => ({
    selection: { ...s.selection, selectedFeatureId: 'run', selectedFeatureIds: ['run'], mode: 'feature' },
  }))
  useProjectStore.getState().startTextLayout(kind)
}

function pendingLayout() {
  const pending = useProjectStore.getState().pendingTextLayout
  assert(pending, 'a text layout edit should be pending')
  return pending
}

function runLayout() {
  return resolveFeatureInstance(useProjectStore.getState().project, 'run')?.text?.layout ?? null
}

const arcLayout: Extract<TextLayout, { kind: 'arc' }> = {
  kind: 'arc', radius: 30, angleDegrees: 270, sweepDegrees: 120,
  anchor: 'center', fit: 'natural', direction: 'cw', orientation: 'follow',
}

const pathLayout: Extract<TextLayout, { kind: 'path' }> = {
  kind: 'path', path: { start: { x: 0, y: 0 }, segments: [], closed: false },
  startOffset: 0, endOffset: 0, anchor: 'center', fit: 'natural', reversed: false, orientation: 'follow',
}

/**
 * `cw` writes across the top of the circle, `ccw` across the bottom, and both
 * read left to right. Flipping the control therefore has to carry the run to
 * the other half — reversing travel while leaving the anchor at 12 o'clock
 * renders the text upside down there, which is what a hand test caught.
 */
function testFlippingDirectionMovesTheRunToTheBottom() {
  resetStore()
  startLayout()
  const top: TextLayout = {
    kind: 'arc', radius: 40, angleDegrees: 270, sweepDegrees: 120,
    anchor: 'center', fit: 'natural', direction: 'cw', orientation: 'follow',
  }
  useProjectStore.getState().updateTextLayout(top)
  useProjectStore.getState().updateTextLayout({ ...top, direction: 'ccw' })

  const layout = pendingLayout().layout
  assert(layout?.kind === 'arc', 'still an arc layout')
  assert(layout.direction === 'ccw', 'direction switched')
  assert(
    Math.abs(layout.angleDegrees - 90) < 1e-6,
    `ccw should sit at 6 o'clock, got ${layout.angleDegrees}`,
  )

  // And back again, so the pair is symmetric rather than a one-way trip.
  useProjectStore.getState().updateTextLayout({ ...layout, direction: 'cw' })
  const back = pendingLayout().layout
  assert(back?.kind === 'arc' && Math.abs(back.angleDegrees - 270) < 1e-6, 'cw returns to the top')
  console.log('flipping direction moves the run between top and bottom: PASSED')
}

/** An off-centre run keeps its left/right bias when the direction flips. */
function testFlippingDirectionKeepsSidewaysBias() {
  resetStore()
  startLayout()
  const biased: TextLayout = {
    kind: 'arc', radius: 40, angleDegrees: 300, sweepDegrees: 120,
    anchor: 'center', fit: 'natural', direction: 'cw', orientation: 'follow',
  }
  useProjectStore.getState().updateTextLayout(biased)
  useProjectStore.getState().updateTextLayout({ ...biased, direction: 'ccw' })
  const layout = pendingLayout().layout
  assert(layout?.kind === 'arc', 'arc layout')
  assert(Math.abs(layout.angleDegrees - 60) < 1e-6, `expected 60, got ${layout.angleDegrees}`)
  console.log('direction flip mirrors rather than resets the angle: PASSED')
}

function testArcAppliesToTheSelectedRunOnceItsCentreIsPicked() {
  resetStore()
  startLayout('arc')
  useProjectStore.getState().updateTextLayout(arcLayout)

  // Without a centre the arc has nowhere to sit, and applying anyway would
  // silently leave the run straight — the button appearing to do nothing.
  assert(useProjectStore.getState().completeTextLayout().length === 0, 'it cannot apply without a centre')
  assert(runLayout() === null, 'and the run is untouched while refusing')

  useProjectStore.getState().setTextLayoutCenter({ x: 100, y: 100 })
  assert(pendingLayout().center?.x === 100, 'the pick parks the centre')

  const ids = useProjectStore.getState().completeTextLayout()
  assert(ids.length === 1 && ids[0] === 'run', 'applying targets the selected run')
  assert(runLayout()?.kind === 'arc', 'the run now carries its arc layout')
  console.log('arc applies to the selected run: PASSED')
}

/**
 * The frame is the only thing setting a run's proportions, so applying a
 * baseline has to resize it. Leaving the straight run's rect in place would
 * squeeze the curved run into it — the same defect as #722.
 */
function testApplyingResizesTheFrameToTheBentRun() {
  resetStore()
  startLayout('arc')
  const beforeBounds = getProfileBounds(resolveFeatureInstance(useProjectStore.getState().project, 'run')!.sketch.profile)

  // `fill` is the case that actually reshapes the frame: under `natural` the
  // run keeps its own width and the sweep field is only a readout.
  useProjectStore.getState().updateTextLayout({ ...arcLayout, fit: 'fill', sweepDegrees: 300, radius: 50 })
  useProjectStore.getState().setTextLayoutCenter({ x: 100, y: 100 })
  useProjectStore.getState().completeTextLayout()

  const after = getProfileBounds(resolveFeatureInstance(useProjectStore.getState().project, 'run')!.sketch.profile)
  const beforeWidth = beforeBounds.maxX - beforeBounds.minX
  const afterWidth = after.maxX - after.minX
  assert(afterWidth > beforeWidth * 2, `frame should grow to hold the arc, ${beforeWidth} -> ${afterWidth}`)
  // A near-full ring is about as tall as it is wide; a straight run is not.
  assert(Math.abs(afterWidth - (after.maxY - after.minY)) < afterWidth * 0.5, "the frame takes the arc's aspect")
  console.log('applying resizes the frame to the bent run: PASSED')
}

function testReopeningKeepsTheRunsCurrentBaseline() {
  resetStore()
  startLayout('arc')
  useProjectStore.getState().updateTextLayout({ ...arcLayout, radius: 77 })
  useProjectStore.getState().setTextLayoutCenter({ x: 100, y: 100 })
  useProjectStore.getState().completeTextLayout()

  startLayout('arc')
  const reopened = pendingLayout().layout
  assert(reopened?.kind === 'arc' && Math.abs(reopened.radius - 77) < 1e-6, "reopening loads the run's own arc")
  console.log('reopening keeps the current baseline: PASSED')
}

/**
 * Straightening a curved run must leave it where it is. The straight template
 * sits at the origin of template space, so anchoring the rebuilt frame there
 * would teleport the run across the sketch.
 */
function testStraighteningKeepsTheRunWhereItIs() {
  resetStore()
  startLayout('arc')
  useProjectStore.getState().updateTextLayout(arcLayout)
  useProjectStore.getState().setTextLayoutCenter({ x: 300, y: 300 })
  useProjectStore.getState().completeTextLayout()
  const curved = getProfileBounds(resolveFeatureInstance(useProjectStore.getState().project, 'run')!.sketch.profile)

  startLayout('arc')
  useProjectStore.getState().updateTextLayout(null)
  assert(useProjectStore.getState().completeTextLayout().length === 1, 'straightening applies')

  const straight = getProfileBounds(resolveFeatureInstance(useProjectStore.getState().project, 'run')!.sketch.profile)
  assert(runLayout() === null, 'the run is straight again')
  assert(
    Math.abs(straight.minX - curved.minX) < 1e-6 && Math.abs(straight.minY - curved.minY) < 1e-6,
    `it stays put, ${curved.minX},${curved.minY} -> ${straight.minX},${straight.minY}`,
  )
  console.log('straightening keeps the run where it is: PASSED')
}

function testPathModeNeedsAGuideAndCommitsFromThePanel() {
  resetStore()
  startLayout()
  useProjectStore.getState().updateTextLayout(pathLayout)

  // Without a guide there is no baseline, and committing anyway would quietly
  // produce straight text instead of text on a path.
  assert(useProjectStore.getState().completeTextLayout().length === 0, 'it cannot commit without a guide')
  assert(runLayout() === null, 'and the run is untouched while refusing')

  useProjectStore.getState().setTextLayoutGuide('guide')
  const layout = pendingLayout().layout
  assert(layout?.kind === 'path', 'the guide is baked into a path layout')
  assert(layout.path.segments.length > 0, 'the guide outline is copied in')
  assert(layout.endOffset > 0, 'a new guide defaults to its whole length')

  const ids = useProjectStore.getState().completeTextLayout()
  assert(ids.length === 1, 'the panel applies the baseline')
  assert(runLayout()?.kind === 'path', 'the run carries its path layout')
  console.log('path mode needs a guide and commits from the panel: PASSED')
}

function testTheBakedGuideDoesNotAliasTheGuideFeature() {
  resetStore()
  startLayout()
  useProjectStore.getState().updateTextLayout(pathLayout)
  useProjectStore.getState().setTextLayoutGuide('guide')

  const layout = pendingLayout().layout
  assert(layout?.kind === 'path', 'path layout expected')
  const guide = resolveFeatureInstance(useProjectStore.getState().project, 'guide')
  assert(guide, 'guide should resolve')
  assert(layout.path !== guide.sketch.profile, 'the baked path is a copy, not the guide profile itself')
  assert(layout.path.start !== guide.sketch.profile.start, 'points are copied too, not shared')
  console.log('the baked guide is a real copy: PASSED')
}

function testSwitchingModesRestartsTheGesture() {
  resetStore()
  startLayout()
  useProjectStore.getState().updateTextLayout(arcLayout)
  useProjectStore.getState().setTextLayoutCenter({ x: 10, y: 10 })
  assert(pendingLayout().center !== null, 'the arc centre is parked')

  useProjectStore.getState().updateTextLayout(pathLayout)
  assert(pendingLayout().center === null, 'switching layout drops the centre picked for the old one')

  useProjectStore.getState().setTextLayoutGuide('guide')
  useProjectStore.getState().updateTextLayout(null)
  assert(pendingLayout().guideId === null, 'going back to horizontal drops the guide')
  console.log('switching modes restarts the gesture: PASSED')
}

function testLayoutSurvivesAProjectRoundTripWithoutAliasing() {
  resetStore()
  startLayout()
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

testFlippingDirectionMovesTheRunToTheBottom()
testFlippingDirectionKeepsSidewaysBias()
testArcAppliesToTheSelectedRunOnceItsCentreIsPicked()
testApplyingResizesTheFrameToTheBentRun()
testReopeningKeepsTheRunsCurrentBaseline()
testStraighteningKeepsTheRunWhereItIs()
testPathModeNeedsAGuideAndCommitsFromThePanel()
testTheBakedGuideDoesNotAliasTheGuideFeature()
testSwitchingModesRestartsTheGesture()
testLayoutSurvivesAProjectRoundTripWithoutAliasing()
testCloneTextFeatureDataDeepCopiesAPathLayout()
