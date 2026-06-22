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

import {
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { SelectionState, SketchEditTool } from '../../store/types'
import { chamferDistanceFromPoint, filletRadiusFromPoint } from '../../store/helpers/referenceTransforms'
import type { Point, Project } from '../../types/project'
import { formatLength, parseLengthInput } from '../../utils/units'

export interface FilletWorkflowCtx {
  projectRef: MutableRefObject<Project>
  selectionRef: MutableRefObject<SelectionState>
  pendingSketchFilletRef: MutableRefObject<{ anchorIndex: number; corner: Point } | null>
  sketchEditPreviewRef: MutableRefObject<{ point: Point; mode: SketchEditTool } | null>
  filletFeaturePoint: (featureId: string, anchorIndex: number, radius: number) => void
  chamferFeaturePoint: (featureId: string, anchorIndex: number, distance: number) => void
  scheduleDraw: () => void
}

export interface FilletWorkflow {
  filletDimensionEdit: { anchorIndex: number; corner: Point; radius: string } | null
  setFilletDimensionEdit: Dispatch<SetStateAction<{ anchorIndex: number; corner: Point; radius: string } | null>>
  filletDimensionEditRef: MutableRefObject<{ anchorIndex: number; corner: Point; radius: string } | null>
  filletRadiusInputRef: RefObject<HTMLInputElement | null>
  filletDimensionEditActive: boolean
  filletCornerPicked: boolean
  setFilletCornerPicked: (picked: boolean) => void
  enterFilletRadiusEdit: () => void
  commitFilletDimension: () => void
  cancelFilletDimension: () => void
}

export function useFilletWorkflow(ctx: FilletWorkflowCtx): FilletWorkflow {
  const {
    projectRef,
    selectionRef,
    pendingSketchFilletRef,
    sketchEditPreviewRef,
    filletFeaturePoint,
    chamferFeaturePoint,
    scheduleDraw,
  } = ctx

  const [filletDimensionEdit, setFilletDimensionEdit] = useState<{
    anchorIndex: number
    corner: Point
    radius: string
  } | null>(null)
  const filletDimensionEditRef = useRef<{
    anchorIndex: number
    corner: Point
    radius: string
  } | null>(null)
  const filletRadiusInputRef = useRef<HTMLInputElement>(null)

  useLayoutEffect(() => {
    filletDimensionEditRef.current = filletDimensionEdit
  })

  const filletDimensionEditActive = filletDimensionEdit != null

  // Reactive mirror of pendingSketchFilletRef so the panel re-renders
  // immediately after a corner pick instead of waiting for a mouse move.
  const [filletCornerPicked, setFilletCornerPicked] = useState(false)

  // Sync the reactive filletCornerPicked flag from the ref every render so the
  // panel steps/actions update on any clear path (including pointer-gesture clears
  // that don't call the explicit setter). Runs without a dependency array
  // intentionally: pendingSketchFilletRef is a ref whose identity never changes,
  // so listing it wouldn't cause re-fires; the sync must run each render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    setFilletCornerPicked(!!pendingSketchFilletRef.current)
  })

  // Focus the radius input when it becomes active
  useEffect(() => {
    if (!filletDimensionEditActive) return
    const frame = window.requestAnimationFrame(() => {
      filletRadiusInputRef.current?.focus({ preventScroll: true })
      filletRadiusInputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [filletDimensionEditActive])

  /** Shared helper: enters the fillet radius-edit mode from either the
   *  "Radius" button or the Tab keyboard handler. Computes the initial
   *  radius from the picked corner + preview point so the two entry
   *  paths can't diverge. */
  function enterFilletRadiusEdit() {
    const pending = pendingSketchFilletRef.current
    const preview = sketchEditPreviewRef.current
    if (!pending || !preview) return
    const featureId = selectionRef.current.selectedFeatureId
    if (!featureId) return
    const feature = projectRef.current.features.find((f) => f.id === featureId) ?? null
    if (!feature) return
    const units = projectRef.current.meta.units
    const radius = selectionRef.current.sketchEditTool === 'chamfer'
      ? chamferDistanceFromPoint(feature, pending.anchorIndex, preview.point)
      : filletRadiusFromPoint(feature, pending.anchorIndex, preview.point)
    setFilletDimensionEdit({
      anchorIndex: pending.anchorIndex,
      corner: pending.corner,
      radius: radius ? formatLength(radius, units) : '',
    })
  }

  function commitFilletDimension() {
    const current = filletDimensionEditRef.current
    const featureId = selectionRef.current.selectedFeatureId
    if (current && featureId) {
      const typedRadius = parseLengthInput(current.radius, projectRef.current.meta.units)
      if (typedRadius !== null && typedRadius > 0) {
        if (selectionRef.current.sketchEditTool === 'chamfer') {
          chamferFeaturePoint(featureId, current.anchorIndex, typedRadius)
        } else {
          filletFeaturePoint(featureId, current.anchorIndex, typedRadius)
        }
      }
    }
    pendingSketchFilletRef.current = null
    sketchEditPreviewRef.current = null
    setFilletDimensionEdit(null)
    setFilletCornerPicked(false)
    scheduleDraw()
  }

  function cancelFilletDimension() {
    pendingSketchFilletRef.current = null
    sketchEditPreviewRef.current = null
    setFilletDimensionEdit(null)
    setFilletCornerPicked(false)
    scheduleDraw()
  }

  return {
    filletDimensionEdit,
    setFilletDimensionEdit,
    filletDimensionEditRef,
    filletRadiusInputRef,
    filletDimensionEditActive,
    filletCornerPicked,
    setFilletCornerPicked,
    enterFilletRadiusEdit,
    commitFilletDimension,
    cancelFilletDimension,
  }
}
