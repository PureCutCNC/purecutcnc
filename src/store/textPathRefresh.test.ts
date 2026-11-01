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
 * Text on a path — the optional source link and Refresh (issue #1112 slice E).
 *
 * The path stays baked, so existing runs render and open unchanged. When the
 * run remembers its source, Refresh copies the edited source again; when the
 * source is gone, the state reports the reason rather than silently doing
 * nothing.
 *
 * Run with: npx tsx src/store/textPathRefresh.test.ts
 */

import {
  newProject,
  rectProfile,
  type CannedShapeData,
  type CannedShapeParams,
  type Project,
  type TextFeatureData,
  type TextLayout,
} from '../types/project'
import { projectWithFeatures } from '../test/projectFixtures'
import { getFeatureGeometryProfiles } from '../text'
import { defaultGearCreationParams } from '../sketch/gearProfile'
import { resolveCannedShapeProfiles } from '../cannedShapes'
import { resolveFeatureInstance } from './helpers/resolveFeatures'
import { textPathRefreshState } from './helpers/textPathSource'
import { useProjectStore } from './projectStore'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\n  Expected: ${JSON.stringify(expected)}\n  Actual: ${JSON.stringify(actual)}`)
  }
}

const TEXT: TextFeatureData = {
  text: 'PATH',
  style: 'skeleton',
  fontId: 'simple_stroke',
  size: 10,
}

function resetStore(project?: Project): void {
  useProjectStore.setState({
    project: project ?? newProject(),
    selection: {
      selectedFeatureIds: [],
      selectedFeatureId: null,
      selectedTabIds: [],
      selectedClampIds: [],
      selectedNode: null,
      mode: 'feature' as const,
      sketchEditTool: null,
      activeControl: null,
      hoveredFeatureId: null,
      groupFolderId: null,
    },
    history: { past: [], future: [], transactionStart: null },
    pendingAdd: null,
    pendingMove: null,
    pendingTransform: null,
    pendingOffset: null,
    pendingShapeAction: null,
    pendingTextLayout: null,
    sketchEditSession: null,
  } as never)
}

function select(featureId: string): void {
  useProjectStore.setState((s) => ({
    selection: { ...s.selection, selectedFeatureId: featureId, selectedFeatureIds: [featureId] },
  } as never))
}

function storedLayout(featureId: string): TextLayout | null {
  const feature = resolveFeatureInstance(useProjectStore.getState().project, featureId)
  assert(feature, `feature ${featureId} resolves`)
  return feature.textLayout ?? null
}

/** The same sequence the Properties Refresh button runs. */
function refresh(featureId: string, guideId: string): string[] {
  select(featureId)
  const store = useProjectStore.getState()
  store.startTextLayout('path')
  assert(useProjectStore.getState().pendingTextLayout, 'refresh opens the layout session')
  useProjectStore.getState().setTextLayoutGuide(guideId)
  return useProjectStore.getState().completeTextLayout()
}

function guideWithPathRun(): { project: Project; guideId: string; runId: string } {
  const project = projectWithFeatures(newProject(), [
    {
      id: 'guide',
      name: 'Guide',
      kind: 'rect',
      operation: 'add',
      visible: true,
      locked: false,
      z_top: 5,
      z_bottom: 0,
      folderId: null,
      text: null,
      stl: null,
      sketch: {
        origin: { x: 0, y: 0 },
        orientationAngle: 0,
        dimensions: [],
        constraints: [],
        profile: rectProfile(0, 0, 40, 20),
      },
    },
    {
      id: 'run',
      name: 'PATH',
      kind: 'text',
      operation: 'subtract',
      visible: true,
      locked: false,
      z_top: 5,
      z_bottom: 0,
      folderId: null,
      stl: null,
      text: TEXT,
      sketch: {
        origin: { x: 0, y: 0 },
        orientationAngle: 90,
        dimensions: [],
        constraints: [],
        profile: rectProfile(100, 100, 30, 10),
      },
    },
  ])
  return { project, guideId: 'guide', runId: 'run' }
}

// ── A fresh path run remembers its source ──────────────────────────

{
  const { project, guideId, runId } = guideWithPathRun()
  resetStore(project)
  assertEqual(refresh(runId, guideId), [runId], 'the path applies to the run')

  const layout = storedLayout(runId)
  assert(layout?.kind === 'path', 'the run is on a path')
  assertEqual(layout.sourceFeatureId, guideId, 'the source id is remembered')
  const resolved = resolveFeatureInstance(useProjectStore.getState().project, runId)
  assert(resolved, 'run resolves')
  const refreshState = textPathRefreshState(useProjectStore.getState().project, resolved)
  assertEqual(refreshState.canRefresh, true, 'Refresh is available while the source exists')
}

// ── Refresh re-reads an edited source ──────────────────────────────

{
  const { project, guideId, runId } = guideWithPathRun()
  resetStore(project)
  refresh(runId, guideId)
  const runBefore = resolveFeatureInstance(useProjectStore.getState().project, runId)
  assert(runBefore, 'run resolves')
  const before = getFeatureGeometryProfiles(runBefore)

  const guide = resolveFeatureInstance(useProjectStore.getState().project, guideId)
  assert(guide, 'guide resolves')
  useProjectStore.getState().updateFeature(guideId, {
    sketch: { ...guide.sketch, profile: rectProfile(0, 0, 120, 20) },
  })

  assertEqual(refresh(runId, guideId), [runId], 'refresh applies')
  const layout = storedLayout(runId)
  assert(layout?.kind === 'path', 'still a path')
  assertEqual(layout.path, rectProfile(0, 0, 120, 20), 'the baked path is the edited source again')
  const runAfter = resolveFeatureInstance(useProjectStore.getState().project, runId)
  assert(runAfter, 'run still resolves')
  const after = getFeatureGeometryProfiles(runAfter)
  assert(JSON.stringify(after) !== JSON.stringify(before), 'the rendered run moved with the edited source')
}

// ── A vanished source refuses with a reason ───────────────────────

{
  const { project, guideId, runId } = guideWithPathRun()
  resetStore(project)
  refresh(runId, guideId)
  useProjectStore.getState().deleteFeature(guideId)

  const resolved = resolveFeatureInstance(useProjectStore.getState().project, runId)
  assert(resolved, 'run still resolves')
  const state = textPathRefreshState(useProjectStore.getState().project, resolved)
  assertEqual(state, { canRefresh: false, reason: 'missing-source' }, 'a vanished source is refused with a reason')
  const layout = storedLayout(runId)
  assert(layout?.kind === 'path' && layout.path.segments.length > 0, 'the run still renders its baked path')
}

// ── A run wrapped before the source id existed is unchanged ───────

{
  const oldPathLayout: TextLayout = {
    kind: 'path',
    path: rectProfile(0, 0, 40, 20),
    startOffset: 0,
    endOffset: 40,
    anchor: 'center',
    fit: 'natural',
    reversed: false,
    orientation: 'follow',
  }
  const project = projectWithFeatures(newProject(), [
    {
      id: 'old-run',
      name: 'PATH',
      kind: 'text',
      operation: 'subtract',
      visible: true,
      locked: false,
      z_top: 5,
      z_bottom: 0,
      folderId: null,
      stl: null,
      text: TEXT,
      textLayout: oldPathLayout,
      sketch: {
        origin: { x: 0, y: 0 },
        orientationAngle: 90,
        dimensions: [],
        constraints: [],
        profile: rectProfile(100, 100, 30, 10),
      },
    },
  ])
  resetStore(project)
  const oldRun = resolveFeatureInstance(project, 'old-run')
  assert(oldRun, 'old run resolves')
  const before = getFeatureGeometryProfiles(oldRun)
  const state = textPathRefreshState(project, oldRun)
  assertEqual(state, { canRefresh: false, reason: 'no-source' }, 'no source id means no Refresh')

  const file = useProjectStore.getState().saveProject()
  useProjectStore.getState().openProjectFromText(file, null)
  const reloaded = resolveFeatureInstance(useProjectStore.getState().project, 'old-run')
  assert(reloaded, 'the old run still resolves')
  assertEqual(getFeatureGeometryProfiles(reloaded), before, 'an old path run still renders the same')
  assertEqual(storedLayout('old-run')?.kind, 'path', 'the old baseline survives the round trip')
}

// ── The source id survives save and load ──────────────────────────

{
  const { project, guideId, runId } = guideWithPathRun()
  resetStore(project)
  refresh(runId, guideId)

  const file = useProjectStore.getState().saveProject()
  const saved = JSON.parse(file) as Project
  const savedInstance = saved.features.find((feature) => feature.id === runId)
  assert(savedInstance, 'the run is saved')
  assert(
    savedInstance.textLayout?.kind === 'path' && savedInstance.textLayout.sourceFeatureId === guideId,
    'the source id is in the file',
  )

  useProjectStore.getState().openProjectFromText(file, null)
  const layout = storedLayout(runId)
  assert(layout?.kind === 'path', 'still a path after load')
  assertEqual(layout.sourceFeatureId, guideId, 'the source id survives the round trip')
}

// ── Editing the run through its dialog is one undo step ───────────

{
  const { project, runId } = guideWithPathRun()
  resetStore(project)
  const historyBefore = useProjectStore.getState().history.past.length
  useProjectStore.getState().updateFeature(runId, {
    text: { ...TEXT, text: 'NEW', size: 12 },
    operation: 'add',
  })
  assertEqual(useProjectStore.getState().history.past.length, historyBefore + 1, 'an edit is one undo step')
  const run = resolveFeatureInstance(useProjectStore.getState().project, runId)
  assertEqual(run?.text?.text, 'NEW', 'the new text is stored')
  assertEqual(run?.text?.size, 12, 'the new height is stored')
  assertEqual(run?.operation, 'add', 'the dialog operation applies')
}

// ── A canned guide is the generated outline, never its frame ───────
//
// A canned shape stores only a rectangular placement frame in
// `definition.profile`; its ellipse, slot or gear outline is generated from the
// parameters. Wrapping the run around the frame would give a canned ellipse a
// four-line rectangular guide (issue #1112 DE2 review).

function cannedGuide(
  kind: string,
  params: CannedShapeParams,
): { project: Project; guideId: string; runId: string } {
  const project = projectWithFeatures(newProject(), [
    {
      id: 'guide',
      name: 'Guide',
      kind: 'composite',
      operation: 'add',
      visible: true,
      locked: false,
      z_top: 5,
      z_bottom: 0,
      folderId: null,
      text: null,
      stl: null,
      canned: { kind, params } as CannedShapeData,
      sketch: {
        origin: { x: 0, y: 0 },
        orientationAngle: 0,
        dimensions: [],
        constraints: [],
        profile: rectProfile(0, 0, 1, 1),
      },
    },
    {
      id: 'run',
      name: 'PATH',
      kind: 'text',
      operation: 'subtract',
      visible: true,
      locked: false,
      z_top: 5,
      z_bottom: 0,
      folderId: null,
      stl: null,
      text: TEXT,
      sketch: {
        origin: { x: 0, y: 0 },
        orientationAngle: 90,
        dimensions: [],
        constraints: [],
        profile: rectProfile(100, 100, 30, 10),
      },
    },
  ])
  return { project, guideId: 'guide', runId: 'run' }
}

function pickGuide(runId: string, guideId: string): TextLayout | null {
  select(runId)
  useProjectStore.getState().startTextLayout('path')
  useProjectStore.getState().setTextLayoutGuide(guideId)
  return useProjectStore.getState().pendingTextLayout?.layout ?? null
}

{
  const cases: Array<{ name: string; kind: string; params: CannedShapeParams }> = [
    { name: 'ellipse', kind: 'ellipse', params: { rx: 30, ry: 20 } },
    { name: 'slot', kind: 'slot', params: { length: 40, width: 12 } },
    {
      name: 'gear',
      kind: 'gear',
      params: { ...defaultGearCreationParams(20), outsideRadius: 20, boreDiameter: 6 },
    },
  ]

  for (const shape of cases) {
    const { project, guideId, runId } = cannedGuide(shape.kind, shape.params)
    resetStore(project)
    const layout = pickGuide(runId, guideId)
    assert(layout?.kind === 'path', `${shape.name}: a path layout is pending`)

    const guide = resolveFeatureInstance(useProjectStore.getState().project, guideId)
    assert(guide?.canned, `${shape.name}: the guide is canned`)
    const generated = resolveCannedShapeProfiles(guide)
    assert(generated.length > 0, `${shape.name}: the generator emits an outline`)
    assertEqual(layout.path, generated[0], `${shape.name}: the guide is the generated outline`)
    assert(
      JSON.stringify(layout.path) !== JSON.stringify(guide.sketch.profile),
      `${shape.name}: the placement frame must not be used as the guide`,
    )
  }
  console.log('a canned guide uses its generated outline: PASSED')
}

// ── Refresh keeps a custom span, clamped to the new source ─────────

{
  const { project, guideId, runId } = guideWithPathRun()
  resetStore(project)
  select(runId)
  useProjectStore.getState().startTextLayout('path')
  useProjectStore.getState().setTextLayoutGuide(guideId)
  const picked = useProjectStore.getState().pendingTextLayout?.layout
  assert(picked?.kind === 'path', 'the source opens as a path')
  useProjectStore.getState().updateTextLayout({ ...picked, startOffset: 5, endOffset: 15 })
  assertEqual(useProjectStore.getState().completeTextLayout(), [runId], 'the custom span applies')
  const before = storedLayout(runId)
  assert(before?.kind === 'path' && before.startOffset === 5 && before.endOffset === 15, 'custom offsets are stored')

  // The source shrinks to a perimeter of 8, so both custom offsets need
  // clamping. Refresh must keep them rather than resetting to 0–8.
  const guide = resolveFeatureInstance(useProjectStore.getState().project, guideId)
  assert(guide, 'the guide resolves')
  useProjectStore.getState().updateFeature(guideId, {
    sketch: { ...guide.sketch, profile: rectProfile(0, 0, 2, 2) },
  })

  assertEqual(refresh(runId, guideId), [runId], 'Refresh applies')
  const after = storedLayout(runId)
  assert(after?.kind === 'path', 'still a path')
  assertEqual(after.startOffset, 5, 'the custom start survives Refresh')
  assertEqual(after.endOffset, 8, 'the custom end is clamped to the new source length')
  console.log('Refresh keeps clamped custom offsets: PASSED')
}

console.log('✓ All text path refresh tests passed.')
