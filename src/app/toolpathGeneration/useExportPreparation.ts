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
 * React's binding to export preparation (issue #675).
 *
 * The rules live in `exportPreparation.ts`; this drives them from the dialog's
 * state and keeps two guarantees the component would otherwise have to
 * remember:
 *
 * - a preparation whose inputs have changed is **immediately not exportable**,
 *   rather than a stale preview that still looks saveable, and
 * - the bytes handed to the save dialog are the ones that were prepared, frozen
 *   at the moment Save is pressed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MachineDefinition } from '../../engine/gcode/types'
import {
  createExportToken,
  prepareExport,
  tokenMatchesContext,
  type ExportPostOptions,
  type ExportPreparation,
} from './exportPreparation'
import type { GenerationContext, ToolpathGenerationService } from './service'

/** Matches the debounce the synchronous dialog used, so typing does not thrash generation. */
const PREPARE_DEBOUNCE_MS = 300

/**
 * Stand-in identity for a token built when no machine is selected. The token
 * exists only so the blocked state carries the inputs it refers to; it can
 * never match a live context, because `tokenMatchesContext` refuses a null
 * definition outright.
 */
const NO_MACHINE = { id: '' } as MachineDefinition

export interface UseExportPreparationArgs {
  service: ToolpathGenerationService
  contextRef: React.RefObject<GenerationContext>
  /** Selected operations, already in project order — that is the order they are cut in. */
  operationIds: string[]
  definition: MachineDefinition | null
  options: ExportPostOptions
  /** Bumped by the caller to force a re-preparation (project edits, machine changes). */
  revision: unknown
}

export interface ExportPreparationBinding {
  preparation: ExportPreparation | null
  /**
   * Re-check the prepared program against the live context and hand back its
   * bytes, or null if anything moved. Called at the moment Save is pressed —
   * the preview being ready a moment ago is not the same as it being ready now.
   */
  takeExportable: () => { gcode: string; documentKey: number; operationNames: string[] } | null
}

export function useExportPreparation({
  service,
  contextRef,
  operationIds,
  definition,
  options,
  revision,
}: UseExportPreparationArgs): ExportPreparationBinding {
  const [preparation, setPreparation] = useState<ExportPreparation | null>(null)
  const nextTokenId = useRef(1)

  const operationKey = operationIds.join(',')
  const optionsKey = `${options.emitToolChanges}|${options.emitCoolant}|${options.captureMotionTrace}|${options.programName}`

  useEffect(() => {
    const context = contextRef.current
    const controller = new AbortController()
    let cancelled = false

    // Any change invalidates the previous preparation *before* the new one
    // starts, so there is no window in which a stale program still reads as
    // ready.
    setPreparation(null)

    // No machine is a terminal state, not something to wait on: reported at
    // once rather than after a debounce that could never produce a program.
    if (!definition) {
      setPreparation({
        status: 'blocked',
        token: createExportToken(nextTokenId.current, context, operationIds, NO_MACHINE, options),
        reason: { kind: 'no-machine' },
      })
      nextTokenId.current += 1
      return () => { cancelled = true; controller.abort() }
    }

    const timer = setTimeout(() => {
      const token = createExportToken(nextTokenId.current, context, operationIds, definition, options)
      nextTokenId.current += 1
      void prepareExport(service, context, token, definition, options, controller.signal)
        .then((result) => {
          if (!cancelled) setPreparation(result)
        })
    }, PREPARE_DEBOUNCE_MS)

    return () => {
      cancelled = true
      controller.abort()
      clearTimeout(timer)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the value of the inputs, not their identity
  }, [service, contextRef, operationKey, optionsKey, definition, revision])

  const takeExportable = useCallback(() => {
    if (!preparation || preparation.status !== 'ready') return null
    const context = contextRef.current
    if (!tokenMatchesContext(preparation.token, context, operationIds, definition, options)) {
      return null
    }
    // The bytes are copied out here and never read again from state: once the
    // platform dialog is open the preview may be replaced underneath it, and
    // the file must be the program the user approved.
    return {
      gcode: preparation.result.gcode,
      documentKey: preparation.token.documentKey,
      operationNames: preparation.operations.map((row) => row.operation.name),
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- as above
  }, [preparation, contextRef, operationKey, optionsKey, definition])

  return useMemo(() => ({ preparation, takeExportable }), [preparation, takeExportable])
}
