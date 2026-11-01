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
 * What a document pointerdown may end a pending Feature Distribution on
 * (issue #1112 rt5-c). The failing behaviour was on a tablet only: rt5-a moved
 * the workspace face control into the top command bar, which the cancel rule
 * covers wholesale, so tapping "Show other side" there closed the panel while
 * the desktop's tab-row copy never did. The fixture is the real DOM shape — the
 * face control inside `.app-toolbar`, its menu portalled to the body — so the
 * exempt selector is what decides the answer.
 *
 * Run with:
 *   NODE_OPTIONS=--no-experimental-global-navigator npx tsx src/components/canvas/featureDistributionCancelTarget.test.ts
 */

import { strict as assert } from 'node:assert'
import { parseHTML } from 'linkedom'
import type { PendingFeatureDistribution } from '../../store/types'
import { cancelFeatureDistributionOnPointerDown, isFeatureDistributionCancelTarget } from './featureDistributionCancelTarget'

// The tablet shell's top command bar (the desktop has no `.app-toolbar` around
// the face control, which is why the same tap behaved differently there), plus
// the other chrome the rule covers and one in-flow menu variant for the
// portalled menu the control actually draws.
const { document, window } = parseHTML(`<!doctype html><html><body>
  <header class="app-toolbar" id="top-bar">
    <button class="top-cmd-btn top-cmd-btn--project-panel" id="project-panel-button"><span id="project-panel-icon"></span></button>
    <div class="face-switch" id="face-switch">
      <button class="face-switch__trigger" id="face-trigger"><span id="face-trigger-icon"></span></button>
      <div class="face-switch__menu" id="inline-face-menu">
        <button class="face-switch__menu-item" id="inline-other-side"></button>
      </div>
    </div>
    <button class="top-cmd-btn" id="plain-top-bar-button"></button>
  </header>
  <div class="toolbar" id="toolbar">
    <div class="toolbar-group toolbar-group--snap" id="snap-group"><button id="snap-button"></button></div>
    <button id="toolbar-button"></button>
  </div>
  <div class="tool-rail" id="tool-rail"><button id="tool-rail-button"></button></div>
  <div class="tool-rail__popover" id="tool-rail-popover"><button id="tool-rail-popover-button"></button></div>
  <div class="face-switch__menu" id="portalled-face-menu">
    <button class="face-switch__menu-item" id="portalled-other-side"></button>
  </div>
  <div class="canvas-workflow-panel canvas-workflow-panel--feature-distribution" id="distribution-panel">
    <button id="panel-button"></button>
  </div>
  <div class="tree-row tree-row--feature" id="tree-row"></div>
  <canvas class="sketch-canvas" id="canvas"></canvas>
</body></html>`)

function node(id: string): Element {
  const element = document.getElementById(id)
  assert.ok(element, `the fixture is missing #${id}`)
  return element as unknown as Element
}

const cancels = (id: string, message: string) =>
  assert.equal(isFeatureDistributionCancelTarget(node(id)), true, message)
const keeps = (id: string, message: string) =>
  assert.equal(isFeatureDistributionCancelTarget(node(id)), false, message)

// The bars themselves still end the workflow, as before rt5-c.
cancels('plain-top-bar-button', 'a top command bar button outside the exemptions still cancels')
cancels('toolbar-button', 'a toolbar button still cancels')
cancels('tool-rail-button', 'a tool-rail button still cancels')
cancels('tool-rail-popover-button', 'a tool-rail popover button still cancels')

// The workspace face control, in the bar rt5-a moved it into (#1112 rt5-a).
keeps('face-trigger', 'the face control in the top command bar keeps Feature Distribution open')
keeps('face-trigger-icon', 'a pointerdown on the control\'s own content keeps it open')
keeps('face-switch', 'the control\'s host box keeps it open')
keeps('inline-face-menu', 'the control\'s menu keeps it open when drawn in flow')
keeps('inline-other-side', 'choosing an entry from an in-flow menu keeps it open')
keeps('portalled-other-side', 'choosing the menu entry keeps it open (the menu is portalled outside every bar)')
keeps('portalled-face-menu', 'the portalled menu keeps it open')

// The exemptions that predate rt5-c, moved into the same predicate.
keeps('snap-button', 'the snap controls keep it open')
keeps('project-panel-button', 'the project-panel toggle keeps it open')
keeps('project-panel-icon', 'a pointerdown on the project-panel toggle\'s icon keeps it open')

// The workflow ends through its own controls, the canvas and tree picks — a
// pointerdown there is an action, not a departure.
keeps('panel-button', 'the workflow panel keeps it open')
keeps('canvas', 'the canvas keeps it open')
keeps('tree-row', 'a feature tree row is a pick, not a departure')

// Without a bar ancestor there is nothing to cancel on.
const loose = document.createElement('button')
assert.equal(isFeatureDistributionCancelTarget(loose as unknown as Element), false, 'a detached control does not cancel')

// The handler `useFeatureDistributionWorkflow` binds to document pointerdown,
// with a fake target and a counting cancel: the guards are part of the rule, so
// a mutation that drops one has to fail here.
const globals = globalThis as unknown as Record<string, unknown>
globals.Element = window.Element
const pending: PendingFeatureDistribution = {
  sourceIds: ['subject'],
  guideId: null,
  pickTarget: 'guide',
  radialCenterPicked: false,
  spec: { mode: 'path', copyCount: 2, startOffset: 0, endOffset: 0, orientation: 'follow', startScale: 100, endScale: 100 },
  session: 1,
}
let cancelled = 0
const cancel = (): void => { cancelled += 1 }

cancelFeatureDistributionOnPointerDown(pending, node('face-trigger'), cancel)
assert.equal(cancelled, 0, 'the tablet face control does not cancel the pending workflow')
cancelFeatureDistributionOnPointerDown(pending, node('portalled-other-side'), cancel)
assert.equal(cancelled, 0, 'the face menu entry does not cancel it either')
cancelFeatureDistributionOnPointerDown(pending, node('canvas'), cancel)
assert.equal(cancelled, 0, 'the canvas does not cancel it')
cancelFeatureDistributionOnPointerDown(null, node('toolbar-button'), cancel)
assert.equal(cancelled, 0, 'a closed workflow has nothing to cancel')
cancelFeatureDistributionOnPointerDown(pending, null, cancel)
assert.equal(cancelled, 0, 'a non-element target is ignored')
cancelFeatureDistributionOnPointerDown(pending, {} as EventTarget, cancel)
assert.equal(cancelled, 0, 'a target that is not an Element is ignored')
cancelFeatureDistributionOnPointerDown(pending, node('toolbar-button'), cancel)
assert.equal(cancelled, 1, 'a plain toolbar tap still ends the workflow')

