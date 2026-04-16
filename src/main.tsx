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
import { isDesktop } from './platform'
import { installAnalytics } from './utils/analytics'
import { applyVersionToTitle } from './utils/version'

// In the desktop app, the window title is managed by useDesktopIntegration
// (showing filename + dirty flag). Only apply the version title in browser.
if (!isDesktop) {
  applyVersionToTitle()
  installAnalytics()
}

createRoot(document.getElementById('root')!).render(
  <App />,
)
