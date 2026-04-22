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

import type { LocalConstraint, Point, SketchFeature, SketchProfile } from '../types/project'
import { profileVertices, getProfileBounds } from '../types/project'

export interface PointDistanceInput {
  kind: 'point'
  anchor: Point
  reference: Point
  distance: number
}

export interface SegmentDistanceInput {
  kind: 'segment'
  anchor: Point
  segmentA: Point
  segmentB: Point
  /** Signed perpendicular distance — preserves which side the anchor is on. */
  signedDistance: number
}

export type ConstraintInput = PointDistanceInput | SegmentDistanceInput

export interface FeatureOffset {
  dx: number
  dy: number
}

export interface Transform {
  tx: number
  ty: number
  angle: number
  pivot: Point
}

function applyTransform(p: Point, t: Transform): Point {
  const localX = p.x - t.pivot.x
  const localY = p.y - t.pivot.y
  const cos = Math.cos(t.angle)
  const sin = Math.sin(t.angle)
  return {
    x: t.pivot.x + localX * cos - localY * sin + t.tx,
    y: t.pivot.y + localX * sin + localY * cos + t.ty,
  }
}

function averageTransforms(list: Transform[]): Transform {
  if (list.length === 0) return { tx: 0, ty: 0, angle: 0, pivot: { x: 0, y: 0 } }
  let sumTx = 0
  let sumTy = 0
  let sumAngle = 0
  let sumPivotX = 0
  let sumPivotY = 0
  for (const t of list) {
    sumTx += t.tx
    sumTy += t.ty
    sumAngle += t.angle
    sumPivotX += t.pivot.x
    sumPivotY += t.pivot.y
  }
  const n = list.length
  return {
    tx: sumTx / n,
    ty: sumTy / n,
    angle: sumAngle / n,
    pivot: { x: sumPivotX / n, y: sumPivotY / n },
  }
}

// ============================================================
// Semantic geometry re-derivation
// ============================================================

/**
 * Calculate the geometric center of a profile (Natural Center, index -1).
 */
export function calculateGeometricCenter(profile: SketchProfile): Point {
  const bounds = getProfileBounds(profile)
  return {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
  }
}

/**
 * Get a vertex point from a profile by index.
 * Index -1 returns the natural center.
 */
function getVertexPoint(profile: SketchProfile, index: number): Point | null {
  if (index === -1) return calculateGeometricCenter(profile)
  const vertices = profileVertices(profile)
  return vertices[index] ?? null
}

/**
 * Get a point at fractional position t [0,1] along a segment by index.
 */
function getSegmentPointAtT(profile: SketchProfile, index: number, t: number): Point | null {
  const vertices = profileVertices(profile)
  const a = vertices[index]
  const b = vertices[(index + 1) % vertices.length]
  if (!a || !b) return null
  const clampedT = Math.max(0, Math.min(1, t))
  return { x: a.x + (b.x - a.x) * clampedT, y: a.y + (b.y - a.y) * clampedT }
}

/**
 * Compute the fractional t [0,1] of a point projected onto a segment.
 */
export function projectPointOntoSegmentT(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-12) return 0
  return Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lenSq))
}

/**
 * Get a midpoint of a segment by segment index.
 * Index -1 returns the natural center.
 */
