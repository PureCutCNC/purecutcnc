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
 * The Cuts chips' packed geometry, read off the stylesheet (issue #1112 rt6-b,
 * item 40; fix1 F1/F2).
 *
 * "Several chips on one line" is CSS, so this file measures the rules that
 * decide it rather than pretending a DOM shape proves it. Two things let a
 * finger remove the wrong cut while every box still measures its full target:
 *  - the × box overhangs its 26px chip by 7px (desktop) / 9px (tablet) above
 *    and below, so a group boundary that does not reserve that overhang puts
 *    the last line's box into the next group's first line, and a folder's
 *    summary sits inside its own chips' boxes;
 *  - the × box overhangs 6px (desktop) / 10px (tablet) to the right, so a
 *    column gap narrower than that leaves the neighbour's chip body over the
 *    box's right edge, and a line that fills the list needs the overhang
 *    reserved at its right edge or the panel's clip cuts the box short.
 *
 * `e2e/tablet1112.smoke.spec.ts` asks a real browser the same questions with
 * `elementFromPoint` at each box's edges; this is the half that also runs where
 * no browser does, and it covers both shell modes.
 *
 * Mutations checked one at a time (each reverted from a `cp` backup):
 *  - the list's gap back to 6px → the block-boundary assertion fails;
 *  - the list's top padding removed → the first line's overhang assertion
 *    fails;
 *  - the folder group's `padding-top` removed → the summary assertion fails;
 *  - the tablet group's column gap back to 8px → the right-edge assertion
 *    fails;
 *  - the tablet list's right padding removed → the clipped-× assertion fails.
 *
 * Run with: npx tsx src/components/cam/operationCutsLayout.test.ts
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const faceCss = readFileSync(fileURLToPath(new URL('../../styles/face.css', import.meta.url)), 'utf8')

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

/** The declarations of the first rule whose selector starts with `needle`. */
function declarationsOf(needle: string): Map<string, string> {
  const at = faceCss.indexOf(needle)
  if (at < 0) throw new Error(`face.css no longer declares ${needle}`)
  const open = faceCss.indexOf('{', at)
  const close = faceCss.indexOf('}', open)
  if (open < 0 || close < 0) throw new Error(`face.css has no rule body for ${needle}`)
  const declarations = new Map<string, string>()
  for (const part of faceCss.slice(open + 1, close).split(';')) {
    const colon = part.indexOf(':')
    if (colon < 0) continue
    declarations.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim())
  }
  return declarations
}

function valueOf(declarations: Map<string, string>, property: string): string {
  const value = declarations.get(property)
  if (value === undefined) throw new Error(`missing ${property} in a Cuts rule`)
  return value
}

function px(text: string): number {
  const match = /^(-?\d+(?:\.\d+)?)(px)?$/.exec(text.trim())
  if (!match || (match[2] === undefined && Number(match[1]) !== 0)) {
    throw new Error(`not a px length: ${JSON.stringify(text)}`)
  }
  return Number(match[1])
}

/** A 1-4 value `padding`/`margin`-style shorthand as top/right/bottom/left. */
function sides(text: string): { top: number; right: number; bottom: number; left: number } {
  const parts = text.trim().split(/\s+/).map(px)
  switch (parts.length) {
    case 1: return { top: parts[0], right: parts[0], bottom: parts[0], left: parts[0] }
    case 2: return { top: parts[0], right: parts[1], bottom: parts[0], left: parts[1] }
    case 3: return { top: parts[0], right: parts[1], bottom: parts[2], left: parts[1] }
    case 4: return { top: parts[0], right: parts[1], bottom: parts[2], left: parts[3] }
    default: throw new Error(`unsupported shorthand: ${JSON.stringify(text)}`)
  }
}

/** A 1-2 value `gap`/`margin` shorthand as row/column. */
function pair(text: string): { row: number; column: number } {
  const parts = text.trim().split(/\s+/).map(px)
  if (parts.length === 1) return { row: parts[0], column: parts[0] }
  if (parts.length === 2) return { row: parts[0], column: parts[1] }
  throw new Error(`unsupported pair shorthand: ${JSON.stringify(text)}`)
}

interface ChipMetrics {
  mode: string
  remove: { width: number; height: number }
  /** How far the × box reaches above/below its chip's border box. */
  verticalOverhang: number
  /** How far the × box reaches right of its chip's border box. */
  rightOverhang: number
  chipHeight: number
  rowGap: number
  columnGap: number
  blockGap: number
  listPadding: { top: number; right: number; bottom: number; left: number }
  folderGroupTop: number
}

