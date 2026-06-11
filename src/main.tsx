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
  if (isPhoneSizedTouchDevice()) return <UnsupportedMobileScreen />
  if (isIconGalleryRoute) return <IconGalleryRoute />
  return (
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  )
}

createRoot(document.getElementById('root')!).render(rootElement())
reactMounted = true

// Clear the index.html boot watchdog: React is alive, no fallback needed.
declare global {
  interface Window {
    __pcBootWatchdog?: number
  }
}
if (typeof window !== 'undefined' && window.__pcBootWatchdog !== undefined) {
  window.clearTimeout(window.__pcBootWatchdog)
  window.__pcBootWatchdog = undefined
}
