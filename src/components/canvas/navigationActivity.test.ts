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
import { createNavigationActivity } from './navigationActivity'

function fixture() {
  let redraws = 0
  let nextHandle = 0
  const timers = new Map<number, () => void>()
  const activity = createNavigationActivity(
    () => { redraws++ },
    (callback, delay) => { assert.equal(delay, 150); timers.set(++nextHandle, callback); return nextHandle },
    (handle) => { timers.delete(handle) },
  )
  return {
    activity, timers,
    get redraws() { return redraws },
    idle() { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()) },
  }
}

{
  const f = fixture()
  assert.equal(f.activity.active, false)
  f.activity.changed()
  f.activity.changed()
  assert.equal(f.activity.active, true)
  assert.equal(f.timers.size, 1, 'wheel changes replace rather than queue final redraws')
  f.idle()
  assert.equal(f.activity.active, false)
  assert.equal(f.redraws, 1)
  f.idle()
  assert.equal(f.redraws, 1, 'idle does not repeatedly rebuild')
}
{
  const f = fixture()
  f.activity.pointerDown(1)
  assert.equal(f.activity.active, false, 'clicking without navigation does not hide arrows')
  f.activity.changed()
  f.activity.pointerDown(2)
  f.idle()
  assert.equal(f.activity.active, true, 'holding a pan/pinch past idle keeps arrows deferred')
  f.activity.pointerUp(1)
  assert.equal(f.activity.active, true, 'remaining touch still owns the gesture')
  f.activity.pointerUp(2)
  assert.equal(f.activity.active, false)
  assert.equal(f.redraws, 1)
  assert.equal(f.timers.size, 0)
}
{
  const f = fixture()
  f.activity.pointerDown(1)
  f.activity.changed()
  f.activity.pointerUp(1) // Same handler for pointercancel and capture loss.
  f.idle()
  assert.equal(f.redraws, 1, 'release/cancel cancels the pending idle redraw')
  f.activity.changed()
  f.activity.blur()
  f.idle()
  assert.equal(f.redraws, 2, 'blur restores detail once')
}
{
  const f = fixture()
  f.activity.changed()
  f.activity.dispose()
  f.idle()
  assert.equal(f.activity.active, false)
  assert.equal(f.redraws, 0, 'unmount cancels work without drawing')
  f.activity.changed()
  f.idle()
  assert.equal(f.redraws, 1, 'effect replay can reuse the controller')
}
console.log('navigationActivity tests passed')
