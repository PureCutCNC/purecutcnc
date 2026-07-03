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
 * Tests for the WebGL context-loss guard.
 *
 * Run with: npx tsx src/components/viewport3d/webglContextGuard.test.ts
 *
 * There is no DOM in the test runner; an EventTarget stands in for the
 * canvas, which is all the guard uses.
 */

import { attachWebglContextGuard } from './webglContextGuard'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function makeCanvasStub(): HTMLCanvasElement {
  return new EventTarget() as unknown as HTMLCanvasElement
}

function testForwardsLostAndRestoredEvents(): void {
  const canvas = makeCanvasStub()
  let lost = 0
  let restored = 0
  attachWebglContextGuard(canvas, {
    onLost: () => { lost += 1 },
    onRestored: () => { restored += 1 },
  })

  canvas.dispatchEvent(new Event('webglcontextlost'))
  assert(lost === 1 && restored === 0, 'expected onLost after webglcontextlost')

  canvas.dispatchEvent(new Event('webglcontextrestored'))
  assert(lost === 1 && restored === 1, 'expected onRestored after webglcontextrestored')

  canvas.dispatchEvent(new Event('webglcontextlost'))
  canvas.dispatchEvent(new Event('webglcontextrestored'))
  assert(lost === 2 && restored === 2, 'expected repeated loss/restore cycles to keep forwarding')
}

function testDetachStopsForwarding(): void {
  const canvas = makeCanvasStub()
  let lost = 0
  let restored = 0
  const detach = attachWebglContextGuard(canvas, {
    onLost: () => { lost += 1 },
    onRestored: () => { restored += 1 },
  })

  detach()
  canvas.dispatchEvent(new Event('webglcontextlost'))
  canvas.dispatchEvent(new Event('webglcontextrestored'))
  assert(lost === 0 && restored === 0, 'expected no callbacks after detach')
}

function testDetachOnlyRemovesOwnListeners(): void {
  const canvas = makeCanvasStub()
  let first = 0
  let second = 0
  const detachFirst = attachWebglContextGuard(canvas, {
    onLost: () => { first += 1 },
    onRestored: () => {},
  })
  attachWebglContextGuard(canvas, {
    onLost: () => { second += 1 },
    onRestored: () => {},
  })

  detachFirst()
  canvas.dispatchEvent(new Event('webglcontextlost'))
  assert(first === 0, 'expected detached guard to stop receiving events')
  assert(second === 1, 'expected other guard to keep receiving events')
}

testForwardsLostAndRestoredEvents()
testDetachStopsForwarding()
testDetachOnlyRemovesOwnListeners()
console.log('webgl context guard tests passed')
