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

import type { Project, SketchFeature } from '../types/project'
import { buildCopiedFeatures } from '../store/helpers/copyFeatures'
import type { ProjectStore } from '../store/types'

export type FeatureClipboardPayload = SketchFeature[]

export const FEATURE_CLIPBOARD_OFFSET = 10

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

export function buildPastedClipboardFeatures(
  clipboard: FeatureClipboardPayload,
  project: Project,
): SketchFeature[] {
  if (clipboard.length === 0) {
    return []
  }

  return buildCopiedFeatures(
    clipboard,
    project.features,
    FEATURE_CLIPBOARD_OFFSET,
    FEATURE_CLIPBOARD_OFFSET,
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

export function pasteClipboardFeatures(store: ProjectStore, clipboard: FeatureClipboardPayload): string[] {
  const features = buildPastedClipboardFeatures(clipboard, store.project)
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
