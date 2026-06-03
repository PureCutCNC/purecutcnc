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
 *
 * Transient measure/dimension tool state. None of this is persisted to .camj
 * or recorded in undo history — it is purely in-flight interaction state.
 */

import type { StateCreator } from 'zustand'
import { nextPlacementSession } from '../helpers/ids'
import type { DimensionAnchor, DimensionType } from '../../types/project'
import type { PendingDimensionTool, ProjectStore } from '../types'

export type DimensionToolSlice = Pick<
  ProjectStore,
  | 'tapeMeasure'
  | 'pendingDimension'
  | 'dimensionDeleteArmed'
  | 'startTapeMeasure'
  | 'tapeMeasureClick'
  | 'clearTapeMeasure'
  | 'startDimensionTool'
  | 'setPendingDimensionType'
  | 'pendingDimensionPick'
  | 'cancelPendingDimension'
  | 'setDimensionDeleteArmed'
>

/** Anchors required before a dimension of the given type can be committed. */
function requiredAnchors(type: DimensionType): 2 | 3 {
  return type === 'angle' ? 3 : 2
}

/** Clears all other in-flight placement tools so the measure tools are exclusive. */
function clearOtherTools(): Partial<ProjectStore> {
  return {
    pendingAdd: null,
    pendingMove: null,
    pendingTransform: null,
    pendingOffset: null,
    pendingShapeAction: null,
    pendingConstraint: null,
  }
}

export function createDimensionToolSlice(
  set: Parameters<StateCreator<ProjectStore>>[0],
  _get: Parameters<StateCreator<ProjectStore>>[1],
): DimensionToolSlice {
  void _get
  return {
    tapeMeasure: null,
    pendingDimension: null,
    dimensionDeleteArmed: false,

    startTapeMeasure: () =>
      set(() => ({
        ...clearOtherTools(),
        pendingDimension: null,
        dimensionDeleteArmed: false,
        tapeMeasure: { first: null, frozen: null },
      })),

    tapeMeasureClick: (point) =>
      set((s) => {
        const tape = s.tapeMeasure
        if (!tape) {
          return { tapeMeasure: { first: { ...point }, frozen: null } }
        }
        if (!tape.first) {
          // Begin a fresh measurement (also the path after a frozen one).
          return { tapeMeasure: { first: { ...point }, frozen: null } }
        }
        // Second click: freeze the A→B measurement; it shows until the next click.
        return { tapeMeasure: { first: null, frozen: { a: tape.first, b: { ...point } } } }
      }),

    clearTapeMeasure: () => set(() => ({ tapeMeasure: null })),

    startDimensionTool: (type) =>
      set(() => ({
        ...clearOtherTools(),
        tapeMeasure: null,
        dimensionDeleteArmed: false,
        pendingDimension: { type, a: null, b: null, c: null, session: nextPlacementSession() },
      })),

    setPendingDimensionType: (type) =>
      set((s) => {
        if (!s.pendingDimension) {
          return { pendingDimension: { type, a: null, b: null, c: null, session: nextPlacementSession() } }
        }
        // Switching type resets accumulated anchors to avoid mismatched arity.
        return { pendingDimension: { ...s.pendingDimension, type, a: null, b: null, c: null } }
      }),

    pendingDimensionPick: (anchor: DimensionAnchor) =>
      set((s) => {
        const tool = s.pendingDimension
        if (!tool) return {}
        const need = requiredAnchors(tool.type)
        let next: PendingDimensionTool
        if (!tool.a) {
          next = { ...tool, a: anchor }
        } else if (!tool.b) {
          next = { ...tool, b: anchor }
        } else if (need === 3 && !tool.c) {
          next = { ...tool, c: anchor }
        } else {
          return {}
        }
        return { pendingDimension: next }
      }),

    cancelPendingDimension: () => set(() => ({ pendingDimension: null })),

    setDimensionDeleteArmed: (armed) =>
      set(() =>
        armed
          ? { ...clearOtherTools(), tapeMeasure: null, pendingDimension: null, dimensionDeleteArmed: true }
          : { dimensionDeleteArmed: false },
      ),
  }
}
