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

import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { aroundSelectionFixture } from './aroundSelection.testSupport'
import { useCanvasContextMenu, type CanvasContextMenuCtx } from './useCanvasContextMenu'

for (const axis of ['x', 'y'] as const) {
  const f = aroundSelectionFixture(axis)
  const selected: string[] = []
  const menus: string[] = []
  const ctx: CanvasContextMenuCtx = {
    canvasRef: { current: f.canvas }, projectRef: { current: f.project },
    selectionRef: { current: f.selection }, viewStateRef: { current: f.viewState },
    pendingAddRef: { current: null }, pendingMoveRef: { current: null },
    pendingTransformRef: { current: null }, pendingOffsetRef: { current: null },
    didPanRef: { current: false }, suppressClickRef: { current: false }, zoomWindowActive: false,
    stopPan: () => {}, selectClamp: () => { throw new Error('not a clamp') },
    selectTab: () => { throw new Error('not a tab') }, selectFeature: (id) => selected.push(id),
    onFeatureContextMenu: (id) => menus.push(id),
  }
  function Probe() {
    const menu = useCanvasContextMenu(ctx)
    const { cx, cy } = f.screen()
    menu.handleContextMenu({ clientX: cx, clientY: cy, preventDefault() {} } as Parameters<typeof menu.handleContextMenu>[0])
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  assert.deepEqual(selected, ['second'], `${axis}: right-click selects the topmost band`)
  assert.deepEqual(menus, ['second'], `${axis}: menu belongs to the same band`)
  f.project.activeSetupId = f.project.setups[0].id
  renderToStaticMarkup(createElement(Probe))
  assert.equal(selected.pop(), 'first', `${axis}: Top still selects model footprints`)
}
console.log('useCanvasContextMenu: Around band regression passed')
