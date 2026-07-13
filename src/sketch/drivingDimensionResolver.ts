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
 * Pure resolver for driving dimension edits.
 *
 * Takes a DimensionAnnotation (or a stock axis) plus the Project and returns
 * either a deterministic edit candidate or a disabled reason. Callers (canvas
 * hooks) consume the result to decide whether to open a driving-edit panel.
 *
 * This module is framework-free — it only depends on project types and the
 * existing anchor-resolution helpers in `dimensions.ts`.
 */

import {
  getStockBounds,
  type DimensionAnnotation,
  type DimensionAnchor,
  type Point,
  type Project,
  type SketchProfile,
  type Stock,
} from '../types/project'
import { resolveAnchor, isDimensionDangling, measureValue } from './dimensions'
import { resolvedFeatureMap } from '../store/helpers/resolveFeatures'

// ────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────

/** Which side of a stock rectangle is held fixed during a resize. */
export type HeldSide = 'left' | 'right' | 'top' | 'bottom'

/** A resolved driving edit for a rectangular stock dimension label. */
export interface StockDimensionEdit {
  kind: 'stock_dimension'
  axis: 'width' | 'height'
  heldSide: HeldSide
  currentValue: number
}

/**
 * A resolved linear (horizontal / vertical / aligned) driving edit on a
 * sketch feature. One endpoint is explicitly held; the other moves.
 */
export interface LinearDrivingEdit {
  kind: 'linear'
  annotationId: string
  featureId: string
  /** The anchor that stays put. */
  heldAnchor: DimensionAnchor
  /** The anchor that will move. */
  drivenAnchor: DimensionAnchor
  /** Resolved world position of the held anchor. */
  heldPoint: Point
  /** Resolved world position of the driven anchor (pre-edit). */
  drivenPoint: Point
  /** Current measured value. */
  currentValue: number
  /** User-facing label for the held side (e.g. "Hold left", "Hold top"). */
  heldSideLabel: string
  /** The complementary held-side option (for flip control). */
  flipHeldSideLabel: string
}

/** A resolved radius / diameter driving edit on an arc or circle segment. */
export interface RadiusDrivingEdit {
  kind: 'radius' | 'diameter'
  annotationId: string
  featureId: string
  /** Index of the arc/circle segment within the feature profile. */
  segmentIndex: number
  currentValue: number
}

/** A resolved angle driving edit on one feature. */
export interface AngleDrivingEdit {
  kind: 'angle'
  annotationId: string
  featureId: string
  /** The angle vertex that stays put. */
  vertexAnchor: DimensionAnchor
  /** The ray endpoint that stays put. */
  heldAnchor: DimensionAnchor
  /** The ray endpoint that rotates around the vertex. */
  drivenAnchor: DimensionAnchor
  vertexPoint: Point
  heldPoint: Point
  drivenPoint: Point
  currentValue: number
  heldSideLabel: string
  flipHeldSideLabel: string
}

export type DrivingDimensionEdit = StockDimensionEdit | LinearDrivingEdit | RadiusDrivingEdit | AngleDrivingEdit

export interface DisabledReason {
  disabled: true
  reason: string
}

// ────────────────────────────────────────────────────────────
// Stock helpers
// ────────────────────────────────────────────────────────────

/** True when the stock profile is a simple axis-aligned rectangle. */
function isRectangularStock(stock: Stock): boolean {
  if (stock.sourceFeatureId) return false
  const segs = stock.profile.segments
  if (segs.length !== 4) return false
  return segs.every((s) => s.type === 'line')
}

/**
 * Resolve a stock dimension label click into a driving edit (or disabled).
 * Only rectangular stock without a sourceFeatureId is supported.
 */
export function resolveStockDimensionEdit(
  axis: 'width' | 'height',
  stock: Stock,
  defaultHeldSide: HeldSide,
): StockDimensionEdit | DisabledReason {
  if (!isRectangularStock(stock)) {
    return { disabled: true, reason: 'Stock is not a simple rectangle' }
  }

  const bounds = getStockBounds(stock)
  const value = axis === 'width' ? bounds.maxX - bounds.minX : bounds.maxY - bounds.minY

  if (value <= 0) {
    return { disabled: true, reason: `Stock ${axis} is non-positive` }
  }

  return {
    kind: 'stock_dimension',
    axis,
    heldSide: defaultHeldSide,
    currentValue: value,
  }
}

