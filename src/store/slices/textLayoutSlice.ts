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
 * Text-layout workflow actions.
 *
 * These drive the canvas panel while a text run is being placed. Placement
 * itself still belongs to `pendingAddSlice` — this slice only edits the pending
 * run's baseline and the guide behind it.
 */

import type { StateCreator } from 'zustand'
import type { TextLayout } from '../../types/project'
import { cloneProfile } from '../../geometry/profile'
import { profilePathLength } from '../../sketch/featureDistribution'
import { resolveFeatureInstance } from '../helpers/resolveFeatures'
import type { ProjectStore } from '../types'

export type TextLayoutSlice = Pick<
  ProjectStore,
  | 'updateTextLayout'
  | 'setTextLayoutPickTarget'
  | 'setPendingTextAnchor'
  | 'setTextLayoutGuide'
  | 'completeTextLayout'
>

export function createTextLayoutSlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
  get: Parameters<StateCreator<ProjectStore>>[1],
): TextLayoutSlice {
  return {
    updateTextLayout: (layout: TextLayout | null) => set((s) => {
      const pending = s.pendingAdd
      if (pending?.shape !== 'text') return {}

      const previous = pending.config.layout ?? null
      const kindChanged = (previous?.kind ?? null) !== (layout?.kind ?? null)

      // Setting the direction by hand stops the drag inferring it from which
      // side of the centre the cursor is on. Switching modes hands control
      // back, since the new layout's direction was never chosen by anyone.
      const directionPinned = kindChanged
        ? false
        : pending.directionPinned
          || (previous?.kind === 'arc' && layout?.kind === 'arc' && previous.direction !== layout.direction)

      return {
        pendingAdd: {
          ...pending,
          config: { ...pending.config, layout },
          // A different baseline means the centre picked for the old one is
          // meaningless, so the gesture restarts.
          anchor: kindChanged ? null : pending.anchor,
          guideId: layout?.kind === 'path' ? pending.guideId : null,
          pickTarget: layout?.kind === 'path' ? pending.pickTarget : null,
          directionPinned,
        },
      }
    }),

    setTextLayoutPickTarget: (pickTarget) => set((s) => {
      const pending = s.pendingAdd
      if (pending?.shape !== 'text') return {}
      if (pickTarget === 'guide' && pending.config.layout?.kind !== 'path') return {}
      return { pendingAdd: { ...pending, pickTarget } }
    }),

    setPendingTextAnchor: (anchor) => set((s) => {
      const pending = s.pendingAdd
      if (pending?.shape !== 'text') return {}
      return { pendingAdd: { ...pending, anchor } }
    }),

    setTextLayoutGuide: (featureId: string) => set((s) => {
      const pending = s.pendingAdd
      if (pending?.shape !== 'text') return {}
      const layout = pending.config.layout
      if (layout?.kind !== 'path') return {}

      const guide = resolveFeatureInstance(s.project, featureId)
      if (!guide || guide.kind === 'stl' || guide.sketch.profile.segments.length === 0) return {}
      const guideLength = profilePathLength(guide.sketch.profile)
      if (guideLength <= 0) return {}

      return {
        pendingAdd: {
          ...pending,
          guideId: featureId,
          pickTarget: null,
          config: {
            ...pending.config,
            layout: {
              ...layout,
              // The guide is *baked*, not linked: a definition cannot hold a
              // world-space reference to another feature and still resolve
              // under every instance's own transform. Moving the guide later
              // does not reflow the text.
              path: cloneProfile(guide.sketch.profile),
              // A newly picked guide defaults to its whole length, so the first
              // preview is usable without anyone touching the offsets.
              startOffset: pending.guideId === featureId ? layout.startOffset : 0,
              endOffset: pending.guideId === featureId ? layout.endOffset : guideLength,
            },
          },
        },
      }
    }),

    completeTextLayout: () => {
      const pending = get().pendingAdd
      if (pending?.shape !== 'text') return []
      const layout = pending.config.layout
      if (layout?.kind !== 'path') return []
      // No guide means no baseline, and the run would quietly commit as
      // straight text instead of following anything. Refuse rather than
      // create something the user did not ask for.
      if (layout.path.segments.length === 0) return []
      // The baked guide already carries the run's world position, so a path
      // layout commits at the origin rather than at a placement click.
      return get().placePendingTextAt({ x: 0, y: 0 })
    },
  }
}
