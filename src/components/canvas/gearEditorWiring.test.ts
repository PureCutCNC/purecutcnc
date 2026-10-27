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
 * Canned-shape edit wiring (issue #1112, DE2 review).
 *
 * The store tests prove the edits are correct; this pins the UI seams: the
 * canvas panel module registers an opener for every canned kind, Properties
 * calls that opener for the generic "Edit <shape>…" button, and the canvas
 * shell renders the side panel from the pending session. The old modal host
 * (a second React root) must be gone.
 *
 * Run with: npx tsx src/components/canvas/gearEditorWiring.test.ts
 */

import { readFileSync } from 'node:fs'
import { getCannedShapeEditor } from '../../cannedShapes'
import './CannedShapeEditPanel'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

for (const kind of ['gear', 'ellipse', 'slot', 'ngon', 'roundrect', 'chamferrect']) {
  assert(getCannedShapeEditor(kind) !== null, `the canvas panel registers ${kind}`)
}
// Calling an opener with no matching row is a harmless no-op, not a throw.
getCannedShapeEditor('gear')!('f-test')

const properties = readFileSync(
  new URL('../feature-tree/PropertiesPanel.tsx', import.meta.url),
  'utf8',
)
assert(
  properties.includes('cannedEditor(selectedFeature.id)'),
  'Properties opens the canned editor through the registry',
)
assert(
  !properties.includes('<GearEditorHost />'),
  'Properties no longer mounts a modal host',
)
const sketchCanvas = readFileSync(
  new URL('./SketchCanvas.tsx', import.meta.url),
  'utf8',
)
assert(
  sketchCanvas.includes('<CannedShapeEditPanel'),
  'the canvas shell renders the edit side panel from the pending session',
)
assert(
  sketchCanvas.includes("pendingAdd?.shape === 'canned-edit'"),
  'the side panel opens only for the canned-edit pending session',
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
