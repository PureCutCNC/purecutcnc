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

import type { Operation, Point, Project } from '../../types/project'
import { resolveProject } from '../../store/helpers/resolveFeatures'
import { expandFeatureGeometry } from '../../text'
import { flattenProfile } from '../../engine/toolpaths/geometry'
import { setupFace, setupForOperation } from '../../engine/setupOrientation'
import { localPlasmaStartPoint } from '../../engine/toolpaths/plasmaStartPoint'
import { activeSetup } from '../../store/helpers/activeFace'

/** UI eligibility is shared by picking, markers and the optional override list. */
export function plasmaStartContours(project: Project, operation: Operation) {
  if (operation.kind !== 'plasma_profile' || operation.target.source !== 'features') return []
  try {
    const setup = setupForOperation(project, operation)
    if (setupFace(setup ?? activeSetup(project)) !== 'top'
      || (setup && setup.id !== activeSetup(project).id)) return []
  } catch { return [] }
  const ids = operation.target.featureIds
  return resolveProject(project).features.filter((feature) => ids.includes(feature.id) && feature.visible && (feature.authoringFace ?? 'top') === 'top')
    .flatMap((feature) => expandFeatureGeometry(feature, false)
      .filter((target) => target.kind !== 'stl' && ['add', 'subtract', 'line'].includes(target.operation) && target.sketch.profile.closed)
      .map((target) => ({ id: target.id, name: target.name, profile: target.sketch.profile, transform: feature.transform })))
}
/** Pick only a visible, targeted closed contour; never a nearby unrelated feature. */
export function pickPlasmaStartPoint(project: Project, operation: Operation, point: Point, tolerance: number): { point: Point; local: Point; contourId: string } | null {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !(tolerance > 0)) return null
  let best: { point: Point; local: Point; contourId: string } | null = null
  let distance = tolerance
  for (const target of plasmaStartContours(project, operation)) {
    const ring = flattenProfile(target.profile).points
    for (let index = 0; index < ring.length; index++) {
      const a = ring[index], b = ring[(index + 1) % ring.length]
      const dx = b.x - a.x, dy = b.y - a.y
      const lengthSquared = dx * dx + dy * dy
      const t = lengthSquared ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared)) : 0
      const projected = { x: a.x + t * dx, y: a.y + t * dy }
      const candidateDistance = Math.hypot(point.x - projected.x, point.y - projected.y)
      if (candidateDistance <= distance) {
        const local = localPlasmaStartPoint(target.transform, projected)
        if (local) { distance = candidateDistance; best = { point: projected, local, contourId: target.id } }
      }
    }
  }
  return best
}
