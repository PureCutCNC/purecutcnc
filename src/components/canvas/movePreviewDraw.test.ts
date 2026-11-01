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
 * The Move outline the canvas actually draws for a canned rotary feature (issue
 * #1112 rt6-d review).
 *
 * The review of rt6-d found the preview still able to disagree with the commit:
 * a typed distance was computed without the projection, the canvas drew the
 * clicked `toPoint` instead of the newer typed preview, and `runLivePointerPreview`
 * republished an unprojected point. All three are one question — *what point is
 * the outline drawn at?* — and that answer only exists in the canvas, so this
 * test executes the canvas' own move-preview pass (the technique
 * `aroundCanvasDraw.test.ts` uses) instead of a helper around it.
 *
 * 1. **The live preview wins over the stored target**: a typed distance replaces
 *    the clicked `toPoint`, so the drawn outline must follow the preview.
 * 2. **Every preview publisher projects**: the one setter the drag, the typed
 *    distance and a resnap all call stores the committed point, so a raw typed
 *    target cannot reach the outline unprojected.
 *
 * Run with: npx tsx src/components/canvas/movePreviewDraw.test.ts
 *
 * Named mutations:
 * - drawing `pendingMove.toPoint ?? currentMovePreviewPoint` again (the old
 *   priority) → the first section's outline stays at the click target;
 * - assigning `nextPoint` without `projectMovePreviewPoint` in the setter (the
 *   old setter) → the typed target is stored 400 units away instead of clamped;
 * - removing the clamp from `projectMovePreviewPoint`/`rotaryMoveDelta` → the
 *   same assertion reads 400;
 * - excluding `mode === 'copy'` from the projection (the old rule) → the copy
 *   section keeps the raw typed point and its assertion fails.
 */

/// <reference types="node" />
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import {
  defaultTool,
  newProject,
  roundStock,
  type Point,
  type Project,
  type Tool,
} from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { bundledMachines } from '../../machine/registry'
import { validateMachineDefinition } from '../../engine/gcode/types'
import { useProjectStore } from '../../store/projectStore'
import { switchWorkspaceFace } from '../../store/workspaceFace'
import { resolveFeatureInstances } from '../../store/helpers/resolveFeatures'
import { projectMovePreviewPoint } from '../../store/helpers/rotaryMove'
import { translateProfile } from './previewPrimitives'

const store = () => useProjectStore.getState()

const BAR_DIAMETER = 25
const BAR_LENGTH = 120

function rotaryProject(): Project {
  const base = newProject('Move preview draw', 'mm')
  base.meta.projectType = 'rotary'
  base.stock = roundStock(BAR_DIAMETER, BAR_LENGTH, 'x', { x: 0, y: 0 })
  const machine = validateMachineDefinition({
    ...structuredClone(bundledMachines()[0]),
    id: 'move-preview-draw',
    rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  })
  base.meta.machineDefinitions = [machine]
  base.meta.selectedMachineId = machine.id
  base.tools = [{ ...defaultTool('mm', 1), id: 'ball', type: 'ball_endmill', diameter: 3 } as Tool]
  return projectWithFeatures(base, [])
}

store().loadProject(rotaryProject())
assert.equal(switchWorkspaceFace('around'), true, 'the workspace enters Around')
const created = store().addRotarySolid({ kind: 'polygon', start: 20, length: 10, sides: 6, acrossFlats: 12 })
if (!created.ok) throw new Error(`the Polygon was refused: ${created.reason}`)
const polygonId = created.featureId
const project = store().project
const [resolvedPolygon] = resolveFeatureInstances(project, [polygonId])
assert.ok(resolvedPolygon, 'the Polygon resolves')

const source = readFileSync(new URL('./SketchCanvas.tsx', import.meta.url), 'utf8')

// ── the outline follows the live preview, not the clicked point ───
//
// A typed distance stores its own preview while `toPoint` still holds the
// point the click ended on. The drawn outline has to be the typed one.

