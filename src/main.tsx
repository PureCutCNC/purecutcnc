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

import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import { renderErrorHTML } from './components/errorFormat'
import { IconGalleryRoute } from './components/IconGallery'
import { UnsupportedMobileScreen } from './components/UnsupportedMobileScreen'
import { isDesktop } from './platform'
import { installAnalytics } from './utils/analytics'
import { applyVersionToTitle } from './utils/version'
import { ThemeProvider } from './theme/ThemeProvider'
import { bootstrapTheme } from './theme/bootstrap'
import { I18nProvider } from './i18n/I18nProvider'
import { bootstrapI18n } from './i18n/bootstrap'
import { bootstrapMachineLibrary } from './machine/bootstrap'

bootstrapTheme()
bootstrapI18n()
bootstrapMachineLibrary()

// Swap #root for a static error card if something throws before React mounts.
// Once React is alive, AppErrorBoundary takes over — this flag prevents the
// global listeners from clobbering a React-rendered tree.
let reactMounted = false

function showFatalErrorHTML(error: unknown, info?: string) {
  if (reactMounted) return
  const root = document.getElementById('root')
  if (!root) return
  root.innerHTML = renderErrorHTML(error, info)
}

window.addEventListener('error', (event) => {
  showFatalErrorHTML(event.error ?? event.message, 'window error')
})
window.addEventListener('unhandledrejection', (event) => {
  showFatalErrorHTML(event.reason, 'unhandled promise rejection')
})

// In the desktop app, the window title is managed by useDesktopIntegration
// (showing filename + dirty flag). Only apply the version title in browser.
if (!isDesktop) {
  applyVersionToTitle()
  installAnalytics()
}

function isPhoneSizedTouchDevice() {
  if (typeof window === 'undefined' || isDesktop) {
    return false
  }

  const mq = window.matchMedia('(pointer: coarse)')
  if (!mq.matches) return false
  const short = Math.min(window.innerWidth, window.innerHeight)
  return short < 500
}

// Dev-only: #icons shows the sprite gallery for visual QA.
const isIconGalleryRoute =
  import.meta.env.DEV &&
  typeof window !== 'undefined' &&
  window.location.hash === '#icons'

function rootElement() {
  return (
    <ThemeProvider>
      <I18nProvider>
        {isPhoneSizedTouchDevice()
          ? <UnsupportedMobileScreen />
          : isIconGalleryRoute
            ? <IconGalleryRoute />
            : (
                <AppErrorBoundary>
                  <App />
                </AppErrorBoundary>
              )}
      </I18nProvider>
    </ThemeProvider>
  )
}

