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

import { useEffect, useRef, useState, type RefObject } from 'react'
import type { Project } from '../../types/project'
import { useProjectStore } from '../../store/projectStore'
import { usePlasmaStartPointPick } from '../cam/plasmaStartPointPick'
import { camT } from '../cam/camI18n'
import { canvasToWorld, computeSketchViewTransform, worldToCanvas, type SketchViewState } from './viewTransform'
import { activeSetup } from '../../store/helpers/activeFace'
import { setupFace } from '../../engine/setupOrientation'
import { plasmaStartPointForContour } from '../../engine/toolpaths/plasmaStartPoint'
import { pickPlasmaStartPoint, plasmaStartContours } from './plasmaStartPoint'
import { CanvasWorkflowCancel } from './CanvasWorkflowAction'
import { CanvasWorkflowPanel } from './CanvasWorkflowPanel'
import { useCanvasWorkflowPanel } from './useCanvasWorkflowPanel'

/** Captures only the armed pick gesture, so clicking a contour cannot edit/select it. */
export function PlasmaStartPointPicker({ canvasRef, project, projectKey, viewState, selectedOperationId, available }: {
  canvasRef: RefObject<HTMLCanvasElement | null>; project: Project; projectKey: number
  viewState: SketchViewState; selectedOperationId: string | null; available: boolean
}) {
  const request = usePlasmaStartPointPick((state) => state.request)
  const panel = useCanvasWorkflowPanel({
    open: !!request && available, phaseKey: request?.operationId ?? null,
    containerRef: canvasRef, canvasRef, clearTransientCanvasState: () => {}, pageLevel: true,
  })
  const latest = useRef({ project, projectKey, viewState, selectedOperationId, available })
  const [size, setSize] = useState({ width: 0, height: 0, left: 0, top: 0, cssWidth: 0, cssHeight: 0 })
  const operation = project.operations.find((entry) => entry.id === selectedOperationId && entry.kind === 'plasma_profile')
  useEffect(() => { latest.current = { project, projectKey, viewState, selectedOperationId, available } }, [project, projectKey, viewState, selectedOperationId, available])
  useEffect(() => {
    if (request && (!available || request.projectKey !== projectKey || request.operationId !== selectedOperationId || setupFace(activeSetup(project)) !== 'top')) usePlasmaStartPointPick.getState().cancel()
    if (request && available) canvasRef.current?.focus()
  }, [request, projectKey, selectedOperationId, available, canvasRef, project])
  useEffect(() => () => usePlasmaStartPointPick.getState().cancel(), [projectKey, selectedOperationId, project.setups, operation?.target])
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const resize = () => setSize({ width: canvas.width, height: canvas.height, left: canvas.offsetLeft, top: canvas.offsetTop, cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight })
    const observer = new ResizeObserver(resize)
    observer.observe(canvas); resize()
    const pointers = new Map<number, { x: number; y: number }>()
    let moved = false, multiple = false, suppressClick = false
    const armed = () => {
      const pick = usePlasmaStartPointPick.getState().request
      const context = latest.current
      return pick && context.available && pick.projectKey === context.projectKey && pick.operationId === context.selectedOperationId ? pick : null
    }
    const consume = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation() }
    const down = (event: PointerEvent) => {
      if (!armed() || event.button !== 0) return
      consume(event); suppressClick = true
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (pointers.size > 1) multiple = true
      canvas.setPointerCapture(event.pointerId)
    }
    const move = (event: PointerEvent) => {
      if (!armed()) return
      consume(event)
      const start = pointers.get(event.pointerId)
      if (start && Math.hypot(start.x - event.clientX, start.y - event.clientY) > 8) moved = true
    }
    const up = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return
      consume(event)
      pointers.delete(event.pointerId)
      const pick = armed()
      if (pick && !moved && !multiple && event.type !== 'pointercancel') {
        const context = latest.current
        const op = context.project.operations.find((entry) => entry.id === pick.operationId)
        const rect = canvas.getBoundingClientRect()
        const vt = computeSketchViewTransform(context.project, canvas.width, canvas.height, context.viewState)
        const world = canvasToWorld((event.clientX - rect.left) * canvas.width / rect.width, (event.clientY - rect.top) * canvas.height / rect.height, vt)
        const selected = op && pickPlasmaStartPoint(context.project, op, world, 18 * canvas.width / rect.width / vt.scale)
        if (selected) {
          useProjectStore.getState().updateOperation(pick.operationId, { plasmaStartPoint: undefined, plasmaStartPoints: { ...op.plasmaStartPoints, [selected.contourId]: selected.local } })
          usePlasmaStartPointPick.getState().cancel()
        }
      }
      if (!pointers.size) { moved = false; multiple = false }
    }
    const click = (event: Event) => { if (armed() || suppressClick) { consume(event); suppressClick = false } }
    const key = (event: KeyboardEvent) => {
      if (!armed()) return
      consume(event)
      if (event.key === 'Escape') usePlasmaStartPointPick.getState().cancel()
    }
    canvas.addEventListener('pointerdown', down, true)
    canvas.addEventListener('pointermove', move, true)
    canvas.addEventListener('pointerup', up, true)
    canvas.addEventListener('pointercancel', up, true)
    canvas.addEventListener('click', click, true)
    canvas.addEventListener('keydown', key, true)
    return () => {
      observer.disconnect()
      canvas.removeEventListener('pointerdown', down, true); canvas.removeEventListener('pointermove', move, true)
      canvas.removeEventListener('pointerup', up, true); canvas.removeEventListener('pointercancel', up, true)
      canvas.removeEventListener('click', click, true); canvas.removeEventListener('keydown', key, true)
      usePlasmaStartPointPick.getState().cancel()
    }
  }, [canvasRef])
  if (!available || !operation || !size.width || setupFace(activeSetup(project)) !== 'top') return null
  const vt = computeSketchViewTransform(project, size.width, size.height, viewState)
  const points = plasmaStartContours(project, operation).flatMap((target) => {
    const local = operation.plasmaStartPoints && Object.hasOwn(operation.plasmaStartPoints, target.id) ? operation.plasmaStartPoints[target.id] : undefined
    const point = local && plasmaStartPointForContour(target.profile, target.transform, local)
    return point ? [{ id: target.id, point }] : []
  })
  if (!points.length && operation.plasmaStartPoint) points.push({ id: 'legacy', point: operation.plasmaStartPoint })
  return <>
    {request?.operationId === operation.id && <CanvasWorkflowPanel
      title={camT('cam.plasma.pickStart')}
      position={panel.position} panelRef={panel.panelRef} handleProps={panel.handleProps} actionRowProps={panel.actionRowProps}
      className="canvas-workflow-panel--plasma-start" pageLevel
      dialogAria={{ label: camT('cam.plasma.pickStart'), modal: false }}
      actions={<CanvasWorkflowCancel label={camT('cam.plasma.cancelPick')} onClick={() => usePlasmaStartPointPick.getState().cancel()} />}
    >
      <p className="canvas-workflow-panel__hint" role="status">{camT('cam.plasma.pickHelp')}</p>
    </CanvasWorkflowPanel>}
    {points.length > 0 && <svg aria-label={camT('cam.plasma.selectedStart')} role="img" data-testid="plasma-start-marker"
    viewBox={`0 0 ${size.width} ${size.height}`} style={{ position: 'absolute', left: size.left, top: size.top, width: size.cssWidth, height: size.cssHeight, pointerEvents: 'none' }}>
    {points.map(({ point, id }) => {
      const marker = worldToCanvas(point, vt)
      return <g key={id} data-contour-id={id}>
        <circle data-testid="plasma-start-dot" cx={marker.cx} cy={marker.cy} r="7" fill="none" stroke="currentColor" strokeWidth="3" />
        <path d={`M${marker.cx - 12},${marker.cy}h24 M${marker.cx},${marker.cy - 12}v24`} stroke="currentColor" strokeWidth="2" />
      </g>
    })}
  </svg>}
  </>
}
