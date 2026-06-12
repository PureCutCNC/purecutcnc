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

import { useEffect, type RefObject } from 'react'
import { useStableEvent } from './useStableEvent'

/**
 * `addEventListener` options carry registration semantics (`capture`, `passive`,
 * `once`), so changing them requires re-subscribing. To keep these hooks
 * subscribe-once, pass a **stable** options value — a module-level constant or a
 * memoized object — never a fresh object literal created during render.
 */
type ListenerOptions = boolean | AddEventListenerOptions

/**
 * Subscribe a `window` event listener once for the component's lifetime.
 *
 * The handler is routed through {@link useStableEvent}, so the subscription
 * effect never depends on the handler's identity and does not re-bind when the
 * component re-renders — while the handler body still sees the latest props /
 * state on every event.
 */
export function useWindowEvent<K extends keyof WindowEventMap>(
  type: K,
  handler: (event: WindowEventMap[K]) => void,
  options?: ListenerOptions,
): void {
  const stableHandler = useStableEvent(handler)
  useEffect(() => {
    const listener = (event: WindowEventMap[K]): void => stableHandler(event)
    window.addEventListener(type, listener, options)
    return () => window.removeEventListener(type, listener, options)
  }, [type, stableHandler, options])
}

/**
 * Subscribe a `document` event listener once for the component's lifetime.
 * See {@link useWindowEvent} for the stable-handler rationale.
 */
export function useDocumentEvent<K extends keyof DocumentEventMap>(
  type: K,
  handler: (event: DocumentEventMap[K]) => void,
  options?: ListenerOptions,
): void {
  const stableHandler = useStableEvent(handler)
  useEffect(() => {
    const listener = (event: DocumentEventMap[K]): void => stableHandler(event)
    document.addEventListener(type, listener, options)
    return () => document.removeEventListener(type, listener, options)
  }, [type, stableHandler, options])
}

/**
 * Subscribe an event listener on the element referenced by `ref`.
 *
 * The handler is routed through {@link useStableEvent} so the effect subscribes
 * once and only re-runs if the referenced element, event type, or options
 * change. The element is read from `ref.current` inside the effect, so the ref
 * must be attached to a rendered node by commit time (the typical case for an
 * unconditionally rendered element such as a `<canvas>`).
 */
export function useEventListener<T extends HTMLElement, K extends keyof HTMLElementEventMap>(
  ref: RefObject<T | null>,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
  options?: ListenerOptions,
): void {
  const stableHandler = useStableEvent(handler)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const listener = (event: HTMLElementEventMap[K]): void => stableHandler(event)
    element.addEventListener(type, listener, options)
    return () => element.removeEventListener(type, listener, options)
  }, [ref, type, stableHandler, options])
}
