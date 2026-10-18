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

/**
 * The informational note a one-shot Around solid shows when the generator will
 * not cut the whole requested band (#1016 C2 F4).
 *
 * The effective start/end come from `rotaryAlongRange` — the same function
 * `generateRotaryOperation` calls — with the same clamps, the selected tool
 * normalised the way the generator normalises it, and the zero end supports
 * `addRotarySolid` writes. This module therefore never re-states the clearance
 * formula: if the toolpath moves its start, the note moves with it.
 *
 * A support's own held length is clamp geometry, not clearance: it says how
 * much of the bar the chuck or tailstock physically covers, while the effective
 * start also includes the cutter's radius. Both numbers are reported so the
 * note can explain the difference rather than just announce a surprise.
 */

import { normalizeToolForProject } from '../../../engine/toolpaths/geometry'
import { rotaryAlongRange } from '../../../engine/toolpaths/rotaryModel'
import { getStockBounds, type BarStock, type Clamp, type Project } from '../../../types/project'
import { isBarStock } from '../../../types/barStock'

export type RotarySolidSupport = 'chuck' | 'tailstock'

/**
 * One line of the note. `start` and `end` describe a clearance at that end of
 * the requested band; `all` means the whole band falls inside the kept-clear
 * region, so the generator has no range to cut at all.
 */
export type RotarySolidChuckNote =
  | {
    readonly kind: 'start' | 'end'
    readonly support: RotarySolidSupport
    readonly held: number
    readonly effective: number
  }
  | { readonly kind: 'all' }

/** A boundary exactly on the kept-clear edge is not "under" the support. */
const NOTE_EPSILON = 1e-9

function alongBounds(stock: BarStock): { lower: number; upper: number } {
  const bounds = getStockBounds(stock)
  return stock.axis === 'x'
    ? { lower: bounds.minX, upper: bounds.maxX }
    : { lower: bounds.minY, upper: bounds.maxY }
}

/** A clamp's extent along the bar, in the same absolute stock space. */
function clampAlong(stock: BarStock, clamp: Clamp): { min: number; max: number } {
  const min = stock.axis === 'x' ? clamp.x : clamp.y
  return { min, max: min + (stock.axis === 'x' ? clamp.w : clamp.h) }
}

/**
 * The clamp whose far edge defines the clear region at one end — the same
 * midpoint test `rotaryAlongRange` uses, so the note names the support the
 * generator actually respected.
 */
function supportAt(stock: BarStock, clamps: readonly Clamp[], side: 'start' | 'end'): Clamp | undefined {
  const { lower, upper } = alongBounds(stock)
  const middle = (lower + upper) / 2
  let best: Clamp | undefined
  for (const clamp of clamps) {
    if (clamp.type !== 'chuck' && clamp.type !== 'tailstock') continue
    const span = clampAlong(stock, clamp)
    const atStart = (span.min + span.max) / 2 <= middle
    if ((side === 'start') !== atStart) continue
    if (!best) {
      best = clamp
      continue
    }
    const chosen = clampAlong(stock, best)
    if (side === 'start' ? span.max > chosen.max : span.min < chosen.min) best = clamp
  }
  return best
}

function supportType(clamp: Clamp | undefined): RotarySolidSupport {
  return clamp?.type === 'tailstock' ? 'tailstock' : 'chuck'
}

/**
 * The absolute side of the bar the dialog's "start" names. On an X bar the
 * chuck end is `minX`; on a Y bar it is `maxY`, the end `alongEndpoints`
 * measures from — so the dialog's start is the generator's *end* there.
 */
function absoluteSide(stock: BarStock, side: 'start' | 'end'): 'start' | 'end' {
  const chuckAtLower = stock.axis === 'x'
  if (side === 'start') return chuckAtLower ? 'start' : 'end'
  return chuckAtLower ? 'end' : 'start'
}

/** A distance measured from the dialog's chuck end, in project units. */
function fromChuckEnd(stock: BarStock, absolute: number): number {
  const { lower, upper } = alongBounds(stock)
  return stock.axis === 'x' ? absolute - lower : upper - absolute
}

/** How much of the bar a clamp physically covers from one dialog end. */
function heldAt(stock: BarStock, clamp: Clamp | undefined, side: 'start' | 'end'): number {
  if (!clamp) return 0
  const { lower, upper } = alongBounds(stock)
  const span = clampAlong(stock, clamp)
  return absoluteSide(stock, side) === 'start'
    ? Math.max(0, span.max - lower)
    : Math.max(0, upper - span.min)
}

/**
 * The notes for an absolute, ascending along-bar band, in project units.
 * `effective` is measured from the dialog's chuck end, the same origin as the
 * Start and Length fields, so a shifted or Y-axis bar reports the number the
 * user's own fields are written against. Returns an empty list when the whole
 * band will be cut, and `all` when none of it will.
 */
export function rotarySolidChuckNotes(
  project: Project,
  toolRef: string,
  alongStart: number,
  alongEnd: number,
): RotarySolidChuckNote[] {
  const stock = project.stock
  if (!isBarStock(stock)) return []
  if (!Number.isFinite(alongStart) || !Number.isFinite(alongEnd)) return []
  const { lower, upper } = alongBounds(stock)
  if (alongStart < lower - NOTE_EPSILON || alongEnd > upper + NOTE_EPSILON) return []
  if (!(alongEnd - alongStart > NOTE_EPSILON)) return []

  const record = project.tools.find((tool) => tool.id === toolRef)
  if (!record) return []
  const tool = normalizeToolForProject(record, project)
  if (tool.type !== 'ball_endmill' && tool.type !== 'flat_endmill') return []
  if (!(tool.diameter > 0) || !Number.isFinite(tool.diameter)) return []

  const range = rotaryAlongRange(
    stock,
    project.clamps,
    { min: alongStart, max: alongEnd },
    tool,
    { chuckEnd: 0, tailEnd: 0 },
  )
  // No range means the kept-clear region spans the whole requested band.
  if (!range) return [{ kind: 'all' }]

  const requestedStart = fromChuckEnd(stock, stock.axis === 'x' ? alongStart : alongEnd)
  const requestedEnd = fromChuckEnd(stock, stock.axis === 'x' ? alongEnd : alongStart)
  const effectiveStart = fromChuckEnd(stock, stock.axis === 'x' ? range.start : range.end)
  const effectiveEnd = fromChuckEnd(stock, stock.axis === 'x' ? range.end : range.start)
  const notes: RotarySolidChuckNote[] = []
  if (effectiveStart > requestedStart + NOTE_EPSILON) {
    const support = supportAt(stock, project.clamps, absoluteSide(stock, 'start'))
    notes.push({
      kind: 'start',
      support: supportType(support),
      held: support ? heldAt(stock, support, 'start') : Math.max(0, effectiveStart),
      effective: effectiveStart,
    })
  }
  if (effectiveEnd < requestedEnd - NOTE_EPSILON) {
    const support = supportAt(stock, project.clamps, absoluteSide(stock, 'end'))
    notes.push({
      kind: 'end',
      support: supportType(support),
      held: support ? heldAt(stock, support, 'end') : Math.max(0, requestedEnd - effectiveEnd),
      effective: effectiveEnd,
    })
  }
  return notes
}
