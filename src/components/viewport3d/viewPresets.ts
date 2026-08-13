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

import type * as THREE from 'three'
import type { MessageKey } from '../../i18n/locales/en'

/**
 * Camera view presets shared by the 3D preview and simulation viewports.
 *
 * Each preset is a spherical-coordinate orientation around the orbit target.
 * `null` means the camera has been free-orbited/panned/zoomed away from any
 * named preset — rendered as "Custom view" in the {@link ViewPresetMenu}.
 *
 * Extracted from the duplicated `createOrbitControls` closures that lived in
 * both `Viewport3D.tsx` and `SimulationViewport.tsx` (issue #243).
 */

export type ViewPreset = 'iso' | 'top' | 'bottom' | 'front' | 'back' | 'right' | 'left'

export interface ViewPresetSpherical {
  theta: number
  phi: number
  up: THREE.Vector3Tuple
}

export const DEFAULT_CAMERA_SPHERICAL = {
  theta: Math.PI / 4,
  phi: Math.PI / 3,
  radius: 250,
}

export const MIN_CAMERA_RADIUS = 0.1
export const MAX_CAMERA_RADIUS = 10000

export const VIEW_PRESETS: Record<ViewPreset, ViewPresetSpherical> = {
  iso: {
    theta: DEFAULT_CAMERA_SPHERICAL.theta,
    phi: DEFAULT_CAMERA_SPHERICAL.phi,
    up: [0, 1, 0],
  },
  // Exactly vertical, so these are true plan views: no perspective skew, and a
  // part with depth shows no wall thickness. Their own `up` keeps `lookAt` well
  // defined at the pole, where world up would be parallel to the view direction.
  // Free orbit clamps phi off the pole before it renders, so the epsilon these
  // used to carry is not needed here. Issue #493.
  top: {
    theta: 0,
    phi: 0,
    up: [0, 0, -1],
  },
  bottom: {
    theta: 0,
    phi: Math.PI,
    up: [0, 0, 1],
  },
  front: {
    theta: 0,
    phi: Math.PI / 2,
    up: [0, 1, 0],
  },
  back: {
    theta: Math.PI,
    phi: Math.PI / 2,
    up: [0, 1, 0],
  },
  right: {
    theta: Math.PI / 2,
    phi: Math.PI / 2,
    up: [0, 1, 0],
  },
  left: {
    theta: (3 * Math.PI) / 2,
    phi: Math.PI / 2,
    up: [0, 1, 0],
  },
}

/**
 * Display order in the {@link ViewPresetMenu}: isometric first (the default),
 * then the six orthographic faces.
 */
export const VIEW_PRESET_ORDER: readonly ViewPreset[] = [
  'iso',
  'top',
  'bottom',
  'front',
  'back',
  'right',
  'left',
] as const

export interface ViewPresetMeta {
  iconId: string
  labelKey: MessageKey
}

/**
 * Per-preset icon sprite id and i18n label key.
 *
 * `null` (custom view) maps to `view-free` / `viewport.presets.free`.
 */
const VIEW_PRESET_META: Record<ViewPreset, ViewPresetMeta> = {
  iso: { iconId: 'view-iso', labelKey: 'viewport.presets.iso' },
  top: { iconId: 'view-top', labelKey: 'viewport.presets.top' },
  bottom: { iconId: 'view-bottom', labelKey: 'viewport.presets.bottom' },
  front: { iconId: 'view-front', labelKey: 'viewport.presets.front' },
  back: { iconId: 'view-back', labelKey: 'viewport.presets.back' },
  right: { iconId: 'view-right', labelKey: 'viewport.presets.right' },
  left: { iconId: 'view-left', labelKey: 'viewport.presets.left' },
}

const FREE_VIEW_META: ViewPresetMeta = {
  iconId: 'view-free',
  labelKey: 'viewport.presets.free',
}

/** Icon id and label key for a preset, or the custom-view fallback when `null`. */
export function viewPresetMeta(preset: ViewPreset | null): ViewPresetMeta {
  if (preset === null) {
    return FREE_VIEW_META
  }
  return VIEW_PRESET_META[preset]
}
