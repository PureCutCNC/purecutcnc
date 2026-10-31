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
 * The centre panel's tab row ends with the face control, then the CAM pull-out
 * handle (issue #1112 R2 item 11), and that row exists on the desktop shell only:
 * a tablet shell carries the same control in its top command bar, right after
 * the Sketch / 3D / Sim switch (issue #1112 rt5-a, item 37).
 *
 * The row is a plain flexbox and its keyboard order is its DOM order, so where
 * the two controls sit is decided by the JSX order alone. `e2e/setupFaces`
 * asserts the rendered geometry and the Tab sequence in a browser; this is the
 * same rule checked without one, so a reorder is caught by `npm test` as well.
 *
 * Mutations checked one at a time against these assertions:
 * - putting `<FaceSwitch />` back after the right handle → the order assertion
 *   fails;
 * - moving the face control left of the tab list (or the handle left of the
 *   switch) → the order assertions fail;
 * - rendering the row on every shell (`{!tabletShell && (` dropped) → the
 *   desktop-only assertion fails;
 * - dropping `<FaceSwitch />` from the top command bar, or moving it before the
 *   view tabs (or into another section of the bar) → those assertions fail.
 *
 * Run with: npx tsx src/components/layout/tabRowOrder.test.ts
 */

import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const shell = readFileSync(new URL('./AppShell.tsx', import.meta.url), 'utf8')
const rowStart = shell.indexOf('<div className="panel-tabs-header">')
assert(rowStart >= 0, 'the centre panel renders its tab row')
// The next row closes the centre workspace; everything between is the row.
const rowEnd = shell.indexOf('<div className="centre-stage">', rowStart)
assert(rowEnd > rowStart, 'the tab row ends before the stage')
const row = shell.slice(rowStart, rowEnd)

const tabList = row.indexOf('className="panel-tablist"')
const faceSwitch = row.indexOf('<FaceSwitch />')
const leftHandle = row.indexOf('id="panel-handle-left"')
const rightHandle = row.indexOf('id="panel-handle-right"')

assert(leftHandle >= 0, 'the left pull-out handle is in the row')
assert(tabList >= 0, 'the tab list is in the row')
assert(faceSwitch >= 0, 'the face control is in the row')
assert(rightHandle >= 0, 'the right pull-out handle is in the row')

assert(leftHandle < tabList, 'the left handle opens the row, before the tabs')
assert(tabList < faceSwitch, 'the tabs come before the face control')
assert(faceSwitch < rightHandle, 'the face control sits just left of the CAM handle')
assert(row.indexOf('className="panel-tabs-spacer"') < faceSwitch, 'the spacer pushes the control pair to the right edge')

// The row is the desktop shell's: a tablet draws no row at all, so nothing is
// left behind above the workspace (issue #1112 rt5-a, item 37).
const beforeRow = shell.slice(0, rowStart).trimEnd()
assert(
  beforeRow.endsWith('{!tabletShell && ('),
  'the centre panel tab row is rendered on the desktop shell only',
)

// The tablet's home for the control: inside the top command bar's centre
// section, after the view switch group and before that section closes.
const bar = readFileSync(new URL('./TopCommandBar.tsx', import.meta.url), 'utf8')
const centerStart = bar.indexOf('<div className="top-command-bar__center">')
const centerEnd = bar.indexOf('<div className="top-command-bar__right">', centerStart)
assert(centerStart >= 0, 'the top command bar has its centre section')
assert(centerEnd > centerStart, 'the centre section ends before the right section')
const center = bar.slice(centerStart, centerEnd)
const tabletsFaceSwitch = center.indexOf('<FaceSwitch />')
const viewTabs = center.indexOf('className="top-cmd-group top-cmd-group--tabs"')
assert(tabletsFaceSwitch >= 0, 'the top command bar carries the face control')
assert(viewTabs >= 0, 'the view switch group is in the centre section')
assert(viewTabs < tabletsFaceSwitch, 'the face control sits right after the Sketch / 3D / Sim switch')
assert(
  center.slice(tabletsFaceSwitch + '<FaceSwitch />'.length).trim().startsWith('</div>'),
  'the face control is the last thing before the centre section closes',
)
assert(
  shell.split('<FaceSwitch />').length - 1 === 1,
  'the desktop row is the only other place the shell mounts the control',
)

console.log('tabRowOrder.test.ts passed')
