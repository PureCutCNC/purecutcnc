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
 * Gear and Text edit wiring (issue #1112 slice E).
 *
 * The store tests prove the edits are correct; this pins the two UI seams that
 * make them reachable: the gear module registers a canned-shape editor (so the
 * generic Properties button is enabled and opens it), and Properties renders
 * that host plus the text dialog and summary instead of inline text fields.
 *
 * Run with: npx tsx src/components/canvas/gearEditorWiring.test.ts
 */

import { readFileSync } from 'node:fs'
import { getCannedShapeEditor } from '../../cannedShapes'
import './GearParameterPanel'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const editor = getCannedShapeEditor('gear')
assert(editor !== null, 'importing the gear panel registers its editor')
// Calling it only opens the host; with no host mounted it must be a harmless
// no-op rather than throwing.
editor('f-test')

const properties = readFileSync(
  new URL('../feature-tree/PropertiesPanel.tsx', import.meta.url),
  'utf8',
)
assert(
  properties.includes('<GearEditorHost />'),
  'Properties renders the gear editor host',
)
assert(
  properties.includes("t('featureTree.properties.text.summary'"),
  'Properties shows the text summary line',
)
assert(
  properties.includes("t('featureTree.properties.text.edit')"),
  'Properties offers Edit text…',
)
assert(
  properties.includes('mode="edit"'),
  'the reopened text dialog is in edit mode',
)
assert(
  properties.includes("t('featureTree.properties.text.path.refresh')"),
  'Properties offers Refresh for a path run',
)

console.log('✓ Gear and Text edit wiring tests passed.')
