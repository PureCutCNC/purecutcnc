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

import { IDENTITY_MATRIX, getProfileBounds, newProject, rectProfile, type Project, type TextLayout } from '../types/project'
import { projectWithFeatures } from '../test/projectFixtures'
import { normalizeProject } from './helpers/projectFormat'
import { resolveFeatureInstance } from './helpers/resolveFeatures'
import { getFeatureGeometryBounds } from '../text'
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
      text: { text: 'ABC', style: 'skeleton', fontId: 'simple_stroke', size: 10 },
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
  return resolveFeatureInstance(useProjectStore.getState().project, 'run')?.textLayout ?? null
}

const arcLayout: Extract<TextLayout, { kind: 'arc' }> = {
  kind: 'arc', center: { x: 0, y: 0 }, radius: 30, angleDegrees: 270, sweepDegrees: 120,
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
    kind: 'arc', center: { x: 0, y: 0 }, radius: 40, angleDegrees: 270, sweepDegrees: 120,
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
    kind: 'arc', center: { x: 0, y: 0 }, radius: 40, angleDegrees: 300, sweepDegrees: 120,
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
  useProjectStore.getState().updateTextLayout(arcLayout)
  // The pivot of rectProfile(200, 200, 30, 10) is (215, 205), so this derives 100.
  useProjectStore.getState().setTextLayoutCenter({ x: 215, y: 305 })
  useProjectStore.getState().completeTextLayout()

  startLayout('arc')
  const reopened = pendingLayout().layout
  assert(reopened?.kind === 'arc' && Math.abs(reopened.radius - 100) < 1e-6, "reopening loads the run's own arc")
  console.log('reopening keeps the current baseline: PASSED')
}

/**
 * Curving and straightening round-trips to the original position. The frame of
 * a curved run is derived from its bent template, so dropping the layout hands
 * the run back its untouched definition frame rather than stranding it wherever
 * the arc happened to put it.
 */
function testStraighteningRestoresTheOriginalPosition() {
  resetStore()
  const before = getProfileBounds(resolveFeatureInstance(useProjectStore.getState().project, 'run')!.sketch.profile)

  startLayout('arc')
  useProjectStore.getState().updateTextLayout(arcLayout)
  useProjectStore.getState().setTextLayoutCenter({ x: 300, y: 300 })
  useProjectStore.getState().completeTextLayout()
  const curved = getProfileBounds(resolveFeatureInstance(useProjectStore.getState().project, 'run')!.sketch.profile)
  assert(Math.abs(curved.minX - before.minX) > 1, 'the run actually moved onto the arc')

  startLayout('arc')
  useProjectStore.getState().updateTextLayout(null)
  assert(useProjectStore.getState().completeTextLayout().length === 1, 'straightening applies')

  const after = getProfileBounds(resolveFeatureInstance(useProjectStore.getState().project, 'run')!.sketch.profile)
  assert(runLayout() === null, 'the run is straight again')
  assert(
    Math.abs(after.minX - before.minX) < 1e-6 && Math.abs(after.minY - before.minY) < 1e-6,
    `it returns to where it started, ${before.minX},${before.minY} -> ${after.minX},${after.minY}`,
  )
  console.log('straightening restores the original position: PASSED')
}

/**
 * The run must land where the preview drew it, including on a run whose
 * instance transform is not identity.
 *
 * Preview and commit each did their own world-to-local conversion for a while,
 * which agreed only for an untransformed run — so applying an arc to a moved
 * copy threw the text across the sketch. Both now go through
 * `localTextLayout`, and this pins the property that made the divergence
 * visible: the committed glyphs stay centred on the world point that was
 * picked.
 */
function testTheAppliedRunLandsOnThePickedCentre() {
  for (const transform of [
    IDENTITY_MATRIX,
    { ...IDENTITY_MATRIX, e: 120, f: -45 },
  ]) {
    resetStore()
    useProjectStore.setState((s) => ({
      project: {
        ...s.project,
        features: s.project.features.map((row) => (row.id === 'run' ? { ...row, transform } : row)),
      },
    }))

    const center = { x: 100, y: 100 }
    // Radius is derived from the run's pivot, which moves with the instance
    // transform — so the expectation is derived the same way.
    const before = getProfileBounds(resolveFeatureInstance(useProjectStore.getState().project, 'run')!.sketch.profile)
    const pivot = { x: (before.minX + before.maxX) / 2, y: (before.minY + before.maxY) / 2 }
    const radius = Math.hypot(pivot.x - center.x, pivot.y - center.y)
    startLayout('arc')
    useProjectStore.getState().updateTextLayout({ ...arcLayout, sweepDegrees: 90 })
    useProjectStore.getState().setTextLayoutCenter(center)
    useProjectStore.getState().completeTextLayout()

    const run = resolveFeatureInstance(useProjectStore.getState().project, 'run')!
    const bounds = getFeatureGeometryBounds(run)
    const midX = (bounds.minX + bounds.maxX) / 2
    assert(
      Math.abs(midX - center.x) < 6,
      `run should stay centred on the picked point, got ${midX} for e=${transform.e}`,
    )
    // cw sits the run on top of the circle, so it is a radius above the centre.
    assert(
      Math.abs(bounds.maxY - (center.y - radius)) < 6,
      `run should sit on the circle, got ${bounds.maxY} for e=${transform.e}`,
    )
  }
  console.log('the applied run lands on the picked centre: PASSED')
}

