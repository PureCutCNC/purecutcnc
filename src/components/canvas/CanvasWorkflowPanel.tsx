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

import { Children } from 'react'
import { createPortal } from 'react-dom'
import type { HTMLAttributes, KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react'
import { useI18n } from '../../i18n/i18nContext'
import type { CanvasWorkflowPanelPosition } from './useCanvasWorkflowPanel'

// Anything the browser would land Tab on. The tabindex="-1" exclusion matters:
// actions that carry a keyboard shortcut opt themselves out of the tab ring, and
// without this they would still match `button:not([disabled])` and get wrapped into.
const FOCUSABLE_SELECTOR = [
  'button:not([disabled]):not([tabindex="-1"])',
  'input:not([disabled]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

interface CanvasWorkflowPanelProps {
  title: string
  step?: ReactNode
  children: ReactNode
  actions: ReactNode
  position: CanvasWorkflowPanelPosition
  panelRef: RefObject<HTMLDivElement | null>
  handleProps: HTMLAttributes<HTMLDivElement>
  actionRowProps?: HTMLAttributes<HTMLDivElement>
  className?: string
  moveLabel?: string
  /**
   * Render through a portal to document.body with `position: fixed`, so the
   * panel can be dragged anywhere on the page. Must match the `pageLevel`
   * option on the `useCanvasWorkflowPanel` call that produced `position`.
   */
  pageLevel?: boolean
}

export function CanvasWorkflowPanel({
  title,
  step,
  children,
  actions,
  position,
  panelRef,
  handleProps,
  actionRowProps,
  className = '',
  moveLabel,
  pageLevel = false,
}: CanvasWorkflowPanelProps) {
  const { t } = useI18n()
  const resolvedMoveLabel = moveLabel ?? t('canvas.common.moveControls')
  const panelClassName = ['canvas-workflow-panel', pageLevel ? 'canvas-workflow-panel--page' : '', className].filter(Boolean).join(' ')
  // Call sites pass conditional fragments, so an "empty" body arrives as [false, false]
  // — truthy as an array. Children.toArray drops null/undefined/booleans, leaving [].
  const hasBody = Children.toArray(children).length > 0

  /**
   * Keep Tab inside the panel once focus is in it, so it cycles the panel's own
   * controls instead of walking out into the app toolbar.
   *
   * Capture phase on purpose: the dimension inputs stopPropagation() in their own
   * onKeyDown, so a bubble-phase listener here would never see the Tab that escapes
   * from a field. Focus still reaches the panel normally from the canvas — this only
   * wraps at the ends — and Esc still cancels back out to the canvas.
   */
  function containTabWithinPanel(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab') {
      return
    }

    const root = panelRef.current
    if (!root) {
      return
    }

    const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter((element) => element.offsetParent !== null)
    if (focusable.length === 0) {
      return
    }

    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement

    // A single focusable wraps onto itself, which is what stops the lone Cancel
    // button in a collapsed panel from handing focus to the toolbar.
    if (event.shiftKey && active === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const panelElement = (
    <div
      ref={panelRef}
      className={panelClassName}
      style={{ left: position.x, top: position.y }}
      onKeyDownCapture={containTabWithinPanel}
    >
      <div className="canvas-workflow-panel__header">
        {/*
          Pointer-only affordance: handleProps are all onPointer*, with no key
          handling, so a tabIndex here would park focus on something no key can
          operate — and steal Tab, which the canvas uses to open dimension entry.
          The title/step text stays readable because no aria-label overrides it.
        */}
        <div className="canvas-workflow-panel__handle" {...handleProps}>
          <span className="canvas-workflow-panel__grip" aria-hidden="true" title={resolvedMoveLabel} />
          <span className="canvas-workflow-panel__heading">
            <span className="canvas-workflow-panel__title">{title}</span>
            {step ? <span className="canvas-workflow-panel__step">{step}</span> : null}
          </span>
        </div>
        <div className="canvas-workflow-panel__actions" {...actionRowProps}>
          {actions}
        </div>
      </div>
      {hasBody ? <div className="canvas-workflow-panel__body">{children}</div> : null}
    </div>
  )

  if (pageLevel) {
    return createPortal(panelElement, document.body)
  }

  return panelElement
}
