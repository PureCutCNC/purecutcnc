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

import type { ResolvedTheme } from './theme'

export interface CanvasThemePalette {
  background: string
  gridMajor: string
  gridMinor: string
  labelBackground: string
  labelText: string
  mutedGeometry: string
  veil: string
  /** Active/selected control fill (was hardcoded amber). */
  active: string
  /** Active/selected control ring/stroke (was hardcoded amber). */
  activeStrong: string
  /** Drawing/preview stroke while sketching (was hardcoded amber). */
  draft: string
  /** Draft ring / close-target highlight (was hardcoded amber). */
  draftStrong: string
}

export interface ThreeThemePalette {
  background: number
  gridMinorCenter: number
  gridMinor: number
  gridMajorCenter: number
  gridMajor: number
}

export interface ThemePalette {
  canvas: CanvasThemePalette
  three: ThreeThemePalette
}

export const THEME_PALETTES: Record<ResolvedTheme, ThemePalette> = {
  dark: {
    canvas: {
      background: '#0f151d',
      gridMajor: 'rgba(104, 132, 154, 0.34)',
      gridMinor: 'rgba(88, 112, 130, 0.18)',
      labelBackground: 'rgba(18, 26, 36, 0.88)',
      labelText: 'rgba(218, 232, 244, 0.96)',
      mutedGeometry: 'rgba(210, 221, 230, 0.62)',
      veil: 'rgba(8, 12, 18, 0.5)',
      active: '#4ea3ef',
      activeStrong: '#9bd0ff',
      draft: '#5aa6e8',
      draftStrong: '#bfe0ff',
    },
    three: {
      background: 0x141820,
      gridMinorCenter: 0x223344,
      gridMinor: 0x223344,
      gridMajorCenter: 0x334455,
      gridMajor: 0x51657a,
    },
  },
  light: {
    canvas: {
      background: '#f6f1e7',
      gridMajor: 'rgba(92, 105, 110, 0.32)',
      gridMinor: 'rgba(112, 119, 116, 0.16)',
      labelBackground: 'rgba(255, 252, 246, 0.94)',
      labelText: 'rgba(36, 45, 51, 0.96)',
      mutedGeometry: 'rgba(65, 79, 88, 0.68)',
      veil: 'rgba(246, 241, 231, 0.66)',
      active: '#2f7fc8',
      activeStrong: '#7fb4e6',
      draft: '#3d84c4',
      draftStrong: '#6fa8dc',
    },
    three: {
      background: 0xece7dd,
      gridMinorCenter: 0xb7b1a7,
      gridMinor: 0xc9c3b8,
      gridMajorCenter: 0x827c73,
      gridMajor: 0xaaa399,
    },
  },
}
