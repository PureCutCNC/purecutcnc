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

import { useMemo, type RefObject } from 'react'
import { useDocumentEvent, useWindowEvent } from './useEventListener'

/** Something `.contains(node)` can be asked of — an element or any DOM node. */
interface ContainerLike {
  contains: (other: Node | null) => boolean
}

/**
 * React-free core: is `target` outside *every* container?
 *
 * A pointer-down inside any container (trigger button, portaled popover, …) is
 * treated as "inside" and must NOT dismiss. Containers whose ref is still `null`
 * (not yet mounted) are skipped — matching the hand-rolled
 * `ref.current?.contains(target)` guards, where a null ref simply fails the
 * "inside" check. Returns `true` only when the target is contained by none of
 * them, i.e. a genuine outside click.
 */
export function isOutside(target: Node | null, containers: ReadonlyArray<ContainerLike | null>): boolean {
  for (const container of containers) {
    if (container && container.contains(target)) {
      return false
    }
  }
  return true
}

/**
 * React-free core: should this keydown dismiss the element? Mirrors every call
 * site's `if (event.key === 'Escape')` guard.
 */
export function isDismissKey(key: string): boolean {
  return key === 'Escape'
}

/** Where the dismissal listeners are attached. */
export type OutsideDismissTarget = 'document' | 'window'

export interface UseOutsideDismissOptions {
  /** Whether the element is currently open. Listeners are inert while closed. */
  open: boolean
  /**
   * The element(s) that count as "inside". Pass the trigger plus any portaled
   * popover/menu so a click on either does not dismiss. A single ref or an array
   * are both accepted; `null` current values are skipped.
   */
  refs: RefObject<HTMLElement | null> | ReadonlyArray<RefObject<HTMLElement | null>>
  /**
   * Called once when a pointer-down lands outside every ref, or when Escape is
   * pressed, while `open`. Both paths share this single callback — exactly how
   * the migrated sites dismiss on either gesture.
   */
  onDismiss: () => void
  /**
   * Listener target. Most popovers subscribe on `document`; the tree context
   * menu historically subscribes on `window`. For bubble-phase `pointerdown` /
   * `keydown` the two are equivalent, but this preserves each site's original
   * target exactly. Defaults to `'document'`. Must be stable across renders.
   */
  target?: OutsideDismissTarget
}

/**
 * Dismiss an open element on a pointer-down outside it **or** on Escape.
 *
 * Built on the subscribe-once {@link useDocumentEvent} / {@link useWindowEvent}
 * primitives (which route handlers through `useStableEvent`), so the listeners
 * bind once and always see the latest `open` / refs / `onDismiss` rather than
 * re-binding every render. While `open` is `false` — or the event arrives on a
 * target other than the configured one — both handlers early-return, so a closed
 * element is inert. This is behaviourally identical to the prior pattern of
 * subscribing only while open, without re-subscribing on each open/close.
 *
 * Both `document` and `window` are subscribed once for the component's lifetime;
 * the `target` option selects which one actually dispatches, so switching it
 * never re-binds. The inside/outside and Escape decisions live in the React-free
 * cores {@link isOutside} / {@link isDismissKey}, unit-tested without a DOM.
 */
export function useOutsideDismiss({ open, refs, onDismiss, target = 'document' }: UseOutsideDismissOptions): void {
  // Normalize to an array once. The handlers read `.current` from each ref at
  // event time, so identity churn of an inline array would be harmless, but
  // memoizing keeps a single-ref call site from re-allocating each render.
  const refList = useMemo(() => (Array.isArray(refs) ? refs : [refs]), [refs])

  function dismissOnOutsidePointer(on: OutsideDismissTarget) {
    return (event: PointerEvent): void => {
      if (!open || on !== target) {
        return
      }
      if (isOutside(event.target as Node | null, refList.map((ref) => ref.current))) {
        onDismiss()
      }
    }
  }

  function dismissOnEscape(on: OutsideDismissTarget) {
    return (event: KeyboardEvent): void => {
      if (!open || on !== target) {
        return
      }
      if (isDismissKey(event.key)) {
        onDismiss()
      }
    }
  }

  // Subscribe-once on both targets; only the configured `target` dispatches.
  // (Hooks must run unconditionally, so we can't pick one target's hook.)
  useDocumentEvent('pointerdown', dismissOnOutsidePointer('document'))
  useDocumentEvent('keydown', dismissOnEscape('document'))
  useWindowEvent('pointerdown', dismissOnOutsidePointer('window'))
  useWindowEvent('keydown', dismissOnEscape('window'))
}
