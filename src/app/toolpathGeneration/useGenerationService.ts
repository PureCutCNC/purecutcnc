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
 * React's binding to the generation service (issue #675).
 *
 * One service per application, subscribed to through `useSyncExternalStore` so
 * status is read the way React expects an external store to be read. The
 * service itself knows nothing about React; this is the only file that joins
 * the two.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Project } from '../../types/project'
import {
  createToolpathGenerationService,
  type GenerationContext,
  type ToolpathGenerationService,
} from './service'
import type { ExecutorKind, GenerationStatusSnapshot } from './types'

export interface GenerationServiceBinding {
  service: ToolpathGenerationService
  status: GenerationStatusSnapshot
  /** Safe to read during render. */
  context: GenerationContext
  /**
   * The same value, for callbacks and effects that run outside render — a save
   * handler, an async continuation — where the committed value is what matters.
   */
  contextRef: React.RefObject<GenerationContext>
}

export function useGenerationService(
  project: Project,
  documentKey: number,
  executor: ExecutorKind = 'inline',
): GenerationServiceBinding {
  const context = useMemo<GenerationContext>(() => ({ project, documentKey }), [project, documentKey])

  // The service reads this when a computation *finishes*, to decide whether the
  // answer still describes the document the user is looking at. It is written in
  // a layout effect rather than during render: a render React discards must not
  // be able to move what a completion is judged against.
  //
  // Layout, not passive: it runs synchronously after commit, so the window in
  // which a completion could see the previous context is the gap between commit
  // and this line rather than a whole frame. A completion landing inside that
  // window is judged against the previous project and returns `superseded`,
  // which costs one regeneration — the conservative direction. It can never
  // install a result against the wrong project, because a result's provenance
  // is the inputs captured when it was submitted, not this value.
  const contextRef = useRef<GenerationContext>(context)
  useLayoutEffect(() => {
    contextRef.current = context
  }, [context])

  // `useState`'s initializer runs exactly once, which is the lazy construction
  // this needs without reading a ref during render.
  //
  // The rule cannot see when `getCurrentContext` is called, so it assumes the
  // worst. The invariant it cannot check is the one the design turns on: the
  // service calls this accessor only when settling a computation — from a
  // Promise continuation or a worker message — and never during render. The
  // service submits no work and creates no worker during render either; that is
  // asserted by `service.test.ts`, which drives it with a hand-released
  // executor and would deadlock if anything ran eagerly.
  // eslint-disable-next-line react-hooks/refs -- accessor is invoked only from async completion paths, never during render
  const [service] = useState<ToolpathGenerationService>(() => createToolpathGenerationService({
    getCurrentContext: () => contextRef.current,
    executor,
  }))

  // Disposal covers unmount and HMR alike: a replaced module leaves a service
  // holding a worker and a cache that nothing will ever read again.
  useEffect(() => {
    return () => { service.dispose() }
  }, [service])

  const subscribe = useCallback((listener: () => void) => service.subscribe(listener), [service])
  const getSnapshot = useCallback(() => service.getSnapshot(), [service])
  const status = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  return { service, status, context, contextRef }
}