function getMidpoint(profile: SketchProfile, index: number): Point | null {
  if (index === -1) return calculateGeometricCenter(profile)
  const vertices = profileVertices(profile)
  const a = vertices[index]
  const b = vertices[(index + 1) % vertices.length]
  if (!a || !b) return null
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/**
 * Get a segment pair {a, b} by segment index.
 * Index -1 returns a degenerate segment at the natural center.
 */
function getSegmentPair(profile: SketchProfile, index: number): { a: Point; b: Point } | null {
  if (index === -1) {
    const c = calculateGeometricCenter(profile)
    return { a: c, b: c }
  }
  const vertices = profileVertices(profile)
  const a = vertices[index]
  const b = vertices[(index + 1) % vertices.length]
  if (!a || !b) return null
  return { a, b }
}

export interface RederiveResult {
  anchorPoint: Point
  referencePoint?: Point
  referenceSegment?: { a: Point; b: Point }
  isValid: boolean
  errorMessage?: string
}

/**
 * Re-derive the geometric points for a constraint from semantic indices.
 * Returns null if the constraint has no semantic fields (legacy constraint).
 */
export function rederiveConstraintGeometry(
  ownerProfile: SketchProfile,
  referenceProfile: SketchProfile | null,
  constraint: LocalConstraint,
): RederiveResult | null {
  // Only process constraints with semantic fields
  if (
    constraint.anchor_index === undefined ||
    constraint.anchor_type === undefined ||
    constraint.reference_index === undefined ||
    constraint.reference_type === undefined
  ) {
    return null
  }

  // Derive anchor point
  let anchorPoint: Point | null = null
  if (constraint.anchor_type === 'anchor') {
    anchorPoint = getVertexPoint(ownerProfile, constraint.anchor_index)
  } else {
    anchorPoint = getMidpoint(ownerProfile, constraint.anchor_index)
  }

  if (!anchorPoint) {
    return {
      anchorPoint: { x: 0, y: 0 },
      isValid: false,
      errorMessage: `Anchor index ${constraint.anchor_index} out of bounds`,
    }
  }

  // If no reference profile, we can't derive reference geometry
  if (!referenceProfile) {
    return {
      anchorPoint,
      isValid: false,
      errorMessage: 'Reference feature not found',
    }
  }

  // Derive reference geometry
  if (constraint.reference_type === 'segment') {
    const seg = getSegmentPair(referenceProfile, constraint.reference_index)
    if (!seg) {
      return {
        anchorPoint,
        isValid: false,
        errorMessage: `Reference segment index ${constraint.reference_index} out of bounds`,
      }
    }
    // Compute foot of perpendicular as reference_point for rendering
    const sx = seg.b.x - seg.a.x
    const sy = seg.b.y - seg.a.y
    const segLen = Math.hypot(sx, sy)
    let footPoint: Point | undefined
    if (segLen > 1e-12) {
      const nx = -sy / segLen
      const ny = sx / segLen
      const signedDist = (anchorPoint.x - seg.a.x) * nx + (anchorPoint.y - seg.a.y) * ny
      footPoint = { x: anchorPoint.x - signedDist * nx, y: anchorPoint.y - signedDist * ny }
    }
    return { anchorPoint, referencePoint: footPoint, referenceSegment: seg, isValid: true }
  }

  if (constraint.reference_type === 'point_on_segment') {
    const t = constraint.reference_t ?? 0
    const refPoint = getSegmentPointAtT(referenceProfile, constraint.reference_index, t)
    if (!refPoint) {
      return {
        anchorPoint,
        isValid: false,
        errorMessage: `Reference segment index ${constraint.reference_index} out of bounds`,
      }
    }
    return { anchorPoint, referencePoint: refPoint, isValid: true }
  }

  if (constraint.reference_type === 'midpoint') {
    const refPoint = getMidpoint(referenceProfile, constraint.reference_index)
    if (!refPoint) {
      return {
        anchorPoint,
        isValid: false,
        errorMessage: `Reference midpoint index ${constraint.reference_index} out of bounds`,
      }
    }
    return { anchorPoint, referencePoint: refPoint, isValid: true }
  }

  // anchor type
  const refPoint = getVertexPoint(referenceProfile, constraint.reference_index)
  if (!refPoint) {
    return {
      anchorPoint,
      isValid: false,
      errorMessage: `Reference vertex index ${constraint.reference_index} out of bounds`,
    }
  }
  return { anchorPoint, referencePoint: refPoint, isValid: true }
}

/**
 * Update a constraint's cached coordinate fields from semantic indices.
 * Returns the updated constraint, or the original if no semantic fields.
 */
export function refreshConstraintCache(
  constraint: LocalConstraint,
  ownerProfile: SketchProfile,
  referenceProfile: SketchProfile | null,
): LocalConstraint {
  const result = rederiveConstraintGeometry(ownerProfile, referenceProfile, constraint)
  if (!result) return constraint

  return {
    ...constraint,
    anchor_point: result.anchorPoint,
    reference_point: result.referencePoint,
    reference_segment: result.referenceSegment,
    is_invalid: !result.isValid,
    error_message: result.errorMessage,
  }
}

/**
 * Validate all fixed_distance constraints on a feature against their stored values.
 * Marks constraints as invalid when the actual distance deviates beyond tolerance.
 * Returns the updated feature (or the same object if nothing changed).
 */
export function validateConstraintsOnFeature(
  feature: SketchFeature,
  featureById: Map<string, SketchFeature>,
  tolerance = 1e-3,
): SketchFeature {
  let anyChanged = false
  const nextConstraints = feature.sketch.constraints.map((c) => {
    if (c.type !== 'fixed_distance' || c.value === undefined) return c
    const refFeatureId = c.reference_feature_id ?? c.segment_ids[0]
    const refFeature = refFeatureId ? featureById.get(refFeatureId) : null
    const result = rederiveConstraintGeometry(
      feature.sketch.profile,
      refFeature?.sketch.profile ?? null,
      c,
    )
    if (!result) return c
    if (!result.isValid) {
      if (!c.is_invalid) {
        anyChanged = true
        return { ...c, is_invalid: true, error_message: result.errorMessage }
      }
      return c
    }
    // Compute actual distance
    let actualDist: number | null = null
    if (result.referenceSegment) {
      const { a, b } = result.referenceSegment
      const sx = b.x - a.x; const sy = b.y - a.y
      const segLen = Math.hypot(sx, sy)
      if (segLen > 1e-12) {
        const nx = -sy / segLen; const ny = sx / segLen
        actualDist = (result.anchorPoint.x - a.x) * nx + (result.anchorPoint.y - a.y) * ny
      }
    } else if (result.referencePoint) {
      actualDist = Math.hypot(
        result.anchorPoint.x - result.referencePoint.x,
        result.anchorPoint.y - result.referencePoint.y,
      )
    }
    if (actualDist === null) return c
    const isNowInvalid = Math.abs(actualDist - c.value) > tolerance
    const wasInvalid = !!c.is_invalid
    if (isNowInvalid !== wasInvalid) {
      anyChanged = true
      return {
        ...c,
        anchor_point: result.anchorPoint,
        reference_point: result.referencePoint,
        reference_segment: result.referenceSegment,
        is_invalid: isNowInvalid,
        error_message: isNowInvalid ? `Distance ${actualDist.toFixed(4)} does not match constraint value ${c.value.toFixed(4)}` : undefined,
      }
    }
    // Always refresh cache coords
    return {
      ...c,
      anchor_point: result.anchorPoint,
      reference_point: result.referencePoint,
      reference_segment: result.referenceSegment,
      is_invalid: false,
      error_message: undefined,
    }
  })
  if (!anyChanged && nextConstraints.every((c, i) => c === feature.sketch.constraints[i])) {
    return feature
  }
  return { ...feature, sketch: { ...feature.sketch, constraints: nextConstraints } }
}

/**
 * Find the nearest vertex index in a profile to a given point.
 */
export function nearestVertexIndex(profile: SketchProfile, point: Point): number {
  const vertices = profileVertices(profile)
  let bestIndex = 0
  let bestDist = Infinity
  for (let i = 0; i < vertices.length; i++) {
    const v = vertices[i]
    if (!v) continue
    const d = Math.hypot(v.x - point.x, v.y - point.y)
    if (d < bestDist) {
      bestDist = d
      bestIndex = i
    }
  }
  return bestIndex
}

/**
 * Find the nearest segment index in a profile to a given point.
 */
export function nearestSegmentIndex(profile: SketchProfile, point: Point): number {
  const vertices = profileVertices(profile)
  if (vertices.length === 0) return 0
  let bestIndex = 0
  let bestDist = Infinity
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i]
    const b = vertices[(i + 1) % vertices.length]
    if (!a || !b) continue
    // midpoint of segment
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    const d = Math.hypot(mx - point.x, my - point.y)
    if (d < bestDist) {
      bestDist = d
      bestIndex = i
    }
  }
  return bestIndex
}

