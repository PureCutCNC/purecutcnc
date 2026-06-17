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
import type { Point, Project } from '../../types/project'
import { parseLengthInput } from '../../utils/units'

export interface FilletWorkflowCtx {
  projectRef: MutableRefObject<Project>
  selectionRef: MutableRefObject<SelectionState>
  pendingSketchFilletRef: MutableRefObject<{ anchorIndex: number; corner: Point } | null>
  sketchEditPreviewRef: MutableRefObject<{ point: Point; mode: SketchEditTool } | null>
  filletFeaturePoint: (featureId: string, anchorIndex: number, radius: number) => void
  scheduleDraw: () => void
}

export interface FilletWorkflow {
  filletDimensionEdit: { anchorIndex: number; corner: Point; radius: string } | null
  setFilletDimensionEdit: Dispatch<SetStateAction<{ anchorIndex: number; corner: Point; radius: string } | null>>
  filletDimensionEditRef: MutableRefObject<{ anchorIndex: number; corner: Point; radius: string } | null>
  filletRadiusInputRef: RefObject<HTMLInputElement | null>
  filletDimensionEditActive: boolean
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

  // Focus the radius input when it becomes active
  useEffect(() => {
    if (!filletDimensionEditActive) return
    const frame = window.requestAnimationFrame(() => {
      filletRadiusInputRef.current?.focus({ preventScroll: true })
      filletRadiusInputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [filletDimensionEditActive])

  function commitFilletDimension() {
    const current = filletDimensionEditRef.current
    const featureId = selectionRef.current.selectedFeatureId
    if (current && featureId) {
      const typedRadius = parseLengthInput(current.radius, projectRef.current.meta.units)
      if (typedRadius !== null && typedRadius > 0) {
        filletFeaturePoint(featureId, current.anchorIndex, typedRadius)
      }
    }
    pendingSketchFilletRef.current = null
    sketchEditPreviewRef.current = null
    setFilletDimensionEdit(null)
    scheduleDraw()
  }

  function cancelFilletDimension() {
    pendingSketchFilletRef.current = null
    sketchEditPreviewRef.current = null
    setFilletDimensionEdit(null)
    scheduleDraw()
  }

  return {
    filletDimensionEdit,
    setFilletDimensionEdit,
    filletDimensionEditRef,
    filletRadiusInputRef,
    filletDimensionEditActive,
    commitFilletDimension,
    cancelFilletDimension,
  }
}
