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
import { getProfileBounds, type Point, type Project, type TextLayout } from '../../types/project'
import { cloneProfile } from '../../geometry/profile'
import { profilePathLength } from '../../sketch/featureDistribution'
import {
  createDefaultTextLayout,
  arcRadiusForCenter,
  localTextLayout,
  mirrorAnchorAngleForDirection,
  type TextLayoutKind,
} from '../../sketch/textPlacement'
import { straightTextRunWidth } from '../../text'
import { cloneProject, syncFeatureTreeProject } from '../helpers/normalize'
import { applyMatrixToPoint } from '../helpers/resolveFeatures'
import { invertMatrix } from '../helpers/instanceTransforms'
import { nextPlacementSession } from '../helpers/ids'
import { resolveFeatureInstance } from '../helpers/resolveFeatures'
import type { ProjectStore } from '../types'
import type { TextToolConfig } from '../../text'

export type TextLayoutSlice = Pick<
  ProjectStore,
  | 'pendingTextLayout'
  | 'startTextLayout'
  | 'cancelTextLayout'
  | 'updateTextLayout'
  | 'setTextLayoutPickTarget'
  | 'setTextLayoutCenter'
  | 'setTextLayoutGuide'
  | 'completeTextLayout'
>

/** The text tool config a feature's own data describes, for measuring/rebuilding. */
function configOf(
  text: { text: string; style: TextToolConfig['style']; fontId: TextToolConfig['fontId']; size: number },
  operation: TextToolConfig['operation'],
  layout: TextLayout | null,
): TextToolConfig {
  return { text: text.text, style: text.style, fontId: text.fontId, size: text.size, operation, layout }
}

/**
 * Re-derive an arc's radius from a picked centre, the way
 * `planFeatureDistribution` derives a radial distribution's radius from where
 * its source already sits.
 */
function arcLayoutForCenter(
  project: Project,
  featureId: string,
  layout: TextLayout | null,
  center: Point,
): TextLayout | null {
  if (layout?.kind !== 'arc') return layout
  const feature = resolveFeatureInstance(project, featureId)
  if (!feature) return layout
  const radius = arcRadiusForCenter(getProfileBounds(feature.sketch.profile), layout.direction, center)
  return radius > 1e-9 ? { ...layout, radius } : layout
}

