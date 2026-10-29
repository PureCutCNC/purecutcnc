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
 * The chrome both rotary canvas panels share (issue #1112 rt2-b).
 *
 * Turn/Polygon and Thread/Flutes are created and edited in the same page-level
 * canvas panel every other canned shape uses, so the position, the drag handle
 * and the action-row pointer guard come from `useCanvasWorkflowPanel` exactly
 * as they do for the gear and the flat shapes. The two panels differ only in
 * their fields and in which store action they call.
 *
 * `close` is deliberately stable: the panels use it in effect dependencies
 * (Escape, the context-change guard), and a hook return object in a React dep
 * array would fire those effects on every render.
 *
 * The host refs are optional so a panel can be rendered on its own (the tests
 * mount it directly). When absent the panel measures against nothing and simply
 * keeps its margin position.
 */

import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { useCanvasWorkflowPanel } from './useCanvasWorkflowPanel'

/** The canvas plumbing `SketchCanvas` hands a panel. */
export interface RotaryPanelHostRefs {
  /** The canvas container the panel is positioned against. */
  containerRef?: RefObject<HTMLElement | null>
  /** The canvas itself, so closing can return the keyboard to it. */
  canvasRef?: RefObject<HTMLElement | null>
  /** Clears the canvas's transient pointer state when focus goes back. */
  clearTransientCanvasState?: () => void
}

function noop(): void {
  // A standalone panel has no canvas to clear.
}

export interface RotaryPanelChromeOptions extends RotaryPanelHostRefs {
  phaseKey: string
  /** Leave the session: `cancelPendingAdd` in the app, a spy in a test. */
  onClose: () => void
}

export function useRotaryPanelChrome({
  phaseKey,
  onClose,
  containerRef,
  canvasRef,
  clearTransientCanvasState,
}: RotaryPanelChromeOptions) {
  const ownedContainerRef = useRef<HTMLElement | null>(null)
  const ownedCanvasRef = useRef<HTMLElement | null>(null)
  const panel = useCanvasWorkflowPanel({
    open: true,
    phaseKey,
    containerRef: containerRef ?? ownedContainerRef,
    canvasRef: canvasRef ?? ownedCanvasRef,
    clearTransientCanvasState: clearTransientCanvasState ?? noop,
    pageLevel: true,
    // The panel is opened from a toolbar entry, not from a canvas click, so
    // focus stays where the user put it until they reach for a field.
    focusCanvasOnOpen: false,
  })
  // The latest callback, so `close` below can stay identity-stable without
  // reading a prop out of the render phase.
  const latest = useRef(onClose)
  useEffect(() => {
    latest.current = onClose
  }, [onClose])

  /**
   * Leave the form. The canvas gets the keyboard back from the panel's own
   * unmount (`useRestoreCanvasFocus`), so this only ends the pending session —
   * exactly what the other canned-shape panels do on Cancel/Save.
   */
  const close = useCallback(() => {
    latest.current()
  }, [])

  return {
    position: panel.position,
    panelRef: panel.panelRef,
    handleProps: panel.handleProps,
    actionRowProps: panel.actionRowProps,
    close,
  }
}