/**
 * Infer semantic anchor/reference indices from snap mode and point positions.
 * Used when committing a new constraint.
 */
export function inferSemanticIndices(
  ownerProfile: SketchProfile,
  referenceProfile: SketchProfile | null,
  anchorPoint: Point,
  referencePoint: Point,
  anchorSnapMode: string | null,
  referenceSnapMode: string | null,
  referenceSegment?: { a: Point; b: Point },
): {
  anchor_index: number
  anchor_type: 'anchor' | 'midpoint'
  reference_index: number
  reference_type: 'anchor' | 'midpoint' | 'segment' | 'point_on_segment'
  reference_t?: number
} {
  // Determine anchor semantics
  let anchor_type: 'anchor' | 'midpoint' = 'anchor'
  let anchor_index = 0

  if (anchorSnapMode === 'center') {
    anchor_index = -1
    anchor_type = 'anchor'
  } else if (anchorSnapMode === 'midpoint') {
    anchor_type = 'midpoint'
    anchor_index = nearestSegmentIndex(ownerProfile, anchorPoint)
  } else {
    anchor_type = 'anchor'
    anchor_index = nearestVertexIndex(ownerProfile, anchorPoint)
  }

  // Determine reference semantics
  let reference_type: 'anchor' | 'midpoint' | 'segment' | 'point_on_segment' = 'anchor'
  let reference_index = 0
  let reference_t: number | undefined

  if (!referenceProfile) {
    return { anchor_index, anchor_type, reference_index, reference_type }
  }

  if (referenceSnapMode === 'perpendicular' && referenceSegment) {
    reference_type = 'segment'
    reference_index = nearestSegmentIndex(referenceProfile, {
      x: (referenceSegment.a.x + referenceSegment.b.x) / 2,
      y: (referenceSegment.a.y + referenceSegment.b.y) / 2,
    })
  } else if (referenceSnapMode === 'line') {
    // Point on segment: find nearest segment and compute fractional t
    reference_index = nearestSegmentIndex(referenceProfile, referencePoint)
    const vertices = profileVertices(referenceProfile)
    const a = vertices[reference_index]
    const b = vertices[(reference_index + 1) % vertices.length]
    if (a && b) {
      reference_t = projectPointOntoSegmentT(referencePoint, a, b)
      // If t is very close to 0 or 1, snap to the vertex instead
      if (reference_t < 0.01) {
        reference_type = 'anchor'
        reference_index = reference_index
        reference_t = undefined
      } else if (reference_t > 0.99) {
        reference_type = 'anchor'
        reference_index = (reference_index + 1) % vertices.length
        reference_t = undefined
      } else {
        reference_type = 'point_on_segment'
      }
    } else {
      reference_type = 'anchor'
      reference_index = nearestVertexIndex(referenceProfile, referencePoint)
    }
  } else if (referenceSnapMode === 'center') {
    reference_type = 'anchor'
    reference_index = -1
  } else if (referenceSnapMode === 'midpoint') {
    reference_type = 'midpoint'
    reference_index = nearestSegmentIndex(referenceProfile, referencePoint)
  } else {
    reference_type = 'anchor'
    reference_index = nearestVertexIndex(referenceProfile, referencePoint)
  }

  return { anchor_index, anchor_type, reference_index, reference_type, reference_t }
}

