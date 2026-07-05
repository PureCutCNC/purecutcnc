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
 * Pure scene-bounds helpers shared by the sketch canvas (zoom-to-model) and the
 * design-print engine (visible-design print extents). Framework-free.
 */

import { getFeatureGeometryProfiles } from '../text'
import { getProfileBounds, rectProfile } from '../types/project'
import type { Bounds2D, Project, SketchProfile } from '../types/project'

/**
 * Bounds of everything currently visible in the 2D sketch scene: stock,
 * feature geometry (text resolved), tabs, clamps, origin marker, and backdrop.
 * Falls back to the stock profile when nothing is visible.
 */
export function getVisibleSceneBounds2D(project: Project): Bounds2D {
  const profiles: SketchProfile[] = []

  if (project.stock.visible) {
    profiles.push(project.stock.profile)
  }

  for (const feature of project.features) {
    if (feature.visible) {
      profiles.push(...getFeatureGeometryProfiles(feature))
    }
  }

  for (const tab of project.tabs) {
    if (tab.visible) {
      profiles.push(rectProfile(tab.x, tab.y, tab.w, tab.h))
    }
  }

  for (const clamp of project.clamps) {
    if (clamp.visible) {
      profiles.push(rectProfile(clamp.x, clamp.y, clamp.w, clamp.h))
    }
  }

  if (profiles.length === 0) {
    profiles.push(project.stock.profile)
  }

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity

  for (const profile of profiles) {
    const bounds = getProfileBounds(profile)
    minX = Math.min(minX, bounds.minX)
    maxX = Math.max(maxX, bounds.maxX)
    minY = Math.min(minY, bounds.minY)
    maxY = Math.max(maxY, bounds.maxY)
  }

  if (project.origin.visible) {
    minX = Math.min(minX, project.origin.x)
    maxX = Math.max(maxX, project.origin.x)
    minY = Math.min(minY, project.origin.y)
    maxY = Math.max(maxY, project.origin.y)
  }

  if (project.backdrop?.visible) {
    const halfW = project.backdrop.width / 2
    const halfH = project.backdrop.height / 2
    minX = Math.min(minX, project.backdrop.center.x - halfW)
    maxX = Math.max(maxX, project.backdrop.center.x + halfW)
    minY = Math.min(minY, project.backdrop.center.y - halfH)
    maxY = Math.max(maxY, project.backdrop.center.y + halfH)
  }

  return { minX, maxX, minY, maxY }
}
