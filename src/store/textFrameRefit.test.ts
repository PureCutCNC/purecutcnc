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
 * Text frames are re-fitted when the run's own metrics change (issue #722).
 *
 * A text feature stores no glyph geometry: `resolveTextFeatureShapes` rebuilds a
 * template and maps its bbox onto the frame, so the frame is the only thing
 * setting the run's proportions. Editing the string used to leave the old frame
 * in place, which squeezed or smeared the glyphs by `oldNaturalWidth /
 * newNaturalWidth` — a squashed letterform cuts as a squashed letterform.
 *
 *   1. A string edit preserves each glyph's aspect ratio.
 *   2. A deliberately stretched frame keeps its stretch factor across an edit.
 *   3. Style, font and size edits go through the same path.
 *   4. Linked instances re-resolve without moving.
 *   5. The refit declines rather than emitting garbage for a degenerate frame.
 *
 * Run with: npx tsx src/store/textFrameRefit.test.ts
 */

import {
  defaultFontIdForStyle,
  defaultTextToolConfig,
  getTextFrameProfile,
  refitTextFrameProfile,
  resolveTextFeatureShapes,
} from '../text'
import {
  getProfileBounds,
  newProject,
  profileVertices,
  rectProfile,
  type Point,
  type Project,
  type TextFeatureData,
} from '../types/project'
import { useProjectStore } from './projectStore'
import type { ProjectStore } from './types'
import { buildCopiedFeatures } from './helpers/copyFeatures'
import { createFeatureInstance } from './helpers/featureDefinitions'
import { resolveFeatureInstance } from './helpers/resolveFeatures'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

/** Frames are solved from font metrics, so compare to a tolerance, not exactly. */
function assertClose(actual: number, expected: number, message: string, tolerance = 1e-6): void {
  assert(
    Math.abs(actual - expected) <= tolerance,
    `${message} (expected ${expected}, got ${actual})`,
  )
}

function resetStore(project?: Project): void {
  useProjectStore.setState({
    project: project ?? newProject(),
    selection: { selectedFeatureIds: [], selectedTabIds: [], selectedClampIds: [] },
    history: { past: [], future: [], transactionStart: null },
  } as unknown as Partial<ProjectStore>)
}

function getProject(): Project {
  return useProjectStore.getState().project
}

function placeText(text: string, at: Point): string {
  useProjectStore.getState().startAddTextPlacement({ ...defaultTextToolConfig('mm'), text })
  const ids = useProjectStore.getState().placePendingTextAt(at)
  assert(ids.length === 1, 'placePendingTextAt creates exactly one feature')
  return ids[0]
}

function textDataOf(featureId: string): TextFeatureData {
  const project = getProject()
  const instance = project.features.find((f) => f.id === featureId)!
  const text = project.featureDefinitions[instance.definitionId].text
  assert(text, 'text feature definition carries text data')
  return text
}

/**
 * The frame in the basis `resolveTextFeatureShapes` actually maps through: the
 * first profile vertex is the origin the template's (minX, minY) lands on, and
 * the run's width and height run along the edges to the next and last vertices.
 */
function frameBasis(featureId: string): { origin: Point; width: number; height: number } {
  const feature = resolveFeatureInstance(getProject(), featureId)
  assert(feature, 'text feature resolves')
  const vertices = profileVertices(feature.sketch.profile)
  assert(vertices.length >= 4, 'a text frame has four corners')
  return {
    origin: vertices[0],
    width: Math.hypot(vertices[1].x - vertices[0].x, vertices[1].y - vertices[0].y),
    height: Math.hypot(vertices[3].x - vertices[0].x, vertices[3].y - vertices[0].y),
  }
}

/** Rendered bounds of one glyph, across every contour or stroke it is drawn from. */
function glyphBox(featureId: string, char: string): { width: number; height: number } {
  const feature = resolveFeatureInstance(getProject(), featureId)
  assert(feature, 'text feature resolves')
  const boxes = resolveTextFeatureShapes(feature)
    .filter((shape) => shape.glyphChar === char)
    .map((shape) => getProfileBounds(shape.profile))
  assert(boxes.length > 0, `the run draws a "${char}"`)
  const bounds = boxes.reduce((acc, next) => ({
    minX: Math.min(acc.minX, next.minX),
    maxX: Math.max(acc.maxX, next.maxX),
    minY: Math.min(acc.minY, next.minY),
    maxY: Math.max(acc.maxY, next.maxY),
  }))
  return { width: bounds.maxX - bounds.minX, height: bounds.maxY - bounds.minY }
}