// Dev/test seam: exposes the live store for Playwright smoke tests.
// This is a NO-OP in production builds — import.meta.env.DEV is a compile-time
// constant and the entire block is dead-code-eliminated by Vite.
if (import.meta.env.DEV) {
  let _pcTestReady: Promise<typeof import('./store/projectStore')> | null = null
  function _pcTestStore() {
    if (!_pcTestReady) {
      _pcTestReady = import('./store/projectStore')
    }
    return _pcTestReady
  }

  window.__pcTest = {
    getProject: async () => {
      const { useProjectStore } = await _pcTestStore()
      return JSON.parse(useProjectStore.getState().saveProject())
    },
    getHoveredFeatureId: async () => {
      const { useProjectStore } = await _pcTestStore()
      return useProjectStore.getState().selection.hoveredFeatureId
    },
    loadProject: async (json: string) => {
      const { useProjectStore } = await _pcTestStore()
      useProjectStore.getState().openProjectFromText(json, null)
    },
    /** Returns the current pendingMove state (null if idle). */
    getPendingMove: async () => {
      const { useProjectStore } = await _pcTestStore()
      const pm = useProjectStore.getState().pendingMove
      if (!pm) return null
      return { mode: pm.mode, entityType: pm.entityType, entityIds: [...pm.entityIds] }
    },
    /** Completes a pending copy/move starting from origin and ending at (x,y). */
    completePendingMove: async (x: number, y: number) => {
      const { useProjectStore } = await _pcTestStore()
      useProjectStore.getState().setPendingMoveFrom({ x: 0, y: 0 })
      useProjectStore.getState().setPendingMoveTo({ x, y })
      useProjectStore.getState().completePendingMove({ x, y }, 1)
    },
    startAddRectPlacement: async () => {
      const { useProjectStore } = await _pcTestStore()
      useProjectStore.getState().startAddRectPlacement()
    },
    setPendingAddAnchor: async (x: number, y: number) => {
      const { useProjectStore } = await _pcTestStore()
      useProjectStore.getState().setPendingAddAnchor({ x, y })
    },
    placePendingAddAt: async (x: number, y: number) => {
      const { useProjectStore } = await _pcTestStore()
      useProjectStore.getState().placePendingAddAt({ x, y })
    },
    cancelPendingAdd: async () => {
      const { useProjectStore } = await _pcTestStore()
      useProjectStore.getState().cancelPendingAdd()
    },
    getPendingAddShape: async () => {
      const { useProjectStore } = await _pcTestStore()
      const pa = useProjectStore.getState().pendingAdd
      return pa?.shape ?? null
    },
    getFeatureCount: async () => {
      const { useProjectStore } = await _pcTestStore()
      return useProjectStore.getState().project.features.length
    },
    /** Selects the given features and opens the Join workflow panel. */
    startJoinFeatures: async (ids: string[]) => {
      const { useProjectStore } = await _pcTestStore()
      useProjectStore.getState().selectFeatures(ids)
      useProjectStore.getState().startJoinSelectedFeatures()
    },
    /**
     * Opens the Rotate workflow panel. Before any reference point is picked its
     * body renders as an all-false fragment, which is the case the panel's :empty
     * collapse has to catch.
     */
    startRotateFeature: async (featureId: string) => {
      const { useProjectStore } = await _pcTestStore()
      useProjectStore.getState().startRotateFeature(featureId)
    },
    /** Reads keep-originals off whichever workflow currently owns it. */
    getKeepOriginals: async () => {
      const { useProjectStore } = await _pcTestStore()
      const state = useProjectStore.getState()
      return {
        shapeAction: state.pendingShapeAction?.keepOriginals ?? null,
        transform: state.pendingTransform?.keepOriginals ?? null,
      }
    },
  }
}

createRoot(document.getElementById('root')!).render(rootElement())
reactMounted = true

// Clear the index.html boot watchdog: React is alive, no fallback needed.
if (typeof window !== 'undefined' && window.__pcBootWatchdog !== undefined) {
  window.clearTimeout(window.__pcBootWatchdog)
  window.__pcBootWatchdog = undefined
}

// Ambient type declarations for globals added by index.html (boot watchdog)
// and the dev/test seam above.
declare global {
  interface Window {
    __pcBootWatchdog?: number
    __pcTest?: {
      getProject: () => Promise<Record<string, unknown>>
      getHoveredFeatureId: () => Promise<string | null>
      loadProject: (json: string) => Promise<void>
      getPendingMove: () => Promise<{ mode: string; entityType: string; entityIds: string[] } | null>
      completePendingMove: (x: number, y: number) => Promise<void>
      startAddRectPlacement: () => Promise<void>
      setPendingAddAnchor: (x: number, y: number) => Promise<void>
      placePendingAddAt: (x: number, y: number) => Promise<void>
      cancelPendingAdd: () => Promise<void>
      getPendingAddShape: () => Promise<string | null>
      getFeatureCount: () => Promise<number>
      startJoinFeatures: (ids: string[]) => Promise<void>
      startRotateFeature: (featureId: string) => Promise<void>
      getKeepOriginals: () => Promise<{ shapeAction: boolean | null; transform: boolean | null }>
    }
  }
}
