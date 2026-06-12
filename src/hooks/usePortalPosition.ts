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

import { useLayoutEffect, useState, type RefObject } from 'react'
import { useStableEvent } from './useStableEvent'

export interface PortalCoords {
  top: number
  left: number
}

/**
 * React-free: what the hook returns for a given `open` flag and last measured
 * value. Closed → `null` (derived during render, so no `setState` is needed for
 * the closed case); open → the measured coords.
 */
export function selectPortalCoords(open: boolean, measured: PortalCoords | null): PortalCoords | null {
  return open ? measured : null
}

/**
 * React-free dedupe used by the layout-effect's reposition handler: return the
 * previous value (stable identity → no re-render) when the position is unchanged,
 * otherwise the next value. Keeps scroll/resize events from churning renders.
 */
export function nextPortalCoords(prev: PortalCoords | null, next: PortalCoords): PortalCoords {
  return prev && prev.top === next.top && prev.left === next.left ? prev : next
}

/**
 * Positions a portaled floating element (tooltip / popover) from its anchor's
 * bounding rect, recomputing while it is `open` as the page scrolls or resizes.
 *
 * The floating element is rendered in a portal on `document.body` so a scrolling /
 * overflow-clipping ancestor (e.g. the left tool rail) cannot cut it off; this
 * hook supplies its fixed coords.
 *
 * Why this shape: the **closed → null** case is derived during render
 * (`selectPortalCoords`), never set in an effect — that is the React-recommended
 * way to avoid `react-hooks/set-state-in-effect`. The only `setState` happens from
 * the initial DOM measurement and the scroll/resize subscriptions, which is the
 * legitimate "external system" effect pattern: the value is a measured `DOMRect`,
 * not something derivable during render.
 *
 * On an open transition the render briefly returns the previous coords, but the
 * `useLayoutEffect` re-measures and re-renders before the browser paints, so a
 * stale position is never visible. Call sites keep their own `visibility` /
 * off-screen fallback for the first frame before the measurement lands.
 *
 * `measure` may be a fresh closure each render (it commonly captures `side` /
 * offset props); it is routed through {@link useStableEvent} so the layout effect
 * subscribes once per open instead of re-binding on every render.
 */
export function usePortalPosition(
  anchorRef: RefObject<HTMLElement | null>,
  floatingRef: RefObject<HTMLElement | null>,
  open: boolean,
  measure: (anchor: DOMRect, floating: DOMRect) => PortalCoords,
): PortalCoords | null {
  const [coords, setCoords] = useState<PortalCoords | null>(null)
  const measureStable = useStableEvent(measure)

  useLayoutEffect(() => {
    if (!open) {
      return
    }
    function reposition() {
      const anchor = anchorRef.current
      const floating = floatingRef.current
      if (!anchor || !floating) {
        return
      }
      const next = measureStable(anchor.getBoundingClientRect(), floating.getBoundingClientRect())
      setCoords((prev) => nextPortalCoords(prev, next))
    }
    reposition()
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open, anchorRef, floatingRef, measureStable])

  return selectPortalCoords(open, coords)
}
