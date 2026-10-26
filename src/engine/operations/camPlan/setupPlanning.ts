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

import type { Project } from '../../../types/project'
import { activeSetup } from '../../../store/helpers/activeFace'
import { computeOperationToolpath } from '../../toolpaths/generateOperation'
import { operationCutRange } from '../../setupReach'
import { operationFace, isThroughFeature } from '../../setupTargets'
import type { ResolvedSketchFeature } from '../../../store/helpers/resolveFeatures'
import { mirrorProfile } from '../../../store/helpers/transform'
import { setupFace, setupFrame } from '../../setupOrientation'
import { projectInSetupFrame } from '../../setupFrameProject'
import type { RestRegionDraft } from '../../toolpaths/restRegions'

/** Keep setup identity for face gates; only geometry is turned into cutting space. */
export function camPlanSetupProject(project: Project): Project {
  const setup = activeSetup(project)
  if (setupFace(setup) !== 'bottom') return project
  return {
    ...projectInSetupFrame(project, setupFrame(setup.orientation, project.stock)),
    setups: project.setups,
    // Resolvers must not treat work assigned to the other side as machined here.
    operations: project.operations.filter((operation) =>
      operation.setupId === setup.id || setup.operationIds.includes(operation.id),
    ),
  }
}

/** The half-turn is its own inverse. Draft masks are stored in canonical XY. */
export function camPlanRegionsInStockFrame(project: Project, regions: RestRegionDraft[]): RestRegionDraft[] {
  const setup = activeSetup(project)
  if (setupFace(setup) !== 'bottom') return regions
  const frame = setupFrame(setup.orientation, project.stock)
  return regions.map((region) => ({
    ...region,
    profile: mirrorProfile(region.profile, (point) => frame.orientation.axis === 'x'
      ? { x: point.x, y: 2 * frame.pivot.y - point.y }
      : { x: 2 * frame.pivot.x - point.x, y: point.y }),
  }))
}

export function throughFeaturesCoveredByTop(project: Project, features: ResolvedSketchFeature[]): Set<string> {
  const covered = new Set<string>()
  if (setupFace(activeSetup(project)) !== 'bottom') return covered
  for (const operation of project.operations) {
    if (!operation.enabled || operationFace(project, operation) !== 'top'
      || operation.target.source !== 'features') continue
    // Rough stock allowance, countersinks and partial finishing are not a
    // completed through-cut. Measure the generated reach of a completing pass.
    const completesCut = operation.kind === 'drilling'
      ? operation.drillType !== 'countersink'
      : (operation.kind === 'pocket' || operation.kind === 'edge_route_inside')
        && (operation.pass === 'rough' || (operation.finishWalls && operation.finishFloor))
        && operation.stockToLeaveAxial === 0 && operation.stockToLeaveRadial === 0
    if (!completesCut) continue
    const targets = features.filter((feature) => isThroughFeature(project, feature)
      && operation.target.source === 'features' && operation.target.featureIds.includes(feature.id))
    if (targets.length === 0) continue
    const generated = computeOperationToolpath(project, operation)?.result
    if (!generated) continue
    for (const feature of targets) {
      const range = operationCutRange(project, operation, generated, feature.id)
      if (range && range.min <= 1e-7 && range.max >= project.stock.thickness - 1e-7) covered.add(feature.id)
    }
  }
  return covered
}

