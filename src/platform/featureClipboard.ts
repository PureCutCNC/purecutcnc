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

import { getProfileBounds } from '../types/project'
import type { Point, Project, SketchFeature } from '../types/project'
import { buildCopiedFeatures } from '../store/helpers/copyFeatures'
import type { ProjectStore } from '../store/types'

export type FeatureClipboardPayload = SketchFeature[]

export const FEATURE_CLIPBOARD_PLACEMENT_EVENT = 'purecutcnc:place-feature-clipboard'

export interface FeatureClipboardBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined') {
    return false
  }

  if (!(target instanceof HTMLElement)) {
    return false
  }

  if (target.isContentEditable) {
    return true
  }

  return target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !== null
}

export function selectedVisibleClipboardFeatures(project: Project, selectedFeatureIds: string[]): FeatureClipboardPayload {
  const selectedIds = new Set(selectedFeatureIds)
  return project.features
    .filter((feature) => selectedIds.has(feature.id) && feature.visible)
    .map((feature) => JSON.parse(JSON.stringify(feature)) as SketchFeature)
}

export function featureClipboardBounds(clipboard: FeatureClipboardPayload): FeatureClipboardBounds | null {
  let bounds: FeatureClipboardBounds | null = null

  for (const feature of clipboard) {
    const featureBounds = getProfileBounds(feature.sketch.profile)
    bounds = bounds
      ? {
          minX: Math.min(bounds.minX, featureBounds.minX),
          minY: Math.min(bounds.minY, featureBounds.minY),
          maxX: Math.max(bounds.maxX, featureBounds.maxX),
          maxY: Math.max(bounds.maxY, featureBounds.maxY),
        }
      : { ...featureBounds }
  }

  return bounds
}

export function featureClipboardAnchor(clipboard: FeatureClipboardPayload): Point | null {
  const bounds = featureClipboardBounds(clipboard)
  return bounds
    ? {
        x: (bounds.minX + bounds.maxX) / 2,
        y: (bounds.minY + bounds.maxY) / 2,
      }
    : null
}

export function buildPlacedClipboardFeatures(
  clipboard: FeatureClipboardPayload,
  project: Project,
  placementPoint: Point,
): SketchFeature[] {
  const anchor = featureClipboardAnchor(clipboard)
  if (!anchor) {
    return []
  }

  return buildCopiedFeatures(
    clipboard,
    project.features,
    placementPoint.x - anchor.x,
    placementPoint.y - anchor.y,
    1,
    project.featureDefinitions,
    project.meta.copyMode,
  )
}

export function copySelectedFeatures(store: ProjectStore): FeatureClipboardPayload | null {
  const features = selectedVisibleClipboardFeatures(store.project, store.selection.selectedFeatureIds)
  return features.length > 0 ? features : null
}

export function cutSelectedFeatures(store: ProjectStore): FeatureClipboardPayload | null {
  const features = copySelectedFeatures(store)
  if (!features) {
    return null
  }

  store.deleteFeatures(features.map((feature) => feature.id))
  return features
}

export function pasteClipboardFeatures(
  store: ProjectStore,
  clipboard: FeatureClipboardPayload,
  placementPoint: Point,
): string[] {
  const features = buildPlacedClipboardFeatures(clipboard, store.project, placementPoint)
  if (features.length === 0) {
    return []
  }

  store.beginHistoryTransaction()
  for (const feature of features) {
    store.addFeature(feature)
  }
  store.selectFeatures(features.map((feature) => feature.id))
  store.commitHistoryTransaction()
  return features.map((feature) => feature.id)
}