export function createTextLayoutSlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
  get: Parameters<StateCreator<ProjectStore>>[1],
): TextLayoutSlice {
  return {
    pendingTextLayout: null,

    startTextLayout: (kind?: TextLayoutKind) => set((s) => {
      const featureId = s.selection.selectedFeatureId
      if (!featureId) return {}
      const feature = resolveFeatureInstance(s.project, featureId)
      if (!feature || !feature.text || feature.locked) return {}

      // Reopening on a run that already curves keeps its current baseline, so
      // the edit is repeatable rather than a one-shot that starts from scratch.
      // One menu entry opens the panel, so the mode comes from the run itself:
      // whatever baseline it already has, or an arc to start from.
      const existing = feature.textLayout ?? null
      const wanted = kind ?? existing?.kind ?? 'arc'
      const layout = existing?.kind === wanted
        ? existing
        : createDefaultTextLayout(wanted, straightTextRunWidth(configOf(feature.text, feature.operation, null)))

      return {
        pendingAdd: null,
        pendingMove: null,
        pendingTransform: null,
        pendingOffset: null,
        pendingShapeAction: null,
        pendingFeatureDistribution: null,
        sketchEditSession: null,
        pendingTextLayout: {
          featureId,
          layout,
          center: null,
          guideId: null,
          pickTarget: null,
          directionPinned: existing?.kind === 'arc',
          session: nextPlacementSession(),
        },
      }
    }),

    cancelTextLayout: () => set({ pendingTextLayout: null }),

    updateTextLayout: (layout: TextLayout | null) => set((s) => {
      const pending = s.pendingTextLayout
      if (!pending) return {}

      const previous = pending.layout
      const kindChanged = (previous?.kind ?? null) !== (layout?.kind ?? null)

      // Setting the direction by hand stops the drag inferring it from which
      // side of the centre the cursor is on. Switching modes hands control
      // back, since the new layout's direction was never chosen by anyone.
      const directionFlipped = previous?.kind === 'arc'
        && layout?.kind === 'arc'
        && previous.direction !== layout.direction

      // Flipping the direction moves the run to the other half of the circle.
      // `cw` writes across the top and `ccw` across the bottom, both reading
      // left to right; reversing travel while leaving the run at 12 o'clock
      // would just render it upside down there.
      const flipped = directionFlipped && layout?.kind === 'arc'
        ? { ...layout, angleDegrees: mirrorAnchorAngleForDirection(layout.angleDegrees) }
        : layout
      // The attach edge changes with the direction, so a picked centre implies a
      // different radius — otherwise flipping moves the run off the circle.
      const nextLayout = directionFlipped && pending.center
        ? arcLayoutForCenter(s.project, pending.featureId, flipped, pending.center)
        : flipped

      return {
        pendingTextLayout: {
          ...pending,
          layout: nextLayout,
          // A different baseline means the centre picked for the old one is
          // meaningless, so the gesture restarts.
          center: kindChanged ? null : pending.center,
          guideId: layout?.kind === 'path' ? pending.guideId : null,
          pickTarget: layout?.kind === 'path' ? pending.pickTarget : null,
          directionPinned: kindChanged ? false : pending.directionPinned || directionFlipped,
        },
      }
    }),

    setTextLayoutPickTarget: (pickTarget) => set((s) => {
      const pending = s.pendingTextLayout
      if (!pending) return {}
      if (pickTarget === 'guide' && pending.layout?.kind !== 'path') return {}
      if (pickTarget === 'center' && pending.layout?.kind !== 'arc') return {}
      return { pendingTextLayout: { ...pending, pickTarget } }
    }),

    setTextLayoutCenter: (center: Point | null) => set((s) => {
      const pending = s.pendingTextLayout
      if (!pending) return {}

      // Radius is derived, not typed: it is the distance from the run's own
      // pivot to the picked centre, which is exactly how `planFeatureDistribution`
      // derives the radius of a radial distribution from its source. Picking the
      // centre is therefore the whole gesture.
      const nextLayout = center
        ? arcLayoutForCenter(s.project, pending.featureId, pending.layout, center)
        : pending.layout

      // Picking ends when the centre lands, the same way the distribution
      // radial pick does — the panel comes straight back.
      return {
        pendingTextLayout: {
          ...pending,
          center,
          layout: nextLayout,
          pickTarget: center ? null : pending.pickTarget,
        },
      }
    }),

    setTextLayoutGuide: (featureId: string) => set((s) => {
      const pending = s.pendingTextLayout
      if (!pending || pending.featureId === featureId) return {}
      const layout = pending.layout
      if (layout?.kind !== 'path') return {}

      const guide = resolveFeatureInstance(s.project, featureId)
      if (!guide || guide.kind === 'stl' || guide.sketch.profile.segments.length === 0) return {}
      const guideLength = profilePathLength(guide.sketch.profile)
      if (guideLength <= 0) return {}

      return {
        pendingTextLayout: {
          ...pending,
          guideId: featureId,
          pickTarget: null,
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
      }
    }),

    completeTextLayout: () => {
      const state = get()
      const pending = state.pendingTextLayout
      if (!pending) return []
      const feature = resolveFeatureInstance(state.project, pending.featureId)
      if (!feature || !feature.text) return []

      const layout = pending.layout
      // An arc needs its centre and a path needs its guide; without them the
      // run would quietly stay straight, which reads as the button doing
      // nothing at all.
      if (layout?.kind === 'arc' && !pending.center) return []
      if (layout?.kind === 'path' && layout.path.segments.length === 0) return []

      const toLocal = invertMatrix(feature.transform)
      const localLayout = localTextLayout(
        layout,
        pending.center,
        (point) => applyMatrixToPoint(toLocal, point),
      )

      set((s) => ({
        project: syncFeatureTreeProject({
          ...s.project,
          // The baseline lands on the instance row, never on the shared
          // definition — that is the whole point of the per-copy behaviour.
          features: s.project.features.map((row) => (
            row.id === pending.featureId
              ? { ...row, textLayout: localLayout }
              : row
          )),
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        }),
        pendingTextLayout: null,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }))
      return [pending.featureId]
    },
  }
}
