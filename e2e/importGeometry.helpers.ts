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

import type { Locator } from '@playwright/test'

/**
 * Synthetic SVG/DXF content for import smoke tests.
 * These are minimal valid files — no committed real-world assets.
 */

/**
 * SVG with one filled closed rectangle and one disjoint stroke-only closed
 * rectangle.  Auto mode → Add 1 + closed Line 1.  Paths → 2 closed Lines.
 * Solid regions → 2 Adds.
 */
export const SVG_FILL_AND_STROKE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="10" y="10" width="30" height="30" fill="blue"/>
  <rect x="60" y="10" width="30" height="30" fill="none" stroke="red" stroke-width="2"/>
</svg>`

/**
 * DXF with nested closed outer + inner contours plus one open line, all on
 * layer "0".  Auto mode → Add (outer) + Subtract (inner) + open Line.
 * Paths → 2 closed Lines + 1 open Line.
 */
export const DXF_NESTED_CLASSIFIER = `0
SECTION
2
ENTITIES
0
LWPOLYLINE
8
0
90
4
70
1
10
0
20
0
10
100
20
0
10
100
20
100
10
0
20
100
0
LWPOLYLINE
8
0
90
4
70
1
10
10
20
10
10
40
20
10
10
40
20
40
10
10
20
40
0
LINE
8
0
10
50
20
50
11
80
20
80
0
ENDSEC
0
EOF`

/**
 * Assign the source-units select to "mm".  Needed when auto-detection
 * returns no units (common for synthetic SVG/DXF).
 */
export async function selectSourceUnitsMm(dialog: Locator): Promise<void> {
  const row = dialog.locator('.import-dialog__info-row').filter({ hasText: 'Source Units' })
  await row.locator('select').selectOption('mm')
}

/**
 * Open the Import Geometry dialog via the toolbar, wait for it to be
 * visible, and return the dialog locator.
 */
export async function openImportDialog(page: import('@playwright/test').Page): Promise<Locator> {
  await page.locator('button[aria-label="Import geometry"]').click()
  const dialog = page.locator('.dialog--import')
  await dialog.waitFor({ state: 'visible', timeout: 5000 })
  return dialog
}
