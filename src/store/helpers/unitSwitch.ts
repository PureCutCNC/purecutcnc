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

import type { Units } from '../../utils/units'

/** How `setUnits` changed the project's units. */
export type UnitSwitchMode = 'convert' | 'reinterpret'

export interface UnitSwitchRecord {
  from: Units
  to: Units
  mode: UnitSwitchMode
}

/**
 * The unit switch the store last applied (issue #1112 r5-4).
 *
 * A dialog open across a unit change has to move the user's pending draft by the
 * fixed mm/inch factor when the switch **converted** the project, and leave it
 * alone when the switch **reinterpreted** the same numbers. Neither can be
 * inferred from the project afterwards: an intervening stock edit also changes a
 * stored length (so it reads as a conversion), and a ratio measured from two
 * snapshots assumes it is exactly the exchange rate. The store therefore records
 * the mode it actually applied, and a dialog follows the record for the switch
 * it saw.
 *
 * One module-level record is enough because the project has one unit at a time:
 * a dialog only asks about the transition from the units it was showing to the
 * units now stored.
 */
let lastSwitch: UnitSwitchRecord | null = null

/** Called by `setUnits` once it knows the switch it is applying. */
export function recordUnitSwitch(from: Units, to: Units, mode: UnitSwitchMode): void {
  lastSwitch = { from, to, mode }
}

/**
 * The mode of the switch from `from` to `to`, or `null` when the last switch was
 * a different one. A dialog treats `null` as "nothing was rewritten", so unknown
 * transitions never rescale a pending edit.
 */
export function lastUnitSwitchMode(from: Units, to: Units): UnitSwitchMode | null {
  return lastSwitch && lastSwitch.from === from && lastSwitch.to === to ? lastSwitch.mode : null
}
