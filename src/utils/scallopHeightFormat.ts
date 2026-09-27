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

import { formatLength, type Units } from './units'

// Issue #893: 4 dp (in) / 3 dp (mm), plus as many places as it takes to keep
// two significant digits. Small ball endmills have cusps just above one step
// (1/16" at 0.1 stepover is 0.000157 in), where a fixed 4 dp would store
// 0.0002: a 28 % taller cusp. Two digits hold the error to a few percent.
function scallopHeightPlaces(value: number, units: Units): number {
  const places = units === 'inch' ? 4 : 3
  if (!(value > 0) || !Number.isFinite(value)) return places
  return Math.max(places, 1 - Math.floor(Math.log10(value)))
}

export function roundScallopHeight(value: number, units: Units): number {
  return Number(value.toFixed(scallopHeightPlaces(value, units)))
}

export function formatScallopHeight(value: number, units: Units): string {
  return formatLength(value, units, { maximumFractionDigits: scallopHeightPlaces(value, units) })
}

/**
 * A stored scallop height as the scallop fields show it: the value itself,
 * with float noise trimmed. Never rounded further, so the field always reads
 * the height the toolpath is cut with.
 */
export function formatStoredScallopHeight(value: number): string {
  return String(Number(value.toPrecision(8)))
}
