/**
 * Tests for STL import profile and bounds extraction.
 *
 * Run with: npx tsx src/import/stl.test.ts
 */

import { extractStlProfileAndBounds } from './stl'

type AxisSwap = 'none' | 'yz' | 'xz' | 'xy'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(a: number, b: number, epsilon = 1e-6): boolean {
  return Math.abs(a - b) < epsilon
}

export function makeFrustumStlBase64(): string {
  const vertices = {
    b0: [0, 0, 0],
    b1: [12, 0, 0],
    b2: [12, 8, 0],
    b3: [0, 8, 0],
    t0: [4, 2, 6],
    t1: [8, 2, 6],
    t2: [8, 6, 6],
    t3: [4, 6, 6],
  } as const

  const faces: Array<[keyof typeof vertices, keyof typeof vertices, keyof typeof vertices]> = [
    ['b0', 'b2', 'b1'], ['b0', 'b3', 'b2'],
    ['t0', 't1', 't2'], ['t0', 't2', 't3'],
    ['b0', 'b1', 't1'], ['b0', 't1', 't0'],
    ['b1', 'b2', 't2'], ['b1', 't2', 't1'],
    ['b2', 'b3', 't3'], ['b2', 't3', 't2'],
    ['b3', 'b0', 't0'], ['b3', 't0', 't3'],
  ]

  const lines = ['solid frustum']
  for (const face of faces) {
    lines.push('  facet normal 0 0 0')
    lines.push('    outer loop')
    for (const key of face) {
      lines.push(`      vertex ${vertices[key].join(' ')}`)
    }
    lines.push('    endloop')
    lines.push('  endfacet')
  }
  lines.push('endsolid frustum')
  return btoa(`${lines.join('\n')}\n`)
}

async function testAxisBounds(): Promise<void> {
  console.log('Testing STL import axis-oriented Z bounds...')

  const cases: Array<{ axis: AxisSwap; zTop: number }> = [
    { axis: 'none', zTop: 6 },
    { axis: 'yz', zTop: 8 },
    { axis: 'xz', zTop: 12 },
    { axis: 'xy', zTop: 6 },
  ]

  for (const { axis, zTop } of cases) {
    const result = await extractStlProfileAndBounds(makeFrustumStlBase64(), 1, axis)
    assert(result !== null, `expected extraction result for axis ${axis}`)
    assert(approx(result!.z_bottom, 0), `expected z_bottom=0 for axis ${axis}, got ${result!.z_bottom}`)
    assert(approx(result!.z_top, zTop), `expected z_top=${zTop} for axis ${axis}, got ${result!.z_top}`)
    assert(result!.profile.closed, `expected closed profile for axis ${axis}`)
    assert(result!.profile.segments.length >= 3, `expected polygon profile for axis ${axis}`)
  }
}

testAxisBounds()
  .then(() => console.log('stl import tests passed'))
  .catch((error) => {
    console.error(error)
    throw error
  })
