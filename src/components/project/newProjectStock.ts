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
 * The New project dialog's blank template stock (issue #1046).
 *
 * A blank template's stock is built as the shape the chosen project type
 * actually machines: a block for milling and plasma, and the bar the dialog's
 * own fields describe for rotary — round or square, diameter or side, length
 * and axis. The bar is built directly, instead of a block that
 * `projectWithProjectType` converts afterwards, so the numbers typed in the
 * dialog are the numbers the project carries and there is no intermediate
 * block. The type, the stock shape check and the machine stay
 * `projectWithProjectType`'s job, exactly as before.
 *
 * The whole thing is pure so the created stock can be pinned without a
 * renderer: the dialog only holds the drafts.
 */

import type { MachineDefinition } from '../../engine/gcode/types'
import { projectWithProjectType } from '../../store/helpers/projectTypeApply'
import { isBarStock, normalizeSquareStock, squareStock } from '../../types/barStock'
import {
  defaultOrigin,
  defaultStock,
  normalizeRoundStock,
  roundStock,
  type Project,
  type ProjectMeta,
  type ProjectType,
  type Stock,
  type StockAxis,
} from '../../types/project'

/** The bar shapes a rotary project offers, in the picker's order. */
export type BlankStockShape = 'round' | 'square'

/** The rotary blank template's fields, as typed. */
export interface BlankStockDraft {
  shape: BlankStockShape
  /** The diameter (round) or the side (square). */
  size: string
  /** The length along `axis`. */
  length: string
  axis: StockAxis
}

/** The milling/plasma blank template's fields, as typed. */
export interface BlockStockDraft {
  width: string
  height: string
  thickness: string
}

/**
 * The bar a blank template starts from, in the template's units: Ø 40 × 200
 * along X in millimetres, Ø 1.5 × 8 in inches. A square blank starts from the
 * same numbers, read as its side.
 */
export function defaultBlankStockDraft(
  units: ProjectMeta['units'],
  shape: BlankStockShape = 'round',
): BlankStockDraft {
  const metric = units === 'mm'
  return {
    shape,
    size: metric ? '40' : '1.5',
    length: metric ? '200' : '8',
    axis: 'x',
  }
}

/** A typed positive length, or null when the text is not one. */
function positiveLength(value: string): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/**
 * The bar the draft describes, or null when its size or length is not a
 * positive length. A round bar keeps `size` as its diameter, a square blank as
 * its physical side, and both take the axis and length as typed.
 */
export function blankBarStock(draft: BlankStockDraft): Stock | null {
  const size = positiveLength(draft.size)
  const length = positiveLength(draft.length)
  if (size === null || length === null) return null
  return draft.shape === 'square'
    ? normalizeSquareStock(squareStock(size, length, draft.axis))
    : normalizeRoundStock(roundStock(size, length, draft.axis))
}

/**
 * The block the draft describes, or null when a number is not a positive
 * length — the fields milling and plasma have always asked for.
 */
export function blankBlockStock(draft: BlockStockDraft): Stock | null {
  const width = positiveLength(draft.width)
  const height = positiveLength(draft.height)
  const thickness = positiveLength(draft.thickness)
  if (width === null || height === null || thickness === null) return null
  return defaultStock(width, height, thickness)
}

/** The blank template's stock for `type`: a bar for rotary, a block otherwise. */
export function blankTemplateStock(
  type: ProjectType,
  block: BlockStockDraft,
  bar: BlankStockDraft,
): Stock | null {
  return type === 'rotary' ? blankBarStock(bar) : blankBlockStock(block)
}

/**
 * The blank template as the project `type` will machine, or null while a
 * stock field is not a positive length. The typed stock is put on the template
 * with the origin it owns, and `projectWithProjectType` then applies the
 * stored type and the first matching machine — the same work it does for every
 * other template. Its stock-shape step is a no-op here: the stock already has
 * the shape the type offers.
 */
export function blankTemplateProject(
  template: Project,
  type: ProjectType,
  candidates: readonly MachineDefinition[],
  block: BlockStockDraft,
  bar: BlankStockDraft,
): Project | null {
  const stock = blankTemplateStock(type, block, bar)
  if (!stock) return null
  // A block keeps the template's origin, exactly as the block-only dialog did.
  // A bar takes its own default origin, which is what the old block→bar
  // conversion (`projectWithStockShape`) did when the type turned the stock
  // into a bar; the origin's name and visibility stay the template's.
  const origin = isBarStock(stock)
    ? { ...template.origin, ...defaultOrigin(stock), name: template.origin.name, visible: template.origin.visible }
    : template.origin
  return projectWithProjectType({ ...template, stock, origin }, type, candidates)
}
