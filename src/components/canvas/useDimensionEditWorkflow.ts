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
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { SketchControlRef } from '../../store/types'
import type { Point, Project, SketchFeature } from '../../types/project'
import { formatLength, parseLengthInput } from '../../utils/units'
import { computeEditDimSteps, type EditDimStep } from './draftHelpers'
import { arcHandleFromRadius, computeDimensionEditPreviewPoint, type DimensionEditState } from './manualEntry'
import { anchorPointForIndex, arcControlPoint } from './profilePrimitives'

export interface DimensionEditWorkflowCtx {
  projectRef: MutableRefObject<Project>
  canvasRef: RefObject<HTMLCanvasElement | null>
  commitHistoryTransaction: () => void
  cancelHistoryTransaction: () => void
  moveFeatureControl: (featureId: string, control: SketchControlRef, point: Point) => void
}

export interface DimensionEditWorkflow {
  dimensionEdit: DimensionEditState | null
  setDimensionEdit: Dispatch<SetStateAction<DimensionEditState | null>>
  dimensionEditRef: MutableRefObject<DimensionEditState | null>
  armedForDimension: boolean
  setArmedForDimension: Dispatch<SetStateAction<boolean>>
  draggingDimensionIdRef: MutableRefObject<string | null>
  dimensionEditControlRef: MutableRefObject<SketchControlRef | null>
  dimensionEditFeatureIdRef: MutableRefObject<string | null>
  editDimStepsRef: MutableRefObject<EditDimStep[]>
  editDimStepIndexRef: MutableRefObject<number>
  widthInputRef: RefObject<HTMLInputElement | null>
  heightInputRef: RefObject<HTMLInputElement | null>
  radiusInputRef: RefObject<HTMLInputElement | null>
  computeEditStepsForControl: (profile: SketchFeature['sketch']['profile'], control: SketchControlRef | null) => EditDimStep[]
  applyEditDimStep: (stepIndex: number, steps: EditDimStep[], featureId: string, units: 'mm' | 'inch') => void
  handleEditDimLiveChange: (field: 'length' | 'angle' | 'radius', value: string) => void
  commitEditDimension: () => void
  cancelEditDimension: () => void
  advanceTabInEditMode: () => void
}

