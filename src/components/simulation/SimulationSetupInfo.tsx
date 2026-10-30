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

import { useState } from 'react'
import { Icon } from '../Icon'

interface SimulationSetupInfoProps {
  /**
   * The fresh-stock sentence, or null when there is nothing to explain (a
   * single-setup project never carries another setup's cut in the part).
   */
  note: string | null
}

/**
 * The simulation toolbar's fresh-stock info button (issue #1112 F3).
 *
 * It replaces the full-width note line that used to sit under the toolbar
 * (issue #947). The sentence is the button's tooltip and its accessible name
 * — unchanged text — and a tap opens it, because a `title` alone never shows
 * on a touch screen. A project with one setup renders nothing at all.
 */
export function SimulationSetupInfo({ note }: SimulationSetupInfoProps) {
  const [open, setOpen] = useState(false)
  if (note === null) return null

  return (
    <div className="simulation-setup-info">
      <button
        type="button"
        className="simulation-setup-info__button"
        title={note}
        aria-label={note}
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
      >
        <Icon id="info" size={16} />
      </button>
      {open ? (
        <span className="simulation-setup-info__text" role="note">{note}</span>
      ) : null}
    </div>
  )
}
