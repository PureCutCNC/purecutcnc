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

import {
  compositeOver,
  contrastRatio,
  flattenStack,
  formatColor,
  normalizeColorValue,
  opaqueHex,
  parseColor,
  perceptualDistance,
} from './color'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(actual: number, expected: number, tolerance: number, message: string): void {
  assert(Math.abs(actual - expected) <= tolerance, `${message} (got ${actual}, expected ~${expected})`)
}

// Parsing.
assert(JSON.stringify(parseColor('#fff')) === JSON.stringify({ r: 255, g: 255, b: 255, a: 1 }), '#fff parses')
assert(JSON.stringify(parseColor('#dca56a')) === JSON.stringify({ r: 220, g: 165, b: 106, a: 1 }), 'six-digit hex parses')
approx(parseColor('#00000080')!.a, 128 / 255, 0.001, 'eight-digit hex alpha parses')
assert(parseColor('rgb(220, 165, 106)')!.g === 165, 'rgb() parses')
approx(parseColor('rgba(16, 24, 33, 0.94)')!.a, 0.94, 0.0001, 'rgba() alpha parses')
approx(parseColor('rgba(16, 24, 33, 50%)')!.a, 0.5, 0.0001, 'percent alpha parses')
assert(parseColor('') === null, 'empty string rejected')
assert(parseColor('red') === null, 'keywords rejected')
assert(parseColor('url(evil)') === null, 'functions rejected')
assert(parseColor('var(--text)') === null, 'var() rejected')
assert(parseColor('#12345') === null, 'wrong hex length rejected')
assert(parseColor('rgb(300, 0, 0)') === null, 'out-of-range channel rejected')
assert(parseColor('linear-gradient(#000, #fff)') === null, 'gradients rejected')

// Normalization.
assert(formatColor({ r: 255, g: 255, b: 255, a: 1 }) === '#ffffff', 'opaque formats to 6-digit hex')
assert(formatColor({ r: 0, g: 0, b: 0, a: 0.5 }) === '#00000080', 'translucent keeps alpha byte')
assert(normalizeColorValue('RGB(220, 165, 106)') === '#dca56a', 'rgb normalizes to hex')
assert(normalizeColorValue('#ABC') === '#aabbcc', 'short hex expands lowercase')
assert(normalizeColorValue('nonsense') === null, 'invalid value normalizes to null')
assert(opaqueHex(parseColor('rgba(16, 24, 33, 0.94)')!) === '#101821', 'opaque part extracted for color inputs')

// Compositing.
const half = compositeOver({ r: 255, g: 255, b: 255, a: 0.5 }, { r: 0, g: 0, b: 0, a: 1 })
approx(half.r, 127.5, 0.01, 'source-over blends channels')
assert(half.a === 1, 'compositing over opaque yields opaque')
const flattened = flattenStack([
  { r: 255, g: 0, b: 0, a: 0.5 },
  { r: 0, g: 0, b: 255, a: 1 },
])
approx(flattened.r, 127.5, 0.01, 'stack flattens topmost first')
assert(flattened.a === 1, 'flattened stack is opaque')

// WCAG contrast.
approx(contrastRatio(parseColor('#ffffff')!, parseColor('#000000')!), 21, 0.01, 'white on black is 21:1')
approx(contrastRatio(parseColor('#000000')!, parseColor('#ffffff')!), 21, 0.01, 'ratio is symmetric')
approx(contrastRatio(parseColor('#777777')!, parseColor('#777777')!), 1, 0.01, 'same color is 1:1')
const composited = contrastRatio(parseColor('rgba(255, 255, 255, 0.5)')!, parseColor('#000000')!)
assert(composited < 21 && composited > 4, 'translucent foreground is composited before measuring')

// Perceptual distance.
const base = parseColor('#0f151d')!
assert(perceptualDistance(parseColor('#5a8fcc')!, parseColor('#9966cc')!, base) > 20, 'blue vs purple is distinguishable')
approx(perceptualDistance(parseColor('#5a8fcc')!, parseColor('#5a8fcc')!, base), 0, 0.001, 'identical colors have zero distance')
assert(
  perceptualDistance(parseColor('#5a8fcc')!, parseColor('#5c91cd')!, base) < 5,
  'near-identical colors measure as hard to distinguish',
)

console.log('color tests passed')
