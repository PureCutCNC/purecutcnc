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

import { useCallback, useInsertionEffect, useRef } from 'react'

/**
 * React-free core of {@link useStableEvent}, extracted so the stable-identity /
 * latest-fn invariants can be unit-tested without a DOM or React renderer.
 *
 * Holds a mutable "latest" function. `invoke` has a fixed identity for the
 * lifetime of the instance and always forwards to the most recently stored fn.
 */
export function createStableEvent<A extends unknown[], R>(initial: (...args: A) => R) {
  let latest = initial
  const invoke = (...args: A): R => latest(...args)
  const setLatest = (next: (...args: A) => R): void => {
    latest = next
  }
  return { invoke, setLatest }
}

/**
 * Returns a callback with a **stable identity** across renders whose body always
 * reflects the latest `fn`. The latest fn is refreshed in `useInsertionEffect`
 * (before layout/paint and passive effects) — never during render — so this is
 * the React-recommended replacement for the `ref.current = fn` render-write
 * anti-pattern.
 *
 * Because the returned wrapper never changes identity, it is safe to omit from
 * (or list in) effect dependency arrays, letting event-listener effects
 * subscribe once instead of re-binding on every render.
 *
 * Note: like the canonical "useEvent" pattern, the wrapper should be invoked
 * from event handlers / effects, not called during render.
 */
export function useStableEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const store = useRef<ReturnType<typeof createStableEvent<A, R>> | null>(null)
  if (store.current === null) {
    store.current = createStableEvent(fn)
  }

  useInsertionEffect(() => {
    store.current?.setLatest(fn)
  })

  // The wrapper reads the ref only when invoked (in an event handler / effect),
  // never during render, and has a stable identity via useCallback([]).
  return useCallback((...args: A): R => store.current!.invoke(...args), [])
}
