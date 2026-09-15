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

import { useI18n } from '../../i18n/i18nContext'
import type { WebglStatus } from './webglRenderer'

// Both 3D views carry the same four messages, so a missing or lost context is
// explained the same way while still naming the view the user is looking at.
const MESSAGES = {
  view3d: {
    unavailable: { title: 'viewport.view3d.webglUnavailableTitle', body: 'viewport.view3d.webglUnavailableBody' },
    'context-lost': { title: 'viewport.view3d.webglLostTitle', body: 'viewport.view3d.webglLostBody' },
  },
  simulation: {
    unavailable: { title: 'viewport.sim.webglUnavailableTitle', body: 'viewport.sim.webglUnavailableBody' },
    'context-lost': { title: 'viewport.sim.webglLostTitle', body: 'viewport.sim.webglLostBody' },
  },
} as const

/** Covers a 3D view whose WebGL context is missing or lost; renders nothing while it is ok. */
export function WebglStatusOverlay({ status, view }: { status: WebglStatus; view: keyof typeof MESSAGES }) {
  const { t } = useI18n()
  if (status === 'ok') return null
  const message = MESSAGES[view][status]
  return (
    <div className="viewport-webgl-overlay">
      <div className="viewport-webgl-message" role="status">
        <strong>{t(message.title)}</strong>
        <p>{t(message.body)}</p>
      </div>
    </div>
  )
}
