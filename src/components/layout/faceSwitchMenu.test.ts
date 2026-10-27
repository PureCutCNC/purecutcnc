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
 * The header's one compact face control and the menu it opens (issue #1112
 * slice B, decision 6; #1107).
 *
 * Mutations these assertions were checked against:
 * - listing Around on every project (dropping the `aroundAvailable` filter) →
 *   "a milling project has no Around entry" fails;
 * - refusing every face while busy instead of only the others → "only the
 *   other faces are refused" fails;
 * - never refusing a face → "the other faces explain why" fails;
 * - showing the overlay on a Top-only project → "no other side on a Top-only
 *   project" fails;
 * - showing the overlay on a Top view with nothing on Bottom → "a Top view
 *   with nothing on Bottom has no other side" fails;
 * - showing the overlay on Around → "Around never offers the overlay" fails;
 * - marking every entry checked → "the current face is the checked one" fails.
 *
 * Run with: npx tsx src/components/layout/faceSwitchMenu.test.ts
 */

import assert from 'node:assert/strict'
import { faceIcon, faceLabelKey, faceMenu, type FaceMenuInput } from './faceSwitchMenu'

/** A rotary project on a bar, on Top, with content on both faces. */
const ROTARY_BOTH_FACES: FaceMenuInput = {
  face: 'top',
  aroundAvailable: true,
  bothFaces: true,
  hasBottomContent: true,
  busy: false,
  showOtherSide: true,
}

function faceOf(model: ReturnType<typeof faceMenu>): string[] {
  return model.items.map((item) => item.face)
}

function item(model: ReturnType<typeof faceMenu>, face: 'top' | 'bottom' | 'around') {
  const found = model.items.find((entry) => entry.face === face)
  assert(found, `the menu lists ${face}`)
  return found
}

// Every face the project has, in a fixed order.
assert.deepEqual(faceOf(faceMenu(ROTARY_BOTH_FACES)), ['top', 'bottom', 'around'], 'a rotary project lists all three faces')

// Around only exists on a rotary project with a bar (#1028).
assert.deepEqual(
  faceOf(faceMenu({ ...ROTARY_BOTH_FACES, aroundAvailable: false })),
  ['top', 'bottom'],
  'a milling project has no Around entry',
)
assert.deepEqual(
  faceOf(faceMenu({ ...ROTARY_BOTH_FACES, face: 'bottom', aroundAvailable: false })),
  ['top', 'bottom'],
  'the missing Around entry does not rearrange the others',
)

// Exactly one entry is checked: the face the workspace is on.
const onBottom = faceMenu({ ...ROTARY_BOTH_FACES, face: 'bottom' })
assert.equal(item(onBottom, 'bottom').checked, true, 'the current face is the checked one')
assert.equal(item(onBottom, 'top').checked, false, 'Top is not checked while on Bottom')
assert.equal(item(onBottom, 'around').checked, false, 'Around is not checked while on Bottom')

// An edit in progress refuses the other faces, never the one being edited on.
const busyOnTop = faceMenu({ ...ROTARY_BOTH_FACES, busy: true })
assert.equal(item(busyOnTop, 'top').checked, true, 'the current face stays checked while busy')
assert.equal(item(busyOnTop, 'top').disabled, false, 'the current face is never refused')
assert.equal(item(busyOnTop, 'bottom').disabled, true, 'only the other faces are refused')
assert.equal(item(busyOnTop, 'around').disabled, true, 'Around is refused while busy too')
assert.equal(item(busyOnTop, 'bottom').titleKey, 'appShell.face.busy', 'the other faces explain why')
assert.equal(item(busyOnTop, 'top').titleKey, 'appShell.face.switchToTop', 'a usable face keeps its own sentence')

// Each face keeps its own icon, label and sentence when nothing refuses it.
assert.equal(item(faceMenu(ROTARY_BOTH_FACES), 'bottom').titleKey, 'appShell.face.switchToBottom', 'Bottom explains switching')
assert.equal(item(faceMenu(ROTARY_BOTH_FACES), 'around').titleKey, 'canvas.face.aroundTurnsBar', 'Around explains the unrolled view')
assert.equal(item(faceMenu(ROTARY_BOTH_FACES), 'around').icon, 'face-around', 'Around wears its icon')
assert.equal(item(faceMenu(ROTARY_BOTH_FACES), 'around').labelKey, 'appShell.face.around', 'Around keeps the shared label key')
assert.equal(faceIcon('top'), 'face-top', 'the control uses the same icon as the entry')
assert.equal(faceLabelKey('bottom'), 'appShell.face.bottom', 'the control and its menu share one label key')

// The overlay entry follows the same rule the old eye carried.
assert.deepEqual(faceMenu(ROTARY_BOTH_FACES).otherSide, { checked: true }, 'a Top view with Bottom content offers the overlay')
assert.deepEqual(
  faceMenu({ ...ROTARY_BOTH_FACES, showOtherSide: false }).otherSide,
  { checked: false },
  'the overlay entry reports whether the ghost is drawn',
)
assert.deepEqual(
  faceMenu({ ...ROTARY_BOTH_FACES, hasBottomContent: false }).otherSide,
  null,
  'a Top view with nothing on Bottom has no other side',
)
assert.deepEqual(
  faceMenu({ ...ROTARY_BOTH_FACES, bothFaces: false, hasBottomContent: false }).otherSide,
  null,
  'no other side on a Top-only project',
)
assert.deepEqual(
  faceMenu({ ...ROTARY_BOTH_FACES, face: 'bottom' }).otherSide,
  { checked: true },
  'a Bottom view offers the Top overlay',
)
assert.deepEqual(
  faceMenu({ ...ROTARY_BOTH_FACES, face: 'around' }).otherSide,
  null,
  'Around never offers the overlay',
)

console.log('face switch menu tests passed')