// ────────────────────────────────────────────────────────────
// Anchor helpers
// ────────────────────────────────────────────────────────────

/** Resolve the feature id from an anchor, or null for free/origin/stock. */
function anchorFeatureId(anchor: DimensionAnchor): string | null {
  if (anchor.kind === 'free' || anchor.kind === 'origin') return null
  if ('target' in anchor && anchor.target.source === 'feature') return anchor.target.featureId
  return null
}

/**
 * Check whether an anchor is an editable point on a feature (vertex or
 * midpoint). Free, center, circleEdge, and segmentPoint anchors are not
 * considered point controls for linear driving edits.
 */
function isEditablePointAnchor(anchor: DimensionAnchor): boolean {
  return anchor.kind === 'vertex' || anchor.kind === 'midpoint'
}

/**
 * Map an anchor to an anchor index within the feature profile so the canvas
 * moveFeatureControl action can target it. Returns null for unsupported kinds.
 */
function anchorToControlIndex(anchor: DimensionAnchor, profile: SketchProfile): number | null {
  if (anchor.kind === 'vertex') return anchor.vertexIndex
  if (anchor.kind === 'midpoint') {
    // Midpoint of a segment: the driven control is the end anchor of that segment.
    // For closed profiles: (segmentIndex + 1) % segments.length
    // For open profiles: segmentIndex + 1
    if (profile.closed) {
      return (anchor.segmentIndex + 1) % profile.segments.length
    }
    return anchor.segmentIndex + 1
  }
  return null
}

// ────────────────────────────────────────────────────────────
// Held-side labelling
// ────────────────────────────────────────────────────────────

const HELD_LEFT = 'Hold left'
const HELD_RIGHT = 'Hold right'
const HELD_TOP = 'Hold top'
const HELD_BOTTOM = 'Hold bottom'
const HELD_START = 'Hold start'
const HELD_END = 'Hold end'
const HELD_FIRST_RAY = 'Hold first ray'
const HELD_SECOND_RAY = 'Hold second ray'

function heldSideForLinear(
  held: Point,
  driven: Point,
  dimType: 'horizontal' | 'vertical' | 'aligned',
): { heldSideLabel: string; flipHeldSideLabel: string } {
  if (dimType === 'horizontal') {
    return held.x <= driven.x
      ? { heldSideLabel: HELD_LEFT, flipHeldSideLabel: HELD_RIGHT }
      : { heldSideLabel: HELD_RIGHT, flipHeldSideLabel: HELD_LEFT }
  }
  if (dimType === 'vertical') {
    return held.y <= driven.y
      ? { heldSideLabel: HELD_TOP, flipHeldSideLabel: HELD_BOTTOM }
      : { heldSideLabel: HELD_BOTTOM, flipHeldSideLabel: HELD_TOP }
  }
  // aligned — use start/end terminology
  return { heldSideLabel: HELD_START, flipHeldSideLabel: HELD_END }
}

// ────────────────────────────────────────────────────────────
// Main resolver
// ────────────────────────────────────────────────────────────

/**
 * Resolve a dimension annotation into a driving edit candidate (or a
 * disabled reason). Returns null for annotations that are not drive-capable
 * but aren't "broken" either — callers should treat null as "no-op, keep
 * existing selection behaviour."
 */
export function resolveDrivingDimensionEdit(
  annotation: DimensionAnnotation,
  project: Project,
): DrivingDimensionEdit | DisabledReason | null {
  // ── Gate: locked / hidden / dangling ──
  if (annotation.locked) return { disabled: true, reason: 'Dimension is locked' }
  if (!annotation.visible) return { disabled: true, reason: 'Dimension is hidden' }
  if (isDimensionDangling(annotation, project)) return { disabled: true, reason: 'Dimension is dangling' }

  // ── Angle ──
  if (annotation.type === 'angle') {
    return resolveAngleDrivingEdit(annotation, project)
  }

  // ── Radius / diameter ──
  if (annotation.type === 'radius' || annotation.type === 'diameter') {
    return resolveRadiusDrivingEdit(annotation, project)
  }

  // ── Linear types: horizontal / vertical / aligned ──
  if (annotation.type === 'horizontal' || annotation.type === 'vertical' || annotation.type === 'aligned') {
    return resolveLinearDrivingEdit(annotation, project)
  }

  return null
}

