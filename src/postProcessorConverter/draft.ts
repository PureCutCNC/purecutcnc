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

import type { MachineDefinition } from '../engine/gcode/types'
import { validateMachineDefinition } from '../engine/gcode/types'
import genericJson from '../engine/gcode/definitions/generic.json'
import type { MachineDefinitionDraft } from './types'

/**
 * Every unmapped field falls back to the bundled "Generic RS-274" definition
 * rather than a converter-local default table, so an unknown field behaves
 * exactly like picking the Generic machine in the app — one baseline, not two.
 */
export const GENERIC_BASELINE: MachineDefinition = validateMachineDefinition(genericJson)

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Deep-merges `overrides` onto `base`. Arrays replace wholesale (an adapter
 * that knows `program.header` supplies the whole array, never a splice).
 * `null` replaces a nullable object outright (e.g. a source with no coolant
 * support overrides the baseline's non-null `coolant` with `null`) rather
 * than merging into it. Operates on `unknown` rather than a generic `T`: the
 * recursive shape can't be proven statically, and `validateMachineDefinition`
 * re-checks the result at the one call site that matters (`buildMachineDefinition`).
 */
function deepMerge(base: unknown, overrides: unknown): unknown {
  if (overrides === undefined) {
    return base
  }
  if (Array.isArray(base)) {
    return overrides
  }
  if (isPlainObject(base) && isPlainObject(overrides)) {
    const result: Record<string, unknown> = { ...base }
    for (const key of Object.keys(overrides)) {
      result[key] = deepMerge(base[key], overrides[key])
    }
    return result
  }
  return overrides
}

export interface MachineIdentity {
  id: string
  name: string
  description: string
  vendor?: string
}

/**
 * `cannedCycles` and `coolant` are nullable groups whose Generic baseline
 * value is `null` (see generic.json) — there is no baseline sub-object for a
 * partial adapter override to fall back onto, so a partial override (e.g. an
 * adapter that only found drill/peck codes, not a retract-plane convention)
 * would leave required-but-nullable leaves like `retractMode` undefined and
 * fail schema validation. These conventional RS-274 values give a partial
 * override something concrete to merge onto before it replaces the (null)
 * baseline. An adapter that found nothing at all should set the group to
 * `null` explicitly rather than `{}`, to say "not supported" rather than
 * "supported with these conventional guesses".
 */
const CANNED_CYCLES_FALLBACK = {
  drillCommand: 'G81',
  drillWithDwellCommand: 'G82',
  peckDrillCommand: 'G83',
  chipBreakDrillCommand: null,
  peckStepWord: 'Q',
  retractMode: 'G98',
  cancelCommand: 'G80',
}

const COOLANT_FALLBACK = {
  floodOnCommand: 'M8',
  mistOnCommand: 'M7',
  coolantOffCommand: 'M9',
}

function withNullableGroupFallbacks(overrides: MachineDefinitionDraft): MachineDefinitionDraft {
  return {
    ...overrides,
    cannedCycles:
      overrides.cannedCycles == null
        ? overrides.cannedCycles
        : (deepMerge(CANNED_CYCLES_FALLBACK, overrides.cannedCycles) as MachineDefinitionDraft['cannedCycles']),
    coolant:
      overrides.coolant == null
        ? overrides.coolant
        : (deepMerge(COOLANT_FALLBACK, overrides.coolant) as MachineDefinitionDraft['coolant']),
  }
}

/** Overlays adapter overrides onto the generic baseline and validates the result. */
export function buildMachineDefinition(
  overrides: MachineDefinitionDraft,
  identity: MachineIdentity,
): MachineDefinition {
  const merged = deepMerge(GENERIC_BASELINE, withNullableGroupFallbacks(overrides))
  return validateMachineDefinition({
    ...(merged as object),
    ...identity,
    builtin: false,
  })
}
