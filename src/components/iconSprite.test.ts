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
 * Unit tests for the icon-sprite assembly (issue #176): a folder of sample
 * standalone SVGs must produce a sprite whose `<symbol>` ids, viewBoxes and
 * inner paint are preserved, and whose root carries NO `display:none`.
 *
 * Run with: npx tsx src/components/iconSprite.test.ts
 */

import { assembleSprite, parseIconSvg } from './iconSprite'

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function testParsePreservesViewBoxAndInner() {
  const parsed = parseIconSvg(
    'rect',
    `<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" stroke="currentColor">\n  <path d="M 1 1 L 2 2" />\n</svg>\n`,
  )
  assert(parsed.id === 'rect', 'id is carried through')
  assert(parsed.viewBox === '0 0 32 32', 'viewBox copied from source svg')
  assert(parsed.inner.includes('<path d="M 1 1 L 2 2" />'), 'inner path preserved')
  assert(!parsed.inner.includes('<svg'), 'outer svg stripped from inner')
  console.log('parse preserves viewBox + inner: PASSED')
}

function testParseDefaultsViewBox() {
  const parsed = parseIconSvg('x', `<svg xmlns="http://www.w3.org/2000/svg"><path d="M 0 0" /></svg>`)
  assert(parsed.viewBox === '0 0 24 24', 'viewBox defaults to 24x24 when absent')
  console.log('parse defaults viewBox: PASSED')
}

function testParseStripsEditorCruft() {
  const parsed = parseIconSvg(
    'y',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">\n` +
      `  <metadata id="m">junk</metadata>\n` +
      `  <sodipodi:namedview id="nv" showgrid="false" />\n` +
      `  <!-- a comment -->\n` +
      `  <path d="M 0 0 L 1 1" />\n` +
      `</svg>`,
  )
  assert(!parsed.inner.includes('metadata'), 'metadata block stripped')
  assert(!parsed.inner.includes('namedview'), 'sodipodi:namedview stripped')
  assert(!parsed.inner.includes('comment'), 'comments stripped')
  assert(parsed.inner.includes('<path d="M 0 0 L 1 1" />'), 'real path kept')
  console.log('parse strips editor cruft: PASSED')
}

function testParsePreservesColourPaint() {
  // A colour icon sets paint on its elements — that must survive into the symbol.
  const parsed = parseIconSvg(
    'colorful',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect fill="#ff0000" x="2" y="2" width="20" height="20" /></svg>`,
  )
  assert(parsed.inner.includes('fill="#ff0000"'), 'element-level fill preserved')
  console.log('parse preserves colour paint: PASSED')
}

function testParseRejectsNonSvg() {
  let threw = false
  try {
    parseIconSvg('bad', 'not an svg at all')
  } catch {
    threw = true
  }
  assert(threw, 'malformed source throws instead of emitting an empty symbol')
  console.log('parse rejects non-svg: PASSED')
}

function testAssembleSpriteContract() {
  const sprite = assembleSprite([
    parseIconSvg('b', `<svg viewBox="0 0 24 24"><path d="M 2 2" /></svg>`),
    parseIconSvg('a', `<svg viewBox="0 0 10 10"><path d="M 1 1" /></svg>`),
  ])

  assert(sprite.startsWith('<svg xmlns="http://www.w3.org/2000/svg">'), 'sprite root present')
  assert(!sprite.includes('display'), 'sprite root carries NO display:none (issue #176)')
  assert(sprite.includes('<symbol id="b" viewBox="0 0 24 24">'), 'symbol b with its viewBox')
  assert(sprite.includes('<symbol id="a" viewBox="0 0 10 10">'), 'symbol a keeps its own viewBox')
  assert(sprite.includes('<path d="M 2 2" />'), 'path content carried into symbol')
  assert((sprite.match(/<symbol/g) ?? []).length === 2, 'one symbol per input icon')
  console.log('assemble sprite contract: PASSED')
}

try {
  testParsePreservesViewBoxAndInner()
  testParseDefaultsViewBox()
  testParseStripsEditorCruft()
  testParsePreservesColourPaint()
  testParseRejectsNonSvg()
  testAssembleSpriteContract()
  console.log('\nAll iconSprite tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