/**
 * Radius is derived from the pivot-to-centre distance, the way
 * `planFeatureDistribution` derives a radial distribution's radius from where
 * its source already sits. Picking the centre is the whole gesture; there is no
 * radius to type.
 */
function testPickingTheCentreDerivesTheRadius() {
  resetStore()
  startLayout('arc')
  useProjectStore.getState().updateTextLayout({ ...arcLayout, radius: 999 })

  // The run's frame is rectProfile(200, 200, 30, 10), so its pivot is (215, 205).
  useProjectStore.getState().setTextLayoutCenter({ x: 215, y: 305 })
  const layout = pendingLayout().layout
  assert(layout?.kind === 'arc', 'still an arc')
  assert(Math.abs(layout.radius - 100) < 1e-6, `radius should be the pivot distance, got ${layout.radius}`)

  // Moving the centre re-derives it rather than keeping the first pick.
  useProjectStore.getState().setTextLayoutCenter({ x: 215, y: 245 })
  const moved = pendingLayout().layout
  assert(moved?.kind === 'arc' && Math.abs(moved.radius - 40) < 1e-6, `re-derived, got ${moved?.kind === 'arc' ? moved.radius : 'n/a'}`)
  console.log('picking the centre derives the radius: PASSED')
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
  const layout = resolveFeatureInstance(reloaded, 'run')?.textLayout
  assert(layout?.kind === 'path', 'the layout survives a save and load')
  assert(layout.path.segments.length > 0, 'the baked guide survives too')

  // The stored row and the resolved copy must not share one layout object, or
  // editing either would silently rewrite the other.
  const row = reloaded.features.find((feature) => feature.id === 'run')!
  assert(row.textLayout, 'the instance row carries the layout')
  assert(row.textLayout !== layout, 'row and resolved copy hold separate layout objects')
  console.log('layout survives a round trip without aliasing: PASSED')
}

/**
 * The reason the baseline lives on the instance: two copies share one text
 * definition, so curving one must leave its siblings straight.
 */
function testCurvingOneCopyLeavesTheOtherStraight() {
  resetStore()
  // A second instance of the *same* definition — the default copy mode.
  useProjectStore.setState((s) => {
    const source = s.project.features.find((feature) => feature.id === 'run')!
    return {
      project: {
        ...s.project,
        features: [...s.project.features, { ...source, id: 'run2', name: 'ABC copy' }],
        featureTree: [...s.project.featureTree, { type: 'feature' as const, featureId: 'run2' }],
      },
    }
  })
  const project = useProjectStore.getState().project
  const a = project.features.find((feature) => feature.id === 'run')!
  const b = project.features.find((feature) => feature.id === 'run2')!
  assert(a.definitionId === b.definitionId, 'the copies share one definition')

  startLayout('arc')
  useProjectStore.getState().updateTextLayout(arcLayout)
  useProjectStore.getState().setTextLayoutCenter({ x: 100, y: 100 })
  useProjectStore.getState().completeTextLayout()

  const after = useProjectStore.getState().project
  assert(resolveFeatureInstance(after, 'run')?.textLayout?.kind === 'arc', 'the edited copy curves')
  assert(resolveFeatureInstance(after, 'run2')?.textLayout == null, 'its sibling stays straight')
  // And they still share the shape, so editing the text still propagates.
  assert(
    after.features.find((f) => f.id === 'run')!.definitionId
      === after.features.find((f) => f.id === 'run2')!.definitionId,
    'curving one copy does not detach it from the shared definition',
  )
  console.log('curving one copy leaves the other straight: PASSED')
}

testFlippingDirectionMovesTheRunToTheBottom()
testFlippingDirectionKeepsSidewaysBias()
testArcAppliesToTheSelectedRunOnceItsCentreIsPicked()
testApplyingResizesTheFrameToTheBentRun()
testReopeningKeepsTheRunsCurrentBaseline()
testStraighteningRestoresTheOriginalPosition()
testTheAppliedRunLandsOnThePickedCentre()
testPickingTheCentreDerivesTheRadius()
testPathModeNeedsAGuideAndCommitsFromThePanel()
testTheBakedGuideDoesNotAliasTheGuideFeature()
testSwitchingModesRestartsTheGesture()
testLayoutSurvivesAProjectRoundTripWithoutAliasing()
testCurvingOneCopyLeavesTheOtherStraight()
