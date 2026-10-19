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

import { useEffect, useRef } from 'react'

/**
 * The command palette lives in AppShell, but the import and text dialogs live
 * in the desktop/tablet toolbar assemblies. These events keep the palette free
 * of toolbar state while still letting those two commands open their dialogs.
 */
export const COMMAND_PALETTE_IMPORT_EVENT = 'purecutcnc:command-palette:import'
export const COMMAND_PALETTE_TEXT_EVENT = 'purecutcnc:command-palette:text'

export interface ToolbarPaletteEventHandlers {
  onImportGeometry?: () => void
  onRequestText?: () => void
}

export function useToolbarPaletteEvents(handlers: ToolbarPaletteEventHandlers): void {
  const handlersRef = useRef(handlers)

  useEffect(() => {
    handlersRef.current = handlers
  }, [handlers])

  useEffect(() => {
    function handleImport() {
      handlersRef.current.onImportGeometry?.()
    }

    function handleText() {
      handlersRef.current.onRequestText?.()
    }

    window.addEventListener(COMMAND_PALETTE_IMPORT_EVENT, handleImport)
    window.addEventListener(COMMAND_PALETTE_TEXT_EVENT, handleText)
    return () => {
      window.removeEventListener(COMMAND_PALETTE_IMPORT_EVENT, handleImport)
      window.removeEventListener(COMMAND_PALETTE_TEXT_EVENT, handleText)
    }
  }, [])
}