function metrics(mode: 'desktop' | 'tablet'): ChipMetrics {
  const tablet = mode === 'tablet'
  const shell = "[data-shell-mode='tablet']"
  const remove = declarationsOf(`\n${tablet ? `${shell} .cam-cuts__remove,` : '.cam-cuts__remove {'}`)
  const chip = declarationsOf('\n.cam-cuts__chip {')
  const group = declarationsOf(`\n${tablet ? `${shell} .cam-cuts__group,` : '.cam-cuts__group {'}`)
  const list = declarationsOf(`\n${tablet ? `${shell} .cam-cuts__list,` : '.cam-cuts__list {'}`)
  const folderGroup = declarationsOf(
    `\n${tablet ? `${shell} .cam-cuts__folder > .cam-cuts__group,` : '.cam-cuts__folder > .cam-cuts__group {'}`,
  )

  const removeWidth = px(valueOf(remove, 'width'))
  const removeHeight = px(valueOf(remove, 'height'))
  const removeMargin = pair(valueOf(remove, 'margin'))
  const border = px(valueOf(chip, 'border').split(/\s+/)[0])
  const chipPadding = sides(valueOf(chip, 'padding'))
  // The chip is `box-sizing: border-box`: its `min-height` covers the borders,
  // its content must still fit the × box's layout footprint (the negative
  // margins are what keep that footprint one line tall).
  const content = Math.max(px(valueOf(chip, 'min-height')) - 2 * border, removeHeight + 2 * removeMargin.row)
  const chipHeight = content + 2 * border
  const groupGap = pair(valueOf(group, 'gap'))
  const listGap = pair(valueOf(list, 'gap'))
  return {
    mode,
    remove: { width: removeWidth, height: removeHeight },
    verticalOverhang: (removeHeight - chipHeight) / 2,
    rightOverhang: Math.abs(removeMargin.column) - chipPadding.right - border,
    chipHeight,
    rowGap: groupGap.row,
    columnGap: groupGap.column,
    blockGap: listGap.row,
    listPadding: sides(valueOf(list, 'padding')),
    folderGroupTop: px(valueOf(folderGroup, 'padding-top')),
  }
}

for (const mode of ['desktop', 'tablet'] as const) {
  const chip = metrics(mode)
  const where = `[${mode}]`

  // Every assertion below is a distance the layout has to keep between the ×
  // box and whatever is painted next to it.
  assert(
    chip.remove.width === chip.remove.height,
    `${where} the × is a square touch box (saw ${chip.remove.width} × ${chip.remove.height})`,
  )
  assert(
    chip.remove.width >= (mode === 'tablet' ? 44 : 40),
    `${where} the × keeps its touch target (saw ${chip.remove.width})`,
  )
  assert(
    chip.verticalOverhang > 0 && chip.rightOverhang > 0,
    `${where} the × box overhangs its chip (saw ${chip.verticalOverhang} / ${chip.rightOverhang})`,
  )
  assert(
    chip.chipHeight < chip.remove.height,
    `${where} the chip stays shorter than its × box (saw ${chip.chipHeight} vs ${chip.remove.height})`,
  )

  // Two wrapped lines inside a group.
  assert(
    chip.rowGap >= 2 * chip.verticalOverhang + 1,
    `${where} the row gap (${chip.rowGap}) clears both overhangs (${2 * chip.verticalOverhang})`,
  )
  // One group block and the next: a folder's chips follow an ungrouped block,
  // which is exactly where a 6px gap left the boxes 12px inside each other.
  assert(
    chip.blockGap >= 2 * chip.verticalOverhang + 1,
    `${where} the gap between blocks (${chip.blockGap}) clears both overhangs (${2 * chip.verticalOverhang})`,
  )
  // A folder's summary is directly above its own chips.
  assert(
    chip.folderGroupTop >= chip.verticalOverhang + 1,
    `${where} a folder's chips clear its summary (${chip.folderGroupTop} vs ${chip.verticalOverhang})`,
  )
  // The field's own neighbours above and below the list.
  assert(
    chip.listPadding.top >= chip.verticalOverhang + 1,
    `${where} the first line's × stays inside the field (${chip.listPadding.top} vs ${chip.verticalOverhang})`,
  )
  assert(
    chip.listPadding.bottom >= chip.verticalOverhang + 1,
    `${where} the last line's × stays inside the field (${chip.listPadding.bottom} vs ${chip.verticalOverhang})`,
  )
  // Two chips on one line: the next chip's body must not cover this × box's
  // right edge — the paper trail of two touch areas that overlap.
  assert(
    chip.columnGap >= chip.rightOverhang,
    `${where} the column gap (${chip.columnGap}) clears the × box's right overhang (${chip.rightOverhang})`,
  )
  // A chip that fills its line: the panel clips at its own edge, so the last
  // overhang has to be reserved instead of painted under the clip.
  assert(
    chip.listPadding.right >= chip.rightOverhang,
    `${where} a full-width chip's × stays inside the list (${chip.listPadding.right} vs ${chip.rightOverhang})`,
  )
}

console.log('operation cuts layout tests passed')