/** The run's own bounds, before any frame maps it — its natural aspect. */
function naturalSize(text: string, overrides: Partial<TextFeatureData> = {}): { width: number; height: number } {
  const bounds = getProfileBounds(getTextFrameProfile(
    { ...defaultTextToolConfig('mm'), text, ...overrides, layout: null },
    { x: 0, y: 0 },
  ))
  return { width: bounds.maxX - bounds.minX, height: bounds.maxY - bounds.minY }
}

// ── 1. A string edit preserves each glyph's aspect ratio ───────────

{
  resetStore(newProject())
  const id = placeText('AB', { x: 10, y: 10 })
  const placedA = glyphBox(id, 'A')
  assertClose(placedA.width / placedA.height, 1, 'the placed "A" is drawn at its natural aspect')

  useProjectStore.getState().updateFeature(id, { text: { ...textDataOf(id), text: 'ABCDEFGH' } })

  const longer = frameBasis(id)
  const natural = naturalSize('ABCDEFGH')
  assertClose(longer.width, natural.width, 'the frame widens to the longer run\'s natural width')
  assertClose(longer.height, 10, 'the frame keeps its height — a text size is a height')
  assertClose(longer.origin.x, 10, 'the run grows to the right from its own origin')
  assertClose(longer.origin.y, 10, 'the run does not move vertically')

  // The regression this test exists for: the old frame squeezed the glyphs by
  // 21 / 92.6, so this "A" came out 2.27mm wide in a 10mm-tall run.
  const editedA = glyphBox(id, 'A')
  assertClose(editedA.width, placedA.width, 'the "A" keeps its width across a string edit')
  assertClose(editedA.height, placedA.height, 'the "A" keeps its height across a string edit')

  // And back the other way, which used to smear the letters apart.
  useProjectStore.getState().updateFeature(id, { text: { ...textDataOf(id), text: 'AB' } })
  const shorter = glyphBox(id, 'A')
  assertClose(shorter.width, placedA.width, 'shortening the string does not smear the "A"')
  assertClose(frameBasis(id).width, naturalSize('AB').width, 'the frame narrows back to natural')
}

// ── 2. A deliberate stretch survives the edit ──────────────────────

{
  resetStore(newProject())
  const id = placeText('AB', { x: 10, y: 10 })
  const natural = naturalSize('AB')
  assertClose(frameBasis(id).width, natural.width, 'a fresh frame is natural')

  // Dragging a frame corner is a legitimate way to stretch text, and that
  // intent has to survive an edit rather than being snapped away.
  const stretched = natural.width + 10
  useProjectStore.getState().moveFeatureControl(
    id,
    { kind: 'anchor', index: 1 },
    { x: 10 + stretched, y: 10 },
  )
  const factor = stretched / natural.width
  assertClose(frameBasis(id).width, stretched, 'the corner drag stretched the frame')
  const stretchedA = glyphBox(id, 'A')
  assertClose(stretchedA.width, 10 * factor, 'the stretched "A" is drawn wider')
  assertClose(stretchedA.height, 10, 'the stretch is horizontal only')

  useProjectStore.getState().updateFeature(id, { text: { ...textDataOf(id), text: 'ABCDEFGH' } })

  assertClose(
    frameBasis(id).width,
    naturalSize('ABCDEFGH').width * factor,
    'the edited frame is the new natural width times the deliberate stretch',
  )
  const editedA = glyphBox(id, 'A')
  assertClose(editedA.width, stretchedA.width, 'the deliberate stretch is preserved exactly')
  assertClose(editedA.height, stretchedA.height, 'the height is still untouched')
}

// ── 3. Style, font and size edits take the same path ───────────────