export function useDimensionEditWorkflow(ctx: DimensionEditWorkflowCtx): DimensionEditWorkflow {
  const { projectRef, canvasRef, commitHistoryTransaction, cancelHistoryTransaction, moveFeatureControl } = ctx

  const [dimensionEdit, setDimensionEdit] = useState<DimensionEditState | null>(null)
  const dimensionEditRef = useRef<DimensionEditState | null>(null)
  const dimensionEditControlRef = useRef<SketchControlRef | null>(null)
  const dimensionEditFeatureIdRef = useRef<string | null>(null)
  const editDimStepsRef = useRef<EditDimStep[]>([])
  const editDimStepIndexRef = useRef(0)
  const widthInputRef = useRef<HTMLInputElement>(null)
  const heightInputRef = useRef<HTMLInputElement>(null)
  const radiusInputRef = useRef<HTMLInputElement>(null)
  const draggingDimensionIdRef = useRef<string | null>(null)
  const [armedForDimension, setArmedForDimension] = useState(false)

  useLayoutEffect(() => {
    dimensionEditRef.current = dimensionEdit
  })

  function computeEditStepsForControl(profile: SketchFeature['sketch']['profile'], control: SketchControlRef | null): EditDimStep[] {
    if (!control) {
      return []
    }

    if (control.kind === 'anchor') {
      return computeEditDimSteps(profile, control.index)
    }

    if (control.kind === 'circle_center') {
      return computeEditDimSteps(profile, 0)
    }

    if (control.kind === 'arc_handle') {
      return [{ kind: 'arc_radius', control, arcStartAnchorIndex: control.index }]
    }

    if (control.kind === 'segment') {
      const seg = profile.segments[control.index]
      if (seg.type === 'arc') {
        return [{ kind: 'arc_radius', control: { kind: 'arc_handle', index: control.index }, arcStartAnchorIndex: control.index }]
      }
      const endAnchorIndex = profile.closed
        ? (control.index + 1) % profile.segments.length
        : control.index + 1
      return [{ kind: 'endpoint', control: { kind: 'anchor', index: endAnchorIndex }, fromAnchorIndex: control.index }]
    }

    return []
  }

  function applyEditDimStep(stepIndex: number, steps: EditDimStep[], featureId: string, units: 'mm' | 'inch') {
    if (stepIndex >= steps.length) {
      cancelEditDimension()
      return
    }
    const step = steps[stepIndex]
    dimensionEditControlRef.current = step.control
    const feature = projectRef.current.features.find((f) => f.id === featureId)
    if (!feature) return
    const profile = feature.sketch.profile

    if (step.kind === 'endpoint') {
      const fromPoint = anchorPointForIndex(profile, step.fromAnchorIndex)
      const anchorPos = anchorPointForIndex(profile, step.control.index)
      const dx = anchorPos.x - fromPoint.x
      const dy = anchorPos.y - fromPoint.y
      setDimensionEdit({
        shape: 'composite',
        anchor: fromPoint,
        signX: 1,
        signY: 1,
        activeField: 'length',
        width: '',
        height: '',
        radius: '',
        length: formatLength(Math.hypot(dx, dy), units),
        angle: (Math.atan2(dy, dx) * (180 / Math.PI)).toFixed(2).replace(/\.?0+$/, ''),
      })
    } else {
      const seg = profile.segments[step.control.index]
      if (!seg || (seg.type !== 'arc' && seg.type !== 'circle')) return
      const arcStart = anchorPointForIndex(profile, step.arcStartAnchorIndex)
      const radius = seg.type === 'arc'
        ? Math.hypot(arcStart.x - seg.center.x, arcStart.y - seg.center.y)
        : Math.hypot(profile.start.x - seg.center.x, profile.start.y - seg.center.y)
      const arcMid = seg.type === 'arc'
        ? arcControlPoint(arcStart, seg)
        : seg.center
      setDimensionEdit({
        shape: 'circle',
        anchor: arcMid,
        signX: 1,
        signY: 1,
        activeField: 'radius',
        width: '',
        height: '',
        radius: formatLength(radius, units),
        length: '',
        angle: '',
      })
    }
  }

  function advanceTabInEditMode() {
    const currentEdit = dimensionEditRef.current
    const steps = editDimStepsRef.current
    const stepIndex = editDimStepIndexRef.current
    if (!currentEdit) return

    const step = steps[stepIndex]
    if (step?.kind === 'endpoint' && currentEdit.activeField === 'length') {
      setDimensionEdit({ ...currentEdit, activeField: 'angle' })
      return
    }

    const nextIndex = stepIndex + 1
    editDimStepIndexRef.current = nextIndex
    const featureId = dimensionEditFeatureIdRef.current
    const units = projectRef.current.meta.units
    if (featureId) {
      applyEditDimStep(nextIndex, steps, featureId, units)
    }
  }

  function commitEditDimension() {
    commitHistoryTransaction()
    dimensionEditControlRef.current = null
    dimensionEditFeatureIdRef.current = null
    editDimStepsRef.current = []
    editDimStepIndexRef.current = 0
    setDimensionEdit(null)
    canvasRef.current?.focus({ preventScroll: true })
  }

  function cancelEditDimension() {
    cancelHistoryTransaction()
    dimensionEditControlRef.current = null
    dimensionEditFeatureIdRef.current = null
    editDimStepsRef.current = []
    editDimStepIndexRef.current = 0
    setDimensionEdit(null)
    canvasRef.current?.focus({ preventScroll: true })
  }

  function handleEditDimLiveChange(field: 'length' | 'angle' | 'radius', value: string) {
    const prev = dimensionEditRef.current
    if (!prev) return
    const next = { ...prev, [field]: value }
    setDimensionEdit(next)
    const control = dimensionEditControlRef.current
    const fId = dimensionEditFeatureIdRef.current
    if (!control || !fId) return

    if (control.kind === 'arc_handle') {
      const feature = projectRef.current.features.find((f) => f.id === fId)
      if (!feature) return
      const profile = feature.sketch.profile
      const seg = profile.segments[control.index]
      if (!seg || seg.type !== 'arc') return
      const arcStart = anchorPointForIndex(profile, control.index)
      const newRadius = parseLengthInput(value, projectRef.current.meta.units) ?? 0
      if (newRadius <= 0) return
      const newHandle = arcHandleFromRadius(arcStart, seg, newRadius)
      if (newHandle) moveFeatureControl(fId, control, newHandle)
    } else {
      const pt = computeDimensionEditPreviewPoint(next, projectRef.current.meta.units)
      moveFeatureControl(fId, control, pt)
    }
  }

  return {
    dimensionEdit,
    setDimensionEdit,
    dimensionEditRef,
    armedForDimension,
    setArmedForDimension,
    draggingDimensionIdRef,
    dimensionEditControlRef,
    dimensionEditFeatureIdRef,
    editDimStepsRef,
    editDimStepIndexRef,
    widthInputRef,
    heightInputRef,
    radiusInputRef,
    computeEditStepsForControl,
    applyEditDimStep,
    handleEditDimLiveChange,
    commitEditDimension,
    cancelEditDimension,
    advanceTabInEditMode,
  }
}
