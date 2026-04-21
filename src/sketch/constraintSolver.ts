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

import type { LocalConstraint, Point, SketchFeature } from '../types/project'

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
        
        // For point constraints, preserve the original direction relationship
        // Calculate original direction vector from the initial anchor->reference
        const origVx = c.anchor.x - c.reference.x
        const origVy = c.anchor.y - c.reference.y
        const origLen = Math.hypot(origVx, origVy)
        
        if (origLen < 1e-12) continue
        
        // Normalize the original direction vector
        const origUx = origVx / origLen
        const origUy = origVy / origLen
        
        // Calculate current signed distance in the direction of the original vector
        const currentSignedDist = vx * origUx + vy * origUy
        const residual = currentSignedDist - c.distance
        
        // Use the original direction vector for derivatives (Jacobian)
        const jx = origUx
        const jy = origUy
        
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

function signedPerpDistance(p: Point, a: Point, b: Point): number {
  const sx = b.x - a.x
  const sy = b.y - a.y
  const segLen = Math.hypot(sx, sy)
  if (segLen < 1e-12) return 0
  const nx = -sy / segLen
  const ny = sx / segLen
  return (p.x - a.x) * nx + (p.y - a.y) * ny
}

function isFixedDistance(
  c: LocalConstraint,
): c is LocalConstraint & { anchor_point: Point; value: number } {
  return c.type === 'fixed_distance' && !!c.anchor_point && typeof c.value === 'number'
}

function buildInput(c: LocalConstraint): ConstraintInput | null {
  if (!isFixedDistance(c)) return null
  if (c.reference_segment) {
    const signed = signedPerpDistance(c.anchor_point, c.reference_segment.a, c.reference_segment.b)
    const target = signed >= 0 ? c.value : -c.value
    return {
      kind: 'segment',
      anchor: c.anchor_point,
      segmentA: c.reference_segment.a,
      segmentB: c.reference_segment.b,
      signedDistance: target,
    }
  }
  if (c.reference_point) {
    return {
      kind: 'point',
      anchor: c.anchor_point,
      reference: c.reference_point,
      distance: c.value,
    }
  }
  return null
}

function translateAnchorFields(c: LocalConstraint, dx: number, dy: number): LocalConstraint {
  if (c.type !== 'fixed_distance' || !c.anchor_point) return c
  return { ...c, anchor_point: { x: c.anchor_point.x + dx, y: c.anchor_point.y + dy } }
}

function translateReferenceFieldsIfMatches(
  c: LocalConstraint,
  refFeatureId: string,
  dx: number,
  dy: number,
): LocalConstraint {
  if (c.type !== 'fixed_distance' || c.segment_ids.length === 0 || c.segment_ids[0] !== refFeatureId) {
    return c
  }
  const next: LocalConstraint = { ...c }
  if (c.reference_point) {
    next.reference_point = { x: c.reference_point.x + dx, y: c.reference_point.y + dy }
  }
  if (c.reference_segment) {
    next.reference_segment = {
      a: { x: c.reference_segment.a.x + dx, y: c.reference_segment.a.y + dy },
      b: { x: c.reference_segment.b.x + dx, y: c.reference_segment.b.y + dy },
    }
  }
  return next
}

/**
 * Apply a rigid-translation move by `movedOffsets`, then re-solve any features
 * that reference them (and any features transitively referenced by those).
 *
 * Contract for directly-moved features (seeds): their own fixed_distance
 * constraints are cleared. Their reference_points and reference_segments in
 * other features' constraints are translated so downstream features follow.
 */