{
  resetStore(newProject())
  const id = placeText('AB', { x: 0, y: 0 })
  const before = frameBasis(id)

  // Style carries a font with it, the way the properties panel commits it.
  const outline = { style: 'outline' as const, fontId: defaultFontIdForStyle('outline') }
  useProjectStore.getState().updateFeature(id, { text: { ...textDataOf(id), ...outline } })
  const outlined = frameBasis(id)
  const outlineNatural = naturalSize('AB', outline)
  assert(
    Math.abs(outlineNatural.width / outlineNatural.height - before.width / before.height) > 1e-3,
    'the outline font really does have a different natural aspect (otherwise this proves nothing)',
  )
  assertClose(outlined.height, before.height, 'a style edit keeps the frame height')
  assertClose(
    outlined.width / outlined.height,
    outlineNatural.width / outlineNatural.height,
    'a style edit re-fits an untouched frame to the new natural aspect',
  )

  // A font swap within the same style goes through it too.
  const otherFont = { ...textDataOf(id), fontId: 'droid_serif_bold' as const }
  useProjectStore.getState().updateFeature(id, { text: otherFont })
  const serif = frameBasis(id)
  const serifNatural = naturalSize('AB', otherFont)
  assertClose(
    serif.width / serif.height,
    serifNatural.width / serifNatural.height,
    'a font edit re-fits an untouched frame to the new natural aspect',
  )

  // A size edit scales the template uniformly, so the natural aspect does not
  // move and the frame — whose height is the invariant — is left alone.
  useProjectStore.getState().updateFeature(id, { text: { ...textDataOf(id), size: 25 } })
  const resized = frameBasis(id)
  assertClose(resized.width, serif.width, 'a size edit leaves the frame width alone')
  assertClose(resized.height, serif.height, 'a size edit leaves the frame height alone')
}

// ── 4. Linked instances re-resolve without moving ──────────────────

{
  resetStore(newProject())
  const originalId = placeText('AB', { x: 10, y: 10 })
  const project = getProject()
  const resolvedOriginal = resolveFeatureInstance(project, originalId)
  assert(resolvedOriginal, 'original text feature resolves')

  const copyDraft = buildCopiedFeatures(
    [resolvedOriginal], project.features, 200, 0, 1, project.featureDefinitions, 'reference',
  )[0]
  const copy = createFeatureInstance(copyDraft, copyDraft.definitionId, copyDraft.transform)
  resetStore({ ...project, features: [...project.features, copy] })

  const originBefore = frameBasis(originalId).origin
  const copyOriginBefore = frameBasis(copy.id).origin
  const placedA = glyphBox(originalId, 'A')

  // Edit through the copy, so the definition is reached from the sibling row.
  useProjectStore.getState().updateFeature(copy.id, { text: { ...textDataOf(copy.id), text: 'ABCDEFGH' } })

  for (const [label, id, expected] of [
    ['original', originalId, originBefore],
    ['copy', copy.id, copyOriginBefore],
  ] as const) {
    const basis = frameBasis(id)
    assertClose(basis.origin.x, expected.x, `the ${label} does not move in x`)
    assertClose(basis.origin.y, expected.y, `the ${label} does not move in y`)
    assertClose(basis.width, naturalSize('ABCDEFGH').width, `the ${label} frame re-fits`)
    const editedA = glyphBox(id, 'A')
    assertClose(editedA.width, placedA.width, `the ${label} keeps the glyph aspect`)
    assertClose(editedA.height, placedA.height, `the ${label} keeps the glyph height`)
  }
}

// ── 5. Degenerate frames are declined, not mangled ─────────────────

{
  const before = { ...defaultTextToolConfig('mm'), text: 'AB', layout: null }
  const after = { ...before, text: 'ABCDEFGH' }

  const zeroHeight = rectProfile(0, 0, 21, 0)
  assert(
    refitTextFrameProfile(zeroHeight, before, after) === zeroHeight,
    'a zero-area frame is returned untouched rather than scaled by infinity',
  )

  const line = { start: { x: 0, y: 0 }, segments: [{ type: 'line' as const, to: { x: 10, y: 0 } }], closed: false }
  assert(
    refitTextFrameProfile(line, before, after) === line,
    'a profile with no four corners is returned untouched',
  )

  const square = rectProfile(0, 0, 21, 10)
  assert(
    refitTextFrameProfile(square, before, before) === square,
    'an unchanged run leaves its frame alone',
  )
}

console.log('✓ All text frame refit tests passed.')