export function solveFeatureTranslation(
  constraints: ConstraintInput[],
  options: { iterations?: number; priorWeight?: number; tolerance?: number } = {},
): FeatureOffset {
  if (constraints.length === 0) return { dx: 0, dy: 0 }
  const iterations = options.iterations ?? 30
  const priorWeight = options.priorWeight ?? 1e-3
  const tolerance = options.tolerance ?? 1e-9

  let dx = 0
  let dy = 0
  for (let iter = 0; iter < iterations; iter++) {
    let A00 = priorWeight
    let A01 = 0
    let A11 = priorWeight
    let b0 = -priorWeight * dx
    let b1 = -priorWeight * dy
    let contributed = 0
    for (const c of constraints) {
      if (c.kind === 'point') {
        const ax = c.anchor.x + dx
        const ay = c.anchor.y + dy
        const vx = ax - c.reference.x
        const vy = ay - c.reference.y
        let currentLen = Math.hypot(vx, vy)
        
        if (currentLen < 1e-12) {
          if (c.distance > 1e-12) {
            const ux = 1, uy = 0
            const residual = -c.distance
            A00 += ux * ux
            A11 += uy * uy
            b0 -= ux * residual
            b1 -= uy * residual
            contributed++
          }
          continue
        }
        
        const ux = vx / currentLen
        const uy = vy / currentLen
        const residual = currentLen - c.distance
        
        const jx = ux
        const jy = uy
        
        A00 += jx * jx
        A01 += jx * jy
        A11 += jy * jy
        b0 -= jx * residual
        b1 -= jy * residual
        contributed++
      } else {
        const sx = c.segmentB.x - c.segmentA.x
        const sy = c.segmentB.y - c.segmentA.y
        const segLen = Math.hypot(sx, sy)
        if (segLen < 1e-12) continue
        const nx = -sy / segLen
        const ny = sx / segLen
        const ax = c.anchor.x + dx
        const ay = c.anchor.y + dy
        const signed = (ax - c.segmentA.x) * nx + (ay - c.segmentA.y) * ny
        const residual = signed - c.signedDistance
        A00 += nx * nx
        A01 += nx * ny
        A11 += ny * ny
        b0 -= nx * residual
        b1 -= ny * residual
        contributed++
      }
    }
    if (contributed === 0) break
    const det = A00 * A11 - A01 * A01
    if (Math.abs(det) < 1e-18) break
    const ddx = (A11 * b0 - A01 * b1) / det
    const ddy = (A00 * b1 - A01 * b0) / det
    dx += ddx
    dy += ddy
    if (Math.hypot(ddx, ddy) < tolerance) break
  }
  return { dx, dy }
}