function resolveRadiusDrivingEdit(
  dim: DimensionAnnotation,
  project: Project,
): DrivingDimensionEdit | DisabledReason | null {
  const centerAnchor = dim.a
  if (centerAnchor.kind !== 'center') return null

  const featureId = anchorFeatureId(centerAnchor)
  if (!featureId) return null

  // Verify the feature exists and the segment is an arc/circle
  const feature = resolvedFeatureMap(project).get(featureId)
  if (!feature) return { disabled: true, reason: 'Feature not found' }

  const seg = feature.sketch.profile.segments[centerAnchor.segmentIndex]
  if (!seg || (seg.type !== 'arc' && seg.type !== 'circle')) {
    return { disabled: true, reason: 'Center anchor segment is not an arc or circle' }
  }

  // Require the edge anchor to target the same feature so the edited radius is unambiguous.
  if (!dim.b) return null
  const edgeFeatureId = anchorFeatureId(dim.b)
  if (!edgeFeatureId) return null
  if (edgeFeatureId !== featureId) {
    return { disabled: true, reason: 'Edge anchor targets a different feature' }
  }

  const value = measureValue(dim, project)
  if (value === null || value <= 0) return { disabled: true, reason: 'Cannot measure radius/diameter' }

  return {
    kind: dim.type as 'radius' | 'diameter',
    annotationId: dim.id,
    featureId,
    segmentIndex: centerAnchor.segmentIndex,
    currentValue: value,
  }
}

function resolveLinearDrivingEdit(
  dim: DimensionAnnotation,
  project: Project,
): DrivingDimensionEdit | DisabledReason | null {
  if (!dim.b) return null
  if (dim.type !== 'horizontal' && dim.type !== 'vertical' && dim.type !== 'aligned') return null

  // Both anchors must be editable point anchors
  if (!isEditablePointAnchor(dim.a) || !isEditablePointAnchor(dim.b)) return null

  // Both must target the same feature
  const featureIdA = anchorFeatureId(dim.a)
  const featureIdB = anchorFeatureId(dim.b)
  if (!featureIdA || !featureIdB) return null
  if (featureIdA !== featureIdB) return { disabled: true, reason: 'Anchors span different features' }

  // Verify the feature exists
  const feature = resolvedFeatureMap(project).get(featureIdA)
  if (!feature) return { disabled: true, reason: 'Feature not found' }

  // Resolve world points
  const heldPoint = resolveAnchor(dim.a, project)
  const drivenPoint = resolveAnchor(dim.b, project)
  if (!heldPoint || !drivenPoint) return { disabled: true, reason: 'Cannot resolve anchor positions' }

  // Check that the driven anchor maps to a valid control index
  const profile = feature.sketch.profile
  const drivenIndex = anchorToControlIndex(dim.b, profile)
  if (drivenIndex === null) return { disabled: true, reason: 'Driven anchor is not an editable control' }

  // Check held anchor also maps to a valid control (sanity)
  const heldIndex = anchorToControlIndex(dim.a, profile)
  if (heldIndex === null) return { disabled: true, reason: 'Held anchor is not an editable control' }

  const value = measureValue(dim, project)
  if (value === null || value <= 0) return { disabled: true, reason: 'Cannot measure dimension value' }

  const { heldSideLabel, flipHeldSideLabel } = heldSideForLinear(heldPoint, drivenPoint, dim.type)

  return {
    kind: 'linear',
    annotationId: dim.id,
    featureId: featureIdA,
    heldAnchor: dim.a,
    drivenAnchor: dim.b,
    heldPoint,
    drivenPoint,
    currentValue: value,
    heldSideLabel,
    flipHeldSideLabel,
  }
}

