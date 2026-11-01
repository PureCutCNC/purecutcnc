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
 * Canned shapes — a definition that stores its kind and parameters and draws
 * its outlines on read, the way Text stores its string and draws glyphs
 * (issue #1112).
 *
 * The model owns three things here and nothing shape-specific:
 *   1. resolving the registered generator for the stored kind,
 *   2. assigning Add/Subtract from nesting depth (Text's rule),
 *   3. deriving the placement frame from the generated outlines.
 *
 * A new shape is a generator registered in `./generators`; the model, the
 * resolver, the format and Properties do not change. Shapes that expose their
 * parameters to the user also register an editor (`registerCannedShapeEditor`),
 * which is what the Properties "Edit <shape>…" button calls.
 */

import {
  getProfileBounds,
  rectProfile,
  sampleProfilePoints,
  type CannedShapeData,
  type FeatureOperation,
  type Matrix2D,
  type Point,
  type SketchFeature,
  type SketchProfile,
} from '../types/project'
import { transformProfile } from '../geometry/profile'
import { getCannedShapeEditor, getCannedShapeGenerator } from './registry'
import { cachedCannedShapeOutlines } from './cache'
import type {
  CannedShapeCapabilities,
  CannedShapeMesh,
  CannedShapeOutline,
  CannedShapeSummary,
} from './types'

export type {
  CannedShapeCapabilities,
  CannedShapeGenerator,
  CannedShapeMesh,
  CannedShapeOutline,
  CannedShapeSummary,
} from './types'
export type { CannedShapeSurface, CannedShapeZSource } from './zSource'
export {
  cannedShapeSurface,
  cannedShapeZIsOwned,
  cannedShapeZSource,
  uniqueCannedZSources,
} from './zSource'
export { defineCannedShape } from './types'
export { clearCannedShapeCache } from './cache'
export {
  getCannedShapeEditor,
  getCannedShapeGenerator,
  registerCannedShapeEditor,
  registerCannedShapeGenerator,
} from './registry'

/** The feature data a canned-shape read needs (a draft or a resolved row). */
export type CannedFeatureLike = Pick<SketchFeature, 'operation'> & {
  canned?: CannedShapeData | null
  /** Present on resolved rows only; drafts are already world-space. */
  transform?: Matrix2D
}

/** True when this feature draws itself from stored parameters. */
export function isCannedFeature(feature: { canned?: CannedShapeData | null } | null | undefined): boolean {
  return !!feature?.canned
}

/**
 * The parameter editor a feature offers, or `null` when it is not a canned
 * shape or its kind registered no editor.
 *
 * This is the whole rule behind "Edit {shape}…": Properties and the feature
 * context menu both read it, so no face can make one entry point offer what
 * the other refuses (issue #1112 rt7-c).
 */
export function cannedShapeEditorFor(
  feature: { canned?: CannedShapeData | null } | null | undefined,
): ((featureId: string) => void) | null {
  return feature?.canned ? getCannedShapeEditor(feature.canned.kind) : null
}

/** One generated outline with the operation the nesting rule gave it. */
export interface ResolvedCannedShape extends CannedShapeOutline {
  /** 0 = outermost, 1 = hole, 2 = island inside a hole, … */
  depth: number
  operation: FeatureOperation
}

function invertOperation(operation: FeatureOperation): FeatureOperation {
  if (operation === 'region' || operation === 'model' || operation === 'construction') return operation
  return operation === 'add' ? 'subtract' : 'add'
}

function pointInProfile(point: Point, profile: SketchProfile): boolean {
  if (!profile.closed) return false
  const points = sampleProfilePoints(profile)
  if (points.length < 3) return false

  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const xi = points[i].x
    const yi = points[i].y
    const xj = points[j].x
    const yj = points[j].y
    const intersects = yi > point.y !== yj > point.y
      && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi
    if (intersects) inside = !inside
  }
  return inside
}

/**
 * True when every sampled point of `inner` lies inside `outer`. A generator
 * emits nested contours in the same order as Text's outline fonts, so a contour
 * is "inside" another when its own boundary is enclosed; coincident contours
 * are not treated as nesting.
 */
function profileContainedIn(inner: SketchProfile, outer: SketchProfile): boolean {
  if (!inner.closed || !outer.closed) return false
  const points = sampleProfilePoints(inner)
  if (points.length < 3) return false
  return points.every((point) => pointInProfile(point, outer))
}

function nestingDepths(outlines: CannedShapeOutline[]): number[] {
  const closed = outlines.map((outline) => outline.profile.closed)
  return outlines.map((outline, index) => {
    if (!closed[index]) return 0
    let depth = 0
    for (let other = 0; other < outlines.length; other += 1) {
      if (other === index || !closed[other]) continue
      if (profileContainedIn(outline.profile, outlines[other].profile)) {
        depth += 1
      }
    }
    return depth
  })
}

/**
 * Apply an instance placement to generated geometry. Placement matrices are
 * similarities (translate / rotate / mirror / uniform scale), so transforming
 * an arc's centre and endpoint keeps it an arc; a mirror flips its winding.
 */
function transformProfileForPlacement(profile: SketchProfile, transform: Matrix2D): SketchProfile {
  const mirror = transform.a * transform.d - transform.b * transform.c < 0
  const placed = transformProfile(profile, (point) => ({
    x: transform.a * point.x + transform.c * point.y + transform.e,
    y: transform.b * point.x + transform.d * point.y + transform.f,
  }))
  if (!mirror) return placed
  return {
    ...placed,
    segments: placed.segments.map((segment) => (
      segment.type === 'arc' || segment.type === 'circle'
        ? { ...segment, clockwise: !segment.clockwise }
        : segment
    )),
  }
}

function normalizedParams(generator: ReturnType<typeof getCannedShapeGenerator>, raw: CannedShapeData['params']) {
  if (!generator) return null
  if (!generator.normalizeParams) return raw
  return generator.normalizeParams(raw)
}

/** Read a candidate generator output, normalized and placed in the world. */
export function resolveCannedShapeShapes(feature: CannedFeatureLike): ResolvedCannedShape[] {
  const canned = feature.canned
  if (!canned) return []

  const generator = getCannedShapeGenerator(canned.kind)
  const params = normalizedParams(generator, canned.params)
  if (!generator || !params) return []

  const outlines = cachedCannedShapeOutlines(generator, params)
  if (outlines.length === 0) return []

  const depths = nestingDepths(outlines)
  const transform = feature.transform
  return outlines.map((outline, index) => {
    const depth = depths[index]
    return {
      ...outline,
      profile: transform ? transformProfileForPlacement(outline.profile, transform) : outline.profile,
      depth,
      operation: depth % 2 === 0 ? feature.operation : invertOperation(feature.operation),
    }
  })
}

/** Generated outline profiles only, in world space. Empty when unusable. */
export function resolveCannedShapeProfiles(feature: CannedFeatureLike): SketchProfile[] {
  return resolveCannedShapeShapes(feature).map((shape) => shape.profile)
}

/** The one-line Properties summary, or `null` when no generator is registered. */
export function cannedShapeSummary(canned: CannedShapeData | null | undefined): CannedShapeSummary | null {
  if (!canned) return null
  const generator = getCannedShapeGenerator(canned.kind)
  const params = normalizedParams(generator, canned.params)
  if (!generator || !params) return null
  return generator.summary(params)
}

/** The i18n key naming the shape, for the Edit button. */
export function cannedShapeLabelKey(canned: CannedShapeData | null | undefined): string | null {
  if (!canned) return null
  return getCannedShapeGenerator(canned.kind)?.labelKey ?? null
}

/** What a kind can do beyond being drawn. Unknown kinds keep the defaults. */
export function cannedShapeCapabilities(
  canned: CannedShapeData | null | undefined,
): CannedShapeCapabilities {
  if (!canned) return { expandable: true }
  const capabilities = getCannedShapeGenerator(canned.kind)?.capabilities
  return { expandable: capabilities?.expandable ?? true }
}

/** True when Properties may offer "Expand to features" for this kind. */
export function cannedShapeIsExpandable(canned: CannedShapeData | null | undefined): boolean {
  return cannedShapeCapabilities(canned).expandable
}

/**
 * True when a kind's output is a **mesh** rather than an outline (Turn,
 * Polygon): `generateMesh` is the model half of the generator contract.
 *
 * Such a feature is drawn from its mesh alone. Its generated outline is only
 * the placement frame the selection bounds, Properties and export read, so
 * extruding it would put a second, box-shaped solid around the real shape
 * (issue #1112 F5).
 */
export function cannedShapeIsModel(canned: CannedShapeData | null | undefined): boolean {
  if (!canned) return false
  return !!getCannedShapeGenerator(canned.kind)?.generateMesh
}

/**
 * Build a canned model's mesh from its current parameters. `null` for a sketch
 * kind, an unregistered kind, a parameter set the generator refuses, or a
 * generator that declines to build one.
 */
export function generateCannedShapeMesh(canned: CannedShapeData | null | undefined): CannedShapeMesh | null {
  if (!canned) return null
  const generator = getCannedShapeGenerator(canned.kind)
  if (!generator?.generateMesh) return null
  const params = normalizedParams(generator, canned.params)
  if (!params) return null
  return generator.generateMesh(params)
}

/**
 * Convert stored parameters when the project's units change. A generator that
 * stores lengths must supply `convertParams`; without it the parameters are
 * returned untouched (correct only for an all-unitless parameter set).
 */
export function convertCannedShapeData(
  canned: CannedShapeData | null | undefined,
  convertLength: (value: number) => number,
): CannedShapeData | null {
  if (!canned) return null
  const generator = getCannedShapeGenerator(canned.kind)
  if (!generator?.convertParams) return canned
  const params = normalizedParams(generator, canned.params)
  if (!params) return canned
  return { kind: canned.kind, params: generator.convertParams(params, convertLength) }
}

/**
 * Placement frame derived from the generated outlines. Stored in
 * `definition.profile` so older builds and every frame reader (selection
 * bounds, placement, export) see a sensible box, but never read back to
 * regenerate: the parameters are authoritative.
 */
export function cannedShapeFrame(canned: CannedShapeData | null | undefined): SketchProfile | null {
  if (!canned) return null
  const generator = getCannedShapeGenerator(canned.kind)
  const params = normalizedParams(generator, canned.params)
  if (!generator || !params) return null
  const outlines = cachedCannedShapeOutlines(generator, params)
  if (outlines.length === 0) return null

  let bounds = getProfileBounds(outlines[0].profile)
  for (const outline of outlines.slice(1)) {
    const next = getProfileBounds(outline.profile)
    bounds = {
      minX: Math.min(bounds.minX, next.minX),
      maxX: Math.max(bounds.maxX, next.maxX),
      minY: Math.min(bounds.minY, next.minY),
      maxY: Math.max(bounds.maxY, next.maxY),
    }
  }
  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY
  if (!(width > 0) || !(height > 0)) return null
  return rectProfile(bounds.minX, bounds.minY, width, height)
}
