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
import { setupDialogSections } from './setupDialogSections'

// Top: face up and the shared origin, nothing to flip or register.
assert.deepEqual(setupDialogSections('top'), { flip: false, registration: false, faceUp: true }, 'Top hides flip and registration')

// Bottom: everything, because the flip and its registration are the point.
assert.deepEqual(setupDialogSections('bottom'), { flip: true, registration: true, faceUp: true }, 'Bottom shows the whole dialog')

// Around: not a flip and not a face, so no face, flip or registration section.
assert.deepEqual(setupDialogSections('around'), { flip: false, registration: false, faceUp: false }, 'Around shows only name and notes')

console.log('setup dialog section tests passed')
