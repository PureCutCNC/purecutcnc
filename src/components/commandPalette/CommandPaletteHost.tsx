/**
 * Copyright 2026 Maik Rolf
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

import { useCallback, useEffect, useRef, useState } from 'react'
import { CommandPalette } from './CommandPalette'
import { COMMAND_PALETTE_OPEN_EVENT } from './events'

export interface CommandPaletteHostProps {
  onNewProject: () => void
  onImportGeometry?: () => void
  onExportModel: () => void
  onPrintDesign?: () => void
  onRequestText?: () => void
  onZoomToModel: () => void
}

interface CloseOptions {
  restoreFocus?: boolean
}

/**
 * Keeps the palette's store-backed command hooks unmounted while it is closed,
 * owns the global Ctrl/Cmd+K toggle, and returns focus to whatever opened it.
 */
export function CommandPaletteHost(props: CommandPaletteHostProps) {
  const [open, setOpen] = useState(false)
  const openRef = useRef(false)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const restoreFocusOnCloseRef = useRef(true)

  const openPalette = useCallback(() => {
    if (openRef.current) return
    const active = document.activeElement
    returnFocusRef.current = active instanceof HTMLElement ? active : null
    restoreFocusOnCloseRef.current = true
    openRef.current = true
    setOpen(true)
  }, [])

  const close = useCallback((options?: CloseOptions) => {
    openRef.current = false
    restoreFocusOnCloseRef.current = options?.restoreFocus !== false
    setOpen(false)
  }, [])

  useEffect(() => {
    if (open || !restoreFocusOnCloseRef.current) return
    const target = returnFocusRef.current
    if (target?.isConnected) {
      target.focus({ preventScroll: true })
    }
  }, [open])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return
      event.preventDefault()
      if (openRef.current) {
        close()
      } else {
        openPalette()
      }
    }

    function handleOpen() {
      openPalette()
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, handleOpen)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, handleOpen)
    }
  }, [close, openPalette])

  return open ? <CommandPalette {...props} onClose={close} /> : null
}