function resolveAngleDrivingEdit(
  dim: DimensionAnnotation,
  project: Project,
): DrivingDimensionEdit | DisabledReason | null {
  if (!dim.b || !dim.c) return null

  if (!isEditablePointAnchor(dim.a) || !isEditablePointAnchor(dim.b) || !isEditablePointAnchor(dim.c)) {
    return null
  }

  const featureIdA = anchorFeatureId(dim.a)
  const featureIdB = anchorFeatureId(dim.b)
  const featureIdC = anchorFeatureId(dim.c)
  if (!featureIdA || !featureIdB || !featureIdC) return null
  if (featureIdA !== featureIdB || featureIdA !== featureIdC) {
    return { disabled: true, reason: 'Angle anchors span different features' }
  }

  const feature = resolvedFeatureMap(project).get(featureIdA)
  if (!feature) return { disabled: true, reason: 'Feature not found' }

  const profile = feature.sketch.profile
  const drivenIndex = anchorToControlIndex(dim.c, profile)
  if (drivenIndex === null) return { disabled: true, reason: 'Driven angle anchor is not an editable control' }
  const vertexIndex = anchorToControlIndex(dim.a, profile)
  const heldIndex = anchorToControlIndex(dim.b, profile)
  if (vertexIndex === null || heldIndex === null) {
    return { disabled: true, reason: 'Held angle anchors are not editable controls' }
  }

  const vertexPoint = resolveAnchor(dim.a, project)
  const heldPoint = resolveAnchor(dim.b, project)
  const drivenPoint = resolveAnchor(dim.c, project)
  if (!vertexPoint || !heldPoint || !drivenPoint) {
    return { disabled: true, reason: 'Cannot resolve angle anchor positions' }
  }

  const value = measureValue(dim, project)
  if (value === null || value <= 0) return { disabled: true, reason: 'Cannot measure angle value' }

  return {
    kind: 'angle',
    annotationId: dim.id,
    featureId: featureIdA,
    vertexAnchor: dim.a,
    heldAnchor: dim.b,
    drivenAnchor: dim.c,
    vertexPoint,
    heldPoint,
    drivenPoint,
    currentValue: value,
    heldSideLabel: HELD_FIRST_RAY,
    flipHeldSideLabel: HELD_SECOND_RAY,
  }
}

/**
 * Flip the held/driven endpoints of a linear driving edit. Returns a new edit
 * with the anchors swapped and labels updated.
 */
export function flipLinearDrivingEdit(edit: LinearDrivingEdit): LinearDrivingEdit {
  const { heldSideLabel, flipHeldSideLabel } = heldSideForLinear(
    edit.drivenPoint,
    edit.heldPoint,
    // Infer the dimension type from the held-side labels
    edit.heldSideLabel === HELD_LEFT || edit.heldSideLabel === HELD_RIGHT ? 'horizontal' :
    edit.heldSideLabel === HELD_TOP || edit.heldSideLabel === HELD_BOTTOM ? 'vertical' :
    'aligned',
  )

  return {
    ...edit,
    heldAnchor: edit.drivenAnchor,
    drivenAnchor: edit.heldAnchor,
    heldPoint: edit.drivenPoint,
    drivenPoint: edit.heldPoint,
    heldSideLabel,
    flipHeldSideLabel,
  }
}

/** Flip the held/driven rays of an angle driving edit. */
export function flipAngleDrivingEdit(edit: AngleDrivingEdit): AngleDrivingEdit {
  return {
    ...edit,
    heldAnchor: edit.drivenAnchor,
    drivenAnchor: edit.heldAnchor,
    heldPoint: edit.drivenPoint,
    drivenPoint: edit.heldPoint,
    heldSideLabel: edit.heldSideLabel === HELD_FIRST_RAY ? HELD_SECOND_RAY : HELD_FIRST_RAY,
    flipHeldSideLabel: edit.flipHeldSideLabel === HELD_FIRST_RAY ? HELD_SECOND_RAY : HELD_FIRST_RAY,
  }
}