/**
 * Apply a rigid‑transform (translation + rotation) to a set of features and propagate constraints.
 */
export function propagateRigidTransforms(
  features: SketchFeature[],
  movedTransforms: Map<string, Transform>,
  options: { 
    maxVisitsPerFeature?: number; 
    transformProfile: (profile: SketchFeature['sketch']['profile'], transformPoint: (p: Point) => Point) => SketchFeature['sketch']['profile'] 
  },
): SketchFeature[] {
  const { transformProfile } = options
  const maxVisits = options.maxVisitsPerFeature ?? 6
  if (movedTransforms.size === 0) return features

  // We MUST keep the state from the START of this propagation to avoid cumulative errors
  // during multiple visits to the same feature in the queue.
  const initialFeatures = new Map<string, SketchFeature>(features.map((f) => [f.id, JSON.parse(JSON.stringify(f))]))
  const currentById = new Map<string, SketchFeature>(features.map((f) => [f.id, f]))
  const movedIds = new Set(movedTransforms.keys())

  // 1. Update reference fields and preserve constraints on moved features (seeds)
  for (const [id, feature] of currentById) {
    const t = movedTransforms.get(id)
    
    const nextConstraints = feature.sketch.constraints.map((c) => {
      if (c.type !== 'fixed_distance') return c
      
      let nextC = { ...c }
      let cChanged = false

      if (t && nextC.anchor_point) {
        nextC.anchor_point = applyTransform(nextC.anchor_point, t)
        cChanged = true
      }

      if (nextC.segment_ids.length > 0) {
        const refId = nextC.segment_ids[0]
        const refT = movedTransforms.get(refId)
        if (refT) {
          if (nextC.reference_point) {
            nextC.reference_point = applyTransform(nextC.reference_point, refT)
            cChanged = true
          }
          if (nextC.reference_segment) {
            nextC.reference_segment = {
              a: applyTransform(nextC.reference_segment.a, refT),
              b: applyTransform(nextC.reference_segment.b, refT),
            }
            cChanged = true
          }
        }
      }

      // If THIS feature was moved manually (seed) with a non-trivial transform, update the constraint value.
      // A zero-displacement seed (dx:0,dy:0) means the reference geometry changed, not the owner moved.
      const isNonTrivialMove = t && (Math.abs(t.tx) > 1e-9 || Math.abs(t.ty) > 1e-9 || Math.abs(t.angle) > 1e-9)
      if (isNonTrivialMove && movedIds.has(id) && cChanged) {
        if (nextC.anchor_point && (nextC.reference_segment || nextC.reference_point)) {
           if (nextC.reference_segment) {
             const { a, b } = nextC.reference_segment
             const dx = b.x - a.x
             const dy = b.y - a.y
             const len = Math.hypot(dx, dy)
             if (len > 1e-12) {
               const nx = -dy / len
               const ny = dx / len
               const rawSigned = (nextC.anchor_point.x - a.x) * nx + (nextC.anchor_point.y - a.y) * ny
               // Preserve original sign to prevent side-flipping near the segment
               const originalSign = (nextC.value ?? 0) >= 0 ? 1 : -1
               nextC.value = originalSign * Math.abs(rawSigned)
             }
           } else if (nextC.reference_point) {
             nextC.value = Math.hypot(nextC.anchor_point.x - nextC.reference_point.x, nextC.anchor_point.y - nextC.reference_point.y)
           }
        }
      }

      return cChanged ? nextC : c
    })

    if (nextConstraints.some((c, i) => c !== feature.sketch.constraints[i])) {
      currentById.set(id, { ...feature, sketch: { ...feature.sketch, constraints: nextConstraints } })
    }
  }

  // 2. Dependency graph
  const dependents = new Map<string, Set<string>>()
  for (const feature of currentById.values()) {
    for (const c of feature.sketch.constraints) {
      if (c.type !== 'fixed_distance') continue
      for (const refId of c.segment_ids) {
        let set = dependents.get(refId)
        if (!set) {
          set = new Set()
          dependents.set(refId, set)
        }
        set.add(feature.id)
      }
    }
  }

  // 3. Propagation
  // transforms map stores the ABSOLUTE transform from initial state to current state
  const transforms = new Map<string, Transform>()
  for (const id of movedIds) {
    transforms.set(id, movedTransforms.get(id)!)
  }

  const queue: string[] = []
  const enqueue = (id: string) => {
    if (movedIds.has(id)) return
    queue.push(id)
  }
  for (const id of movedIds) {
    for (const dep of dependents.get(id) ?? []) enqueue(dep)
  }

  const visits = new Map<string, number>()
  while (queue.length > 0) {
    const fid = queue.shift()!
    const visitCount = (visits.get(fid) ?? 0) + 1
    if (visitCount > maxVisits) continue
    visits.set(fid, visitCount)

    const feature = currentById.get(fid)
    const initialFeature = initialFeatures.get(fid)
    if (!feature || !initialFeature || feature.locked) continue

    // Issue 7: Only freeze if the constraint is STRUCTURALLY invalid (reference deleted/out-of-bounds).
    // Distance mismatches can be resolved by moving the feature, so don't freeze for those.
    const hasStructurallyInvalidConstraint = feature.sketch.constraints.some((c) => {
      if (c.type !== 'fixed_distance' || !c.is_invalid) return false
      const refId = c.reference_feature_id ?? c.segment_ids[0]
      if (!refId || (!movedIds.has(refId) && !transforms.has(refId))) return false
      // Check if the reference geometry is still structurally valid
      const refFeature = currentById.get(refId)
      if (!refFeature) return true  // reference deleted — structural
      const check = rederiveConstraintGeometry(feature.sketch.profile, refFeature.sketch.profile, c)
      return !check || !check.isValid  // out-of-bounds index — structural
    })
    if (hasStructurallyInvalidConstraint) continue

    const referencedTransforms: Transform[] = []
    for (const c of feature.sketch.constraints) {
      if (c.type !== 'fixed_distance') continue
      for (const refId of c.segment_ids) {
        const t = transforms.get(refId)
        if (t) {
          referencedTransforms.push(t)
        } else {
          // Stationary reference - include identity transform in average
          const refFeature = currentById.get(refId)
          if (refFeature) {
            referencedTransforms.push({
              tx: 0,
              ty: 0,
              angle: 0,
              pivot: refFeature.sketch.profile.start
            })
          }
        }
      }
    }
    
    const absoluteGuess = averageTransforms(referencedTransforms)
    
    const inputs: ConstraintInput[] = []
    for (const c of feature.sketch.constraints) {
      if (c.type !== 'fixed_distance' || !c.anchor_point) continue
      
      // For the warm-start guess, prefer the current anchor_point over the initial snapshot.
      // The current anchor preserves side information for segment constraints when the feature
      // is near the boundary. Apply absoluteGuess on top to account for reference movement.
      const initialAnchor = initialFeature.sketch.constraints.find(ic => ic.id === c.id)?.anchor_point ?? c.anchor_point
      const currentAnchor = c.anchor_point

      // If this is a segment constraint, check whether the initial anchor is near the segment
      // (signed distance close to zero). If so, use the current anchor as the warm start to
      // preserve which side the feature was on before the reference moved.
      let baseAnchor = initialAnchor
      if (c.reference_type === 'segment' || c.reference_segment) {
        const refFeatureId = c.reference_feature_id ?? c.segment_ids[0]
        const refFeature = refFeatureId ? currentById.get(refFeatureId) : null
        if (refFeature) {
          const rederivCheck = rederiveConstraintGeometry(initialFeature.sketch.profile, refFeature.sketch.profile, c)
          if (rederivCheck?.referenceSegment) {
            const { a, b } = rederivCheck.referenceSegment
            const sx = b.x - a.x; const sy = b.y - a.y
            const segLen = Math.hypot(sx, sy)
            if (segLen > 1e-12) {
              const nx = -sy / segLen; const ny = sx / segLen
              const signedFromInitial = (initialAnchor.x - a.x) * nx + (initialAnchor.y - a.y) * ny
              // If initial anchor is within 10% of the stored value from the segment,
              // use the current anchor to preserve side information
              const threshold = Math.abs(c.value ?? 0) * 0.1 + 1e-6
              if (Math.abs(signedFromInitial) < threshold) {
                baseAnchor = currentAnchor
              }
            }
          }
        }
      }

      const guessedAnchor = applyTransform(baseAnchor, absoluteGuess)

      // Try semantic re-derivation first for the reference geometry
      const refFeatureId = c.reference_feature_id ?? c.segment_ids[0]
      const refFeature = refFeatureId ? currentById.get(refFeatureId) : null
      const rederived = refFeature
        ? rederiveConstraintGeometry(feature.sketch.profile, refFeature.sketch.profile, c)
        : null

      if (rederived && rederived.isValid) {
        // Use semantically re-derived reference geometry with guessed anchor
        if (rederived.referenceSegment) {
          inputs.push({
            kind: 'segment',
            anchor: guessedAnchor,
            segmentA: rederived.referenceSegment.a,
            segmentB: rederived.referenceSegment.b,
            signedDistance: c.value ?? 0,
          })
        } else if (rederived.referencePoint) {
          inputs.push({
            kind: 'point',
            anchor: guessedAnchor,
            reference: rederived.referencePoint,
            distance: c.value ?? 0,
          })
        }
      } else if (c.reference_segment) {
        // Fall back to cached coordinate-based reference
        inputs.push({
          kind: 'segment',
          anchor: guessedAnchor,
          segmentA: c.reference_segment.a,
          segmentB: c.reference_segment.b,
          signedDistance: c.value ?? 0
        })
      } else if (c.reference_point) {
        inputs.push({
          kind: 'point',
          anchor: guessedAnchor,
          reference: c.reference_point,
          distance: c.value ?? 0
        })
      }
    }
    
    const { dx: adjustDx, dy: adjustDy } = solveFeatureTranslation(inputs)
    
    const finalAbsoluteTransform: Transform = {
      tx: absoluteGuess.tx + adjustDx,
      ty: absoluteGuess.ty + adjustDy,
      angle: absoluteGuess.angle,
      pivot: absoluteGuess.pivot
    }

    // Apply the absolute transform to the INITIAL profile and constraints
    const nextProfile = transformProfile(initialFeature.sketch.profile, (p) => applyTransform(p, finalAbsoluteTransform))
    const nextConstraints = initialFeature.sketch.constraints.map((ic) => {
      const currentC = feature.sketch.constraints.find(cc => cc.id === ic.id) || ic
      if (ic.type !== 'fixed_distance' || !ic.anchor_point) return ic
      
      // Update anchor point from initial
      const nextAnchor = applyTransform(ic.anchor_point, finalAbsoluteTransform)
      
      // Inherit updated reference points/segments from the CURRENT state (which was updated by dependents loop)
      return { 
        ...currentC, 
        anchor_point: nextAnchor 
      }
    })

    // Refresh semantic caches for constraints that have semantic indices
    const refreshedConstraints = nextConstraints.map((c) => {
      if (c.type !== 'fixed_distance') return c
      const refFeatureId = c.reference_feature_id ?? c.segment_ids[0]
      const refFeature = refFeatureId ? currentById.get(refFeatureId) : null
      const result = rederiveConstraintGeometry(nextProfile, refFeature?.sketch.profile ?? null, c)
      if (!result) return c
      return {
        ...c,
        anchor_point: result.anchorPoint,
        reference_point: result.referencePoint,
        reference_segment: result.referenceSegment,
        is_invalid: !result.isValid,
        error_message: result.errorMessage,
      }
    })
    
    currentById.set(fid, {
      ...feature,
      sketch: { ...feature.sketch, profile: nextProfile, constraints: refreshedConstraints },
    })

    transforms.set(fid, finalAbsoluteTransform)

    // Notify dependents that this feature's absolute transform has changed
    for (const depId of dependents.get(fid) ?? []) {
      if (movedIds.has(depId) || depId === fid) continue
      const depFeature = currentById.get(depId)
      const depInitialFeature = initialFeatures.get(depId)
      if (!depFeature || !depInitialFeature) continue
      
      const depConstraints = depFeature.sketch.constraints.map((c) => {
        if (c.type !== 'fixed_distance' || c.segment_ids.length === 0 || c.segment_ids[0] !== fid) return c
        
        // Find the initial state for this constraint to apply the absolute transform to reference points
        const initialC = depInitialFeature.sketch.constraints.find(ic => ic.id === c.id) || c
        const next: LocalConstraint = { ...c }
        let cChanged = false
        
        if (initialC.reference_point) {
          next.reference_point = applyTransform(initialC.reference_point, finalAbsoluteTransform)
          cChanged = true
        }
        if (initialC.reference_segment) {
          next.reference_segment = {
            a: applyTransform(initialC.reference_segment.a, finalAbsoluteTransform),
            b: applyTransform(initialC.reference_segment.b, finalAbsoluteTransform),
          }
          cChanged = true
        }
        return cChanged ? next : c
      })
      currentById.set(depId, { ...depFeature, sketch: { ...depFeature.sketch, constraints: depConstraints } })
      enqueue(depId)
    }
  }

  return features.map((f) => currentById.get(f.id) ?? f)
}

