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

      // If THIS feature was moved manually (seed), we update the constraint value to the new distance.
      if (t && movedIds.has(id) && cChanged) {
        if (nextC.anchor_point && (nextC.reference_segment || nextC.reference_point)) {
           // We prefer calculating perpendicular distance to segment if available
           if (nextC.reference_segment) {
             const { a, b } = nextC.reference_segment
             const dx = b.x - a.x
             const dy = b.y - a.y
             const len = Math.hypot(dx, dy)
             if (len > 1e-12) {
               const nx = -dy / len
               const ny = dx / len
               nextC.value = (nextC.anchor_point.x - a.x) * nx + (nextC.anchor_point.y - a.y) * ny
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
      
      // Calculate guessed anchor position by applying absolute transform to INITIAL anchor
      const initialAnchor = initialFeature.sketch.constraints.find(ic => ic.id === c.id)?.anchor_point ?? c.anchor_point
      const guessedAnchor = applyTransform(initialAnchor, absoluteGuess)
      
      // We prefer using the segment constraint if available, as it's more flexible during rotation
      if (c.reference_segment) {
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
    
    currentById.set(fid, {
      ...feature,
      sketch: { ...feature.sketch, profile: nextProfile, constraints: nextConstraints },
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
