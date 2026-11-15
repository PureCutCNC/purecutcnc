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
 * Whether an Edge Route's vertical overcut is applied to any of its targets
 * (issue #834). The overcut only deepens a target that cuts through to the
 * stock bottom, so an operation whose targets all stop inside the material
 * makes no spoilboard cut, and nothing may announce one.
 *
 * The decision is made in the operation's own setup frame — the frame it is
 * generated in — so a Bottom setup reads its targets' depths as it cuts them.
 * Kept apart from `verticalOvercut.ts` so the resolver stays free of the
 * feature and setup imports.
 */

import type { Operation, Project } from '../../types/project'
import { flatFaceProject } from '../aroundFrame'
import { projectInSetupFrame } from '../setupFrameProject'
import { setupFrameForOperation } from '../setupOrientation'
import { resolveFeatureZSpan } from './geometry'
import { splitFeatureTargets } from './regions'
import { cutsThroughStockBottom, isEdgeRouteKind, STOCK_BOTTOM_Z } from './verticalOvercut'

export function edgeRouteOvercutApplies(project: Project, operation: Operation): boolean {
  if (!isEdgeRouteKind(operation.kind)) return false
  if (operation.target.source !== 'features') return false
  const frame = setupFrameForOperation(project, operation)
  const framed = frame ? projectInSetupFrame(flatFaceProject(project), frame) : project
  // An inside route's bands take their depths from these same targets, so a
  // band reaches the stock bottom only when one of its targets does.
  return splitFeatureTargets(framed, operation.target.featureIds).machiningFeatures.some((feature) => {
    const span = resolveFeatureZSpan(framed, feature)
    return span.bottom < span.top && cutsThroughStockBottom(span.bottom, STOCK_BOTTOM_Z)
  })
}
