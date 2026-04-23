/**
 * Unit tests for axis lock utilities.
 * Run with: npx tsx src/sketch/useAxisLock.test.ts
 */

import { cycleLockMode, lockModeGuideColor } from './useAxisLock'
import type { LockMode } from '../types/axisLock'

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(a: number, b: number, epsilon = 1e-9) {
  return Math.abs(a - b) < epsilon
}

// ---- cycleLockMode ----

function testCycleLockMode() {
  console.log('Testing cycleLockMode...')

  assert(cycleLockMode('none') === 'x', 'none -> x')
  assert(cycleLockMode('x') === 'y', 'x -> y')
  assert(cycleLockMode('y') === 'none', 'y -> none')

  // Full cycle
  let mode: LockMode = 'none'
  mode = cycleLockMode(mode)
  assert(mode === 'x', 'cycle 1: x')
  mode = cycleLockMode(mode)
  assert(mode === 'y', 'cycle 2: y')
  mode = cycleLockMode(mode)
  assert(mode === 'none', 'cycle 3: none')

  console.log('cycleLockMode: PASSED')
}

// ---- lockModeGuideColor ----

function testLockModeGuideColor() {
  console.log('Testing lockModeGuideColor...')

  const noneColor = lockModeGuideColor('none')
  const xColor = lockModeGuideColor('x')
  const yColor = lockModeGuideColor('y')

  assert(noneColor.includes('239'), 'none color should be amber/default')
  assert(xColor.includes('220'), 'x color should be red-ish')
  assert(yColor.includes('180'), 'y color should be green-ish')
  assert(xColor !== yColor, 'x and y colors should differ')
  assert(xColor !== noneColor, 'x and none colors should differ')
  assert(yColor !== noneColor, 'y and none colors should differ')

  console.log('lockModeGuideColor: PASSED')
}

// ---- applyLock logic (pure function tests, no React) ----

function applyLockPure(point: { x: number; y: number }, origin: { x: number; y: number }, mode: LockMode) {
  if (mode === 'x') return { x: point.x, y: origin.y }
  if (mode === 'y') return { x: origin.x, y: point.y }
  return point
}

function testApplyLockNone() {
  console.log('Testing applyLock (none)...')

  const origin = { x: 10, y: 20 }
  const point = { x: 35, y: 55 }
  const result = applyLockPure(point, origin, 'none')

  assert(approx(result.x, 35), 'none: x unchanged')
  assert(approx(result.y, 55), 'none: y unchanged')

  console.log('applyLock (none): PASSED')
}

function testApplyLockX() {
  console.log('Testing applyLock (x)...')

  const origin = { x: 10, y: 20 }
  const point = { x: 35, y: 55 }
  const result = applyLockPure(point, origin, 'x')

  // Lock X: keep Y fixed at origin.y, allow X to move freely
  assert(approx(result.x, 35), 'lock x: x moves freely')
  assert(approx(result.y, 20), 'lock x: y locked to origin.y')

  console.log('applyLock (x): PASSED')
}

function testApplyLockY() {
  console.log('Testing applyLock (y)...')

  const origin = { x: 10, y: 20 }
  const point = { x: 35, y: 55 }
  const result = applyLockPure(point, origin, 'y')

  // Lock Y: keep X fixed at origin.x, allow Y to move freely
  assert(approx(result.x, 10), 'lock y: x locked to origin.x')
  assert(approx(result.y, 55), 'lock y: y moves freely')

  console.log('applyLock (y): PASSED')
}

function testApplyLockAtOrigin() {
  console.log('Testing applyLock at origin...')

  const origin = { x: 0, y: 0 }
  const point = { x: 5, y: 7 }

  const rx = applyLockPure(point, origin, 'x')
  assert(approx(rx.x, 5), 'at origin, lock x: x = 5')
  assert(approx(rx.y, 0), 'at origin, lock x: y = 0')

  const ry = applyLockPure(point, origin, 'y')
  assert(approx(ry.x, 0), 'at origin, lock y: x = 0')
  assert(approx(ry.y, 7), 'at origin, lock y: y = 7')

  console.log('applyLock at origin: PASSED')
}

function testApplyLockNegativeCoords() {
  console.log('Testing applyLock with negative coordinates...')

  const origin = { x: -5, y: -10 }
  const point = { x: 15, y: -30 }

  const rx = applyLockPure(point, origin, 'x')
  assert(approx(rx.x, 15), 'negative, lock x: x = 15')
  assert(approx(rx.y, -10), 'negative, lock x: y = -10')

  const ry = applyLockPure(point, origin, 'y')
  assert(approx(ry.x, -5), 'negative, lock y: x = -5')
  assert(approx(ry.y, -30), 'negative, lock y: y = -30')

  console.log('applyLock with negative coordinates: PASSED')
}

function testApplyLockSamePoint() {
  console.log('Testing applyLock when point equals origin...')

  const origin = { x: 7, y: 3 }
  const point = { x: 7, y: 3 }

  const rx = applyLockPure(point, origin, 'x')
  assert(approx(rx.x, 7), 'same point, lock x: x = 7')
  assert(approx(rx.y, 3), 'same point, lock x: y = 3')

  const ry = applyLockPure(point, origin, 'y')
  assert(approx(ry.x, 7), 'same point, lock y: x = 7')
  assert(approx(ry.y, 3), 'same point, lock y: y = 3')

  console.log('applyLock same point: PASSED')
}

function testCycleIsIdempotentAfterThree() {
  console.log('Testing cycle is idempotent after 3 steps...')

  let mode: LockMode = 'none'
  for (let i = 0; i < 9; i++) {
    mode = cycleLockMode(mode)
  }
  assert(mode === 'none', 'after 9 cycles (3x3), should be back to none')

  console.log('cycle idempotent: PASSED')
}

try {
  testCycleLockMode()
  testLockModeGuideColor()
  testApplyLockNone()
  testApplyLockX()
  testApplyLockY()
  testApplyLockAtOrigin()
  testApplyLockNegativeCoords()
  testApplyLockSamePoint()
  testCycleIsIdempotentAfterThree()
  console.log('\nAll axis lock tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
