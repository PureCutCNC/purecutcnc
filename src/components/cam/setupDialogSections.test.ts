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
 * What the setup properties dialog shows on each face (issue #1102). Top
 * shows the face and the shared origin but hides the flip controls and the
 * registration editor; Bottom shows everything; Around shows neither the
 * flip controls nor registration, only its name and notes.
 *
 * Run with: npx tsx src/components/cam/setupDialogSections.test.ts
 */

import assert from 'node:assert/strict'
import { originFromFrontLeft, setupDialogSections } from './setupDialogSections'

// Top: face up and the shared origin, nothing to flip or register.
assert.deepEqual(setupDialogSections('top'), { flip: false, registration: false, faceUp: true }, 'Top hides flip and registration')

// Bottom: everything, because the flip and its registration are the point.
assert.deepEqual(setupDialogSections('bottom'), { flip: true, registration: true, faceUp: true }, 'Bottom shows the whole dialog')

// Around: not a flip and not a face, so no face, flip or registration section.
assert.deepEqual(setupDialogSections('around'), { flip: false, registration: false, faceUp: false }, 'Around shows only name and notes')

// The origin reads from the front-left corner (issue #1102): sketch Y grows
// towards the front, so a front-left origin on a 4 × 3 stock at (0, 3) is 0, 0.
const bounds = { minX: 0, maxY: 3 }
assert.deepEqual(originFromFrontLeft({ x: 0, y: 3, z: 0.75 }, bounds), { x: 0, y: 0, z: 0.75 }, 'front-left corner reads 0, 0')
assert.deepEqual(originFromFrontLeft({ x: 4, y: 0, z: 0 }, bounds), { x: 4, y: 3, z: 0 }, 'back-right corner reads 4, 3')
assert.deepEqual(originFromFrontLeft({ x: 3, y: 1, z: 0 }, { minX: 1, maxY: 4 }), { x: 2, y: 3, z: 0 }, 'measured from the stock, not from sketch zero')

console.log('setup dialog section tests passed')