export function propagateConstraintsOnTranslate(
  features: SketchFeature[],
  movedOffsets: Map<string, FeatureOffset>,
  options: { maxVisitsPerFeature?: number; translateProfile: (profile: SketchFeature['sketch']['profile'], dx: number, dy: number) => SketchFeature['sketch']['profile'] },
): SketchFeature[] {
  const { translateProfile } = options
  const maxVisits = options.maxVisitsPerFeature ?? 6
  if (movedOffsets.size === 0) return features

  const byId = new Map<string, SketchFeature>(features.map((f) => [f.id, f]))
  const movedIds = new Set(movedOffsets.keys())

  for (const [id, feature] of byId) {
    if (movedIds.has(id)) {
      const kept = feature.sketch.constraints.filter((c) => c.type !== 'fixed_distance')
      if (kept.length !== feature.sketch.constraints.length) {
        byId.set(id, { ...feature, sketch: { ...feature.sketch, constraints: kept } })
      }
      continue
    }
    let changed = false
    const nextConstraints = feature.sketch.constraints.map((c) => {
      if (c.type !== 'fixed_distance' || c.segment_ids.length === 0) return c
      const offset = movedOffsets.get(c.segment_ids[0])
      if (!offset) return c
      changed = true
      return translateReferenceFieldsIfMatches(c, c.segment_ids[0], offset.dx, offset.dy)
    })
    if (changed) {
      byId.set(id, { ...feature, sketch: { ...feature.sketch, constraints: nextConstraints } })
    }
  }

  const dependents = new Map<string, Set<string>>()
  for (const feature of byId.values()) {
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

  // First, directly move features that reference moved features by the same offset
  // This ensures they maintain their relative position to their references
  for (const [id, feature] of byId) {
    if (movedIds.has(id)) continue
    if (feature.locked) continue
    
    let totalDx = 0
    let totalDy = 0
    let refCount = 0
    
    for (const c of feature.sketch.constraints) {
      if (c.type !== 'fixed_distance' || c.segment_ids.length === 0) continue
      for (const refId of c.segment_ids) {
        const offset = movedOffsets.get(refId)
        if (offset) {
          totalDx += offset.dx
          totalDy += offset.dy
          refCount++
        }
      }
    }
    
    if (refCount > 0) {
      const avgDx = totalDx / refCount
      const avgDy = totalDy / refCount
      
      if (Math.hypot(avgDx, avgDy) > 1e-7) {
        // Move the feature by the average offset of its references
        const nextProfile = translateProfile(feature.sketch.profile, avgDx, avgDy)
        const nextConstraints = feature.sketch.constraints.map((c) => translateAnchorFields(c, avgDx, avgDy))
        byId.set(id, {
          ...feature,
          sketch: { ...feature.sketch, profile: nextProfile, constraints: nextConstraints },
        })
        
        // Also update reference points for features that depend on this one
        for (const dep of dependents.get(id) ?? []) {
          if (movedIds.has(dep) || dep === id) continue
          const depFeature = byId.get(dep)
          if (!depFeature) continue
          const depConstraints = depFeature.sketch.constraints.map((c) =>
            translateReferenceFieldsIfMatches(c, id, avgDx, avgDy),
          )
          byId.set(dep, { ...depFeature, sketch: { ...depFeature.sketch, constraints: depConstraints } })
        }
      }
    }
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

    const feature = byId.get(fid)
    if (!feature || feature.locked) continue

    const inputs: ConstraintInput[] = []
    for (const c of feature.sketch.constraints) {
      const input = buildInput(c)
      if (input) inputs.push(input)
    }
    if (inputs.length === 0) continue

    const { dx, dy } = solveFeatureTranslation(inputs)
    if (Math.hypot(dx, dy) < 1e-7) continue

    const nextProfile = translateProfile(feature.sketch.profile, dx, dy)
    const nextConstraints = feature.sketch.constraints.map((c) => translateAnchorFields(c, dx, dy))
    byId.set(fid, {
      ...feature,
      sketch: { ...feature.sketch, profile: nextProfile, constraints: nextConstraints },
    })

    for (const dep of dependents.get(fid) ?? []) {
      if (movedIds.has(dep) || dep === fid) continue
      const depFeature = byId.get(dep)
      if (!depFeature) continue
      const depConstraints = depFeature.sketch.constraints.map((c) =>
        translateReferenceFieldsIfMatches(c, fid, dx, dy),
      )
      byId.set(dep, { ...depFeature, sketch: { ...depFeature.sketch, constraints: depConstraints } })
      enqueue(dep)
    }
  }

  return features.map((f) => byId.get(f.id) ?? f)
}
