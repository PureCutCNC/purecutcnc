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
import { useProjectStore } from '../store/projectStore'
import { platform } from './index'

// Cached window handle — loaded once on first desktop title update.
let _setWindowTitle: ((title: string) => void) | null = null
function getSetWindowTitle(): Promise<(title: string) => void> {
  if (_setWindowTitle) return Promise.resolve(_setWindowTitle)
  return import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
    const win = getCurrentWindow()
    _setWindowTitle = (t) => win.setTitle(t).catch(() => {})
    return _setWindowTitle
  })
}

interface DesktopIntegrationOptions {
  /** Called when the native "Export G-code" menu item is triggered. */
  onExportGcode: () => void
}

/**
 * Wires up all desktop-specific shell behaviours:
 *  - document.title + Tauri window title updated with file name + dirty indicator
 *  - window close prompt when there are unsaved changes
 *  - native app menu event routing
 *  - drag-and-drop .camj open
 *
 * Safe to call in the browser — all Tauri-specific listeners are guarded by
 * `platform.isDesktop` and loaded lazily so the web bundle is not affected.
 */
export function useDesktopIntegration({ onExportGcode }: DesktopIntegrationOptions) {
  // Keep a ref so event handlers always call the latest version without
  // needing to be re-registered when the callback identity changes.
  const onExportGcodeRef = useRef(onExportGcode)
  useEffect(() => {
    onExportGcodeRef.current = onExportGcode
  })

  // -------------------------------------------------------------------------
  // Title bar — reactive on filePath, dirty, projectName.
  // Uses plain useEffect with explicit deps so React drives the updates.
  // The desktop setup effect (below) stays on [] deps for a different reason.
  // -------------------------------------------------------------------------
  const filePath = useProjectStore((s) => s.filePath)
  const dirty = useProjectStore((s) => s.dirty)
  const projectName = useProjectStore((s) => s.project.meta.name)

  useEffect(() => {
    const baseName = filePath
      ? (filePath.split('/').pop()?.replace(/\.camj$/, '') ?? projectName)
      : projectName
    const title = dirty
      ? `\u2022 ${baseName} \u2014 PureCutCNC`
      : `${baseName} \u2014 PureCutCNC`

    document.title = title

    if (platform.isDesktop) {
      getSetWindowTitle().then((setTitle) => setTitle(title))
    }
  }, [filePath, dirty, projectName])

  // -------------------------------------------------------------------------
  // Desktop-only: window close prompt, menu events, drag-and-drop
  //
  // Runs ONCE on mount. Uses:
  //  - isCancelled flag — prevents late-resolving async setup from
  //    registering listeners after the effect has already been cleaned up
  //  - useProjectStore.getState() inside handlers — always reads fresh state
  //    without needing the effect to re-run
  //  - onExportGcodeRef — stable ref to the latest callback
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!platform.isDesktop) return

    let isCancelled = false
    const cleanups: (() => void)[] = []

    async function setup() {
      const [{ getCurrentWindow }, { listen }, { readTextFile }, { invoke }] = await Promise.all([
        import('@tauri-apps/api/window'),
        import('@tauri-apps/api/event'),
        import('@tauri-apps/plugin-fs'),
        import('@tauri-apps/api/core'),
      ])
      if (isCancelled) return

      const win = getCurrentWindow()
      let exitFlowActive = false

      async function handleAppExitRequest() {
        if (exitFlowActive) {
          return
        }

        exitFlowActive = true
        try {
          const { dirty: currentDirty } = useProjectStore.getState()
          const ok = !currentDirty || await platform.confirmDiscardChanges()

          if (!ok) {
            await invoke('cancel_app_exit_request').catch(() => {})
            return
          }

          await invoke('request_app_exit')
        } catch (error) {
          await invoke('cancel_app_exit_request').catch(() => {})
          alert(error instanceof Error ? error.message : 'Failed to close the application.')
        } finally {
          exitFlowActive = false
        }
      }

      // -- Window close prompt -----------------------------------------------
      // Route window-close through the same app-exit path as Quit / Cmd+Q.
      const unlistenClose = await win.onCloseRequested(async (event) => {
        event.preventDefault()
        await handleAppExitRequest()
      })
      if (isCancelled) { unlistenClose(); return }
      cleanups.push(unlistenClose)

      // -- App exit requests -------------------------------------------------
      // Quit / Cmd+Q can bypass window-close semantics, so intercept the app
      // exit request emitted by the Rust shell and re-use the same dirty check.
      const unlistenAppExit = await listen('app-exit-requested', async () => {
        await handleAppExitRequest()
      })
      if (isCancelled) { unlistenAppExit(); return }
      cleanups.push(unlistenAppExit)

      // -- Native menu events ------------------------------------------------
      const unlistenMenu = await listen<string>('menu', async (event) => {
        const store = useProjectStore.getState()

        switch (event.payload) {
          case 'new': {
            const ok = store.dirty ? await platform.confirmDiscardChanges() : true
            if (ok) window.dispatchEvent(new CustomEvent('purecutcnc:new-project'))
            break
          }
          case 'open': {
            if (store.dirty) {
              const ok = await platform.confirmDiscardChanges()
              if (!ok) break
            }
            const result = await platform.openProjectFile()
            if (result) {
              try {
                store.openProjectFromText(result.content, result.path)
              } catch (error) {
                alert(error instanceof Error ? error.message : 'Failed to open project.')
              }
            }
            break
          }
          case 'save': {
            const s = useProjectStore.getState()
            const json = s.saveProject()
            const savedPath = await platform.saveProjectFile(
              s.project.meta.name.replace(/\s+/g, '_'),
              json,
              s.filePath
            )
            if (savedPath) s.markSaved(savedPath)
            break
          }
          case 'save_as': {
            const s = useProjectStore.getState()
            const json = s.saveProject()
            const savedPath = await platform.saveProjectFile(
              s.project.meta.name.replace(/\s+/g, '_'),
              json,
              null // always show dialog
            )
            if (savedPath) s.markSaved(savedPath)
            break
          }
          case 'export_gcode':
            onExportGcodeRef.current()
            break
          case 'quit':
            await handleAppExitRequest()
            break
          case 'select_all': {
            const visibleIds = store.project.features
              .filter((f) => f.visible)
              .map((f) => f.id)
            store.selectFeatures(visibleIds)
            break
          }
          case 'undo':
            store.undo()
            break
          case 'redo':
            store.redo()
            break
        }
      })
      if (isCancelled) { unlistenMenu(); return }
      cleanups.push(unlistenMenu)

      // -- Drag-and-drop .camj open ------------------------------------------
      const unlistenDrop = await win.onDragDropEvent(async (event) => {
        if (event.payload.type !== 'drop') return
        const camjPath = event.payload.paths.find((p) =>
          p.toLowerCase().endsWith('.camj')
        )
        if (!camjPath) return

        const { dirty: currentDirty } = useProjectStore.getState()
        if (currentDirty) {
          const ok = await platform.confirmDiscardChanges()
          if (!ok) return
        }

        try {
          const content = await readTextFile(camjPath)
          useProjectStore.getState().openProjectFromText(content, camjPath)
        } catch {
          alert('Failed to open dropped file.')
        }
      })
      if (isCancelled) { unlistenDrop(); return }
      cleanups.push(unlistenDrop)
    }

    setup()

    return () => {
      isCancelled = true
      cleanups.forEach((fn) => fn())
    }
  }, []) // Intentionally empty — event handlers read live state via getState()
}