const drawStart = source.indexOf('    const currentMovePreviewPoint =')
const drawEnd = source.indexOf('\n    if (pendingTransform) {', drawStart)
assert(drawStart > 0 && drawEnd > drawStart, 'the canvas move-preview pass is present')
const drawScript = ts.transpileModule(source.slice(drawStart, drawEnd), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText

const from = { x: resolvedPolygon.sketch.profile.start.x, y: resolvedPolygon.sketch.profile.start.y }
const clickTarget = { x: from.x + 15, y: from.y }
const typedPreview = { x: from.x + 40, y: from.y }

interface DrawnOutline {
  start: Point
  label: string
}

function drawMoveOutline(
  toPoint: Point | null,
  previewPoint: Point | null,
  distanceEdit: { kind: 'move' | 'copy'; distance: string } | null = { kind: 'move', distance: '400' },
): DrawnOutline[] {
  const drawn: DrawnOutline[] = []
  const pendingMove = {
    mode: 'move' as const,
    entityType: 'feature',
    entityIds: [polygonId],
    fromPoint: from,
    toPoint,
    session: 1,
  }
  const dependencies = {
    pendingMove,
    pendingMovePreviewPointRef: { current: previewPoint ? { point: previewPoint, session: 1 } : null },
    operationDimEditRef: { current: distanceEdit },
    // The pass reads the other pending sessions first; a move leaves them idle.
    pendingTransform: null,
    pendingTransformPreviewPointRef: { current: null },
    pendingOffset: null,
    pendingOffsetPreviewPointRef: { current: null },
    pendingOffsetRawPreviewPointRef: { current: null },
    project,
    vt: { scale: 1, offsetX: 0, offsetY: 0 },
    lockModeRef: { current: 'none' },
    lockModeGuideColor: () => '#888888',
    drawMoveGuide() {},
    drawPendingPoint() {},
    drawLineLengthMeasurement() {},
    drawBackdropImage() {},
    backdropImage: null,
    canvasPalette: {},
    resolveFeatureInstances,
    translateProfile,
    drawPreviewProfile: (_ctx: unknown, profile: { start: Point }, _vt: unknown, label: string) => {
      drawn.push({ start: { ...profile.start }, label })
    },
    copyCountDraft: '1',
    snap: { isActiveSnapPoint: () => false },
    ctx: {},
    drawClampFootprint() {},
    drawTabFootprint() {},
  }
  const draw = new Function(...Object.keys(dependencies), drawScript) as (...args: unknown[]) => void
  draw(...Object.values(dependencies))
  return drawn
}

const fromPreview = drawMoveOutline(clickTarget, typedPreview)
assert.equal(fromPreview.length, 1, 'one move preview outline is drawn')
assert.equal(fromPreview[0].label, 'Move preview', 'it is the move outline, not a copy')
assert.deepEqual(
  fromPreview[0].start,
  { x: resolvedPolygon.sketch.profile.start.x + (typedPreview.x - from.x), y: resolvedPolygon.sketch.profile.start.y },
  'the outline is drawn at the live preview point, not at the clicked toPoint',
)

// With no live preview the stored target is still the place to draw.
const fromTarget = drawMoveOutline(clickTarget, null)
assert.equal(fromTarget.length, 1, 'the stored target still draws an outline')
assert.deepEqual(
  fromTarget[0].start,
  { x: resolvedPolygon.sketch.profile.start.x + (clickTarget.x - from.x), y: resolvedPolygon.sketch.profile.start.y },
  'with nothing previewing, the stored target is the drawn place',
)

// Without an open distance edit the confirmed target wins over a stray
// preview point — the copy-count prompt keeps the pointer live, and the outline
// must not follow it away from the target the user confirmed.
const strayPointer = { x: from.x + 70, y: from.y + 12 }
const countPromptDraw = drawMoveOutline(clickTarget, strayPointer, null)
assert.deepEqual(
  countPromptDraw[0].start,
  { x: resolvedPolygon.sketch.profile.start.x + (clickTarget.x - from.x), y: resolvedPolygon.sketch.profile.start.y },
  'with no open distance edit, the confirmed target is the drawn place',
)

// The committed target is what the outline shows: the drawn dx matches the
// projection, so a typed target far past the bar end is drawn at the clamp.
const clampedPreview = projectMovePreviewPoint(
  project,
  { mode: 'move', entityType: 'feature', entityIds: [polygonId] },
  from,
  { x: from.x + 400, y: from.y },
)
assert.equal(clampedPreview.x, from.x + (BAR_LENGTH - 20 - 10), 'the typed target clamps to the bar end')
const clampedDraw = drawMoveOutline(clickTarget, clampedPreview)
assert.deepEqual(
  clampedDraw[0].start,
  { x: resolvedPolygon.sketch.profile.start.x + 90, y: resolvedPolygon.sketch.profile.start.y },
  'the outline is drawn where a typed 400-unit move will actually store the band',
)

// ── every preview publisher projects ───────────────────────
//
// The setter is the single door a drag, a typed distance and a resnap come
// through. Run the live setter's body: a raw typed point must leave it as the
// committed one.

const setterStart = source.indexOf('  const setPendingMovePreviewPointRef = useStableEvent(')
const setterBodyEnd = source.indexOf('    // Publish the point the move preview is drawn at', setterStart)
assert(setterStart > 0 && setterBodyEnd > setterStart, 'the move preview setter is present')
const setterScript = ts.transpileModule(`${source.slice(setterStart, setterBodyEnd)}  })
  return setPendingMovePreviewPointRef`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText

const pendingMove = {
  mode: 'move' as const,
  entityType: 'feature',
  entityIds: [polygonId],
  fromPoint: from,
  toPoint: clickTarget,
  session: 7,
}
const rawTypedPoint = { x: from.x + 400, y: from.y + 20 }
const previewRef: { current: { point: Point; session: number } | null } = { current: null }
const createSetter = new Function(
  'useStableEvent',
  'pendingMoveRef',
  'projectRef',
  'pendingMovePreviewPointRef',
  'projectMovePreviewPoint',
  'scheduleDraw',
  setterScript,
) as (...args: unknown[]) => (preview: { point: Point; session: number }) => void
const setPreview = createSetter(
  (fn: () => void) => fn,
  { current: pendingMove },
  { current: project },
  previewRef,
  projectMovePreviewPoint,
  () => {},
)
setPreview({ point: rawTypedPoint, session: 7 })
assert.ok(previewRef.current, 'the preview point is stored')
assert.deepEqual(
  previewRef.current.point,
  { x: from.x + (BAR_LENGTH - 20 - 10), y: from.y },
  'a raw typed point is stored as the committed one: along the bar, clamped, no across offset',
)
assert.equal(previewRef.current.session, 7, 'the preview keeps the move session')

// A copy is placed by the same projection (issue #1112 rt7-f): Frank's copy
// slid off the bar's axis while a move stayed on it, so the copy's preview is
// the copy's own landed place — along the bar, clamped, and on the axis for a
// Turn/Polygon, exactly as the move's is.
const copyRef: { current: { point: Point; session: number } | null } = { current: null }
const setCopyPreview = createSetter(
  (fn: () => void) => fn,
  { current: { ...pendingMove, mode: 'copy' as const } },
  { current: project },
  copyRef,
  projectMovePreviewPoint,
  () => {},
)
setCopyPreview({ point: rawTypedPoint, session: 7 })
assert.deepEqual(
  copyRef.current?.point,
  { x: from.x + (BAR_LENGTH - 20 - 10), y: from.y },
  'a raw typed point is stored as the committed place of the copy: along the bar, clamped, no across offset',
)

console.log('movePreviewDraw.test.ts passed')
