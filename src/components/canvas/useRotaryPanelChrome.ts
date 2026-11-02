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
 * The keys the action row advertises (Esc/Enter) are shared here too
 * (`useRotaryPanelKeyboard`), so the guard that keeps one keystroke from
 * running two actions is written once.
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

export interface RotaryPanelKeyboardOptions {
  /** Leave the form: the panel's stable close action. */
  onClose: () => void
  /** Apply the form, exactly as the Create/Save action does. */
  onApply: () => void
  /** Whether that action would do anything: a refused or unchanged form must not apply. */
  canApply: boolean
}

/**
 * The keys the panel's action row advertises, honoured while the form is open
 * (issue #1112 rt2-b review finding 2).
 *
 * `CanvasWorkflowConfirm` is labelled `Create (Enter)` and is deliberately not
 * a tab stop, so without this the only keyboard route to Create/Save is the
 * pointer. Escape closes the form even when a field has focus (the canvas's own
 * handler does not see a keystroke typed into a panel field); Enter applies it
 * only when the action is enabled and the key was not aimed at a control that
 * already turns Enter into its own action — one keystroke must never run two
 * things, and a button that has focus owns its own activation.
 *
 * The callbacks and the flag are read from a ref the render refreshes, so the
 * listener subscribes once: the two functions are new every render, and listing
 * them as effect dependencies would resubscribe on every keystroke.
 */
export function useRotaryPanelKeyboard({ onClose, onApply, canApply }: RotaryPanelKeyboardOptions): void {
  const latest = useRef({ onClose, onApply, canApply })
  useEffect(() => {
    latest.current = { onClose, onApply, canApply }
  })
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        latest.current.onClose()
        return
      }
      if (event.key !== 'Enter' || event.defaultPrevented || !latest.current.canApply) return
      const target = event.target
      // A button (the panel's own Create/Save, a picker trigger) or an open
      // list's option already maps Enter to itself.
      if (target instanceof Element && target.closest('button, select, [role="option"]') !== null) return
      event.preventDefault()
      latest.current.onApply()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])
}