export function propagateConstraintsOnTranslate(
  features: SketchFeature[],
  movedOffsets: Map<string, FeatureOffset>,
  options: { maxVisitsPerFeature?: number; transformProfile: (profile: SketchFeature['sketch']['profile'], transformPoint: (p: Point) => Point) => SketchFeature['sketch']['profile'] },
): SketchFeature[] {
  if (movedOffsets.size === 0) return features

  const featureById = new Map<string, SketchFeature>(features.map((f) => [f.id, f]))
  const movedTransforms = new Map<string, Transform>()

  for (const [id, offset] of movedOffsets) {
    const feature = featureById.get(id)
    if (!feature) continue
    movedTransforms.set(id, {
      tx: offset.dx,
      ty: offset.dy,
      angle: 0,
      pivot: feature.sketch.profile.start,
    })
  }

  return propagateRigidTransforms(features, movedTransforms, options)
}

export function propagateConstraintsOnRotate(
  features: SketchFeature[],
  movedRotations: Map<string, { pivot: Point, angle: number }>,
  options: { maxVisitsPerFeature?: number; transformProfile: (profile: SketchFeature['sketch']['profile'], transformPoint: (p: Point) => Point) => SketchFeature['sketch']['profile'] },
): SketchFeature[] {
  if (movedRotations.size === 0) return features

  const movedTransforms = new Map<string, Transform>()
  for (const [id, rotation] of movedRotations) {
    movedTransforms.set(id, {
      tx: 0,
      ty: 0,
      angle: rotation.angle,
      pivot: rotation.pivot,
    })
  }

  return propagateRigidTransforms(features, movedTransforms, options)
}
