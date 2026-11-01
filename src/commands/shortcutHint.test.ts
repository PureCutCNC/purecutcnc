/**
 * Copyright 2026 Maik Rolf
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

import assert from 'node:assert/strict'
import { formatShortcutHint } from './shortcutHint'

assert.equal(formatShortcutHint('Ctrl/Cmd+Z', false), 'Ctrl+Z')
assert.equal(formatShortcutHint('Ctrl/Cmd+Shift+Z', false), 'Ctrl+Shift+Z')
assert.equal(formatShortcutHint('Ctrl/Cmd+Z', true), '⌘Z')
assert.equal(formatShortcutHint('Ctrl/Cmd+Shift+Z', true), '⌘⇧Z')
assert.equal(formatShortcutHint('Ctrl/Cmd+P', true), '⌘P')
assert.equal(formatShortcutHint('Esc', false), 'Esc')
assert.equal(formatShortcutHint('Esc', true), 'Esc')

console.log('shortcutHint tests passed')
