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
 * The packed move format loses nothing (issue #675, slice 6).
 *
 * A packed format is a second description of what a toolpath is, and the way it
 * fails is silent: a field it forgets simply stops existing, and the program
 * still looks like a program. So this runs the **entire** parity corpus through
 * pack/unpack and compares canonicalised values — not a sample, and not a
 * hand-written fixture that would only describe the fields I remembered.
 *
 * `structuredClone` is applied between pack and unpack on purpose: that is what
 * `postMessage` does, and it is what proves the packed shape actually survives
 * the boundary rather than merely surviving a function call.
 */

import { computeOperationToolpath } from '../../engine/toolpaths'
import { buildParityCorpus } from '../../engine/toolpaths/parityCorpus'
import { canonicalize } from '../../engine/toolpaths/parityRecord'
import { resolveOperation } from './protocol'
import {
  TRANSPORT_MOVE_KINDS,
  isPackedMoves,
  packMoves,
  packResult,
  transferablesOf,
  unpackMoves,
  unpackResult,
} from './moveTransport'
import type { ToolpathMove } from '../../engine/toolpaths/types'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail: string): void {
  if (condition) { passed += 1; return }
  failed += 1
  console.log(`   ✗ ${name}: ${detail}`)
}

console.log('\nPacked move transport — fidelity over the whole corpus')

const corpus = buildParityCorpus()
let totalMoves = 0
let withSource = 0
let withFeedScale = 0

function corpusIncludesPattern(id: string, kind: string, pattern: string): boolean {
  const parityCase = corpus.find((candidate) => candidate.id === id)
  const operation = parityCase && resolveOperation(parityCase.project, parityCase.operationId)
  return operation?.kind === kind && operation.pocketPattern === pattern
}

check(
  'the corpus includes a trochoidal pocket',
  corpusIncludesPattern('synthetic/pocket_trochoidal', 'pocket', 'trochoidal'),
  'Pocket trochoidal generation is absent from the worker/inline parity corpus',
)
check(
  'the corpus includes a constant-scallop finish',
  corpusIncludesPattern(
    'variant/3d-imported-block-test3-constant-scallop/op6792424-constant-scallop',
    'finish_surface',
    'constant_scallop',
  ),
  'Finish Surface Constant Scallop generation is absent from the worker/inline parity corpus',
)

for (const parityCase of corpus) {
  const operation = resolveOperation(parityCase.project, parityCase.operationId)
  if (!operation) continue
  const envelope = computeOperationToolpath(parityCase.project, operation, { trace: true })
  if (!envelope) continue

  totalMoves += envelope.result.moves.length
  withSource += envelope.result.moves.filter((move) => move.source !== undefined).length
  withFeedScale += envelope.result.moves.filter((move) => move.feedScale !== undefined).length

  // The full trip: pack, cross the boundary, unpack.
  const transported = structuredClone(packResult(envelope.result))
  check(
    `${parityCase.id}: packed payload validates`,
    isPackedMoves(transported.packedMoves),
    'the packed payload failed its own shape check after cloning',
  )
  const restored = unpackResult(transported)

  check(
    `${parityCase.id}: result survives packing`,
    canonicalize(restored) === canonicalize(envelope.result),
    'the unpacked result differs from the generated one',
  )

  if (envelope.raw) {
    const restoredRaw = unpackResult(structuredClone(packResult(envelope.raw)))
    check(
      `${parityCase.id}: raw trace survives packing`,
      canonicalize(restoredRaw) === canonicalize(envelope.raw),
      'the unpacked raw trace differs',
    )
  }
}

console.log(
  `   corpus: ${corpus.length} cases, ${totalMoves.toLocaleString()} moves`
  + ` (${withSource.toLocaleString()} with a source tag, ${withFeedScale.toLocaleString()} with a feed scale)`,
)

// The corpus must actually contain the sparse fields, or the checks above are
// vacuous for them — this is the assertion that keeps this suite honest.
check(
  'the corpus exercises source tags',
  withSource > 0,
  'no move in the corpus carries a source tag, so packing it is untested',
)
check(
  'the corpus exercises feed scales',
  withFeedScale > 0,
  'no move in the corpus carries a feed scale, so packing it is untested',
)

check(
  'the transfer check rejects a lone or mismatched angle pair',
  (() => {
    const packed = structuredClone(packMoves([
      { kind: 'cut', from: { x: 0, y: 0, z: 0, a: 0 }, to: { x: 1, y: 0, z: 0, a: 90 } },
    ]))
    if (!isPackedMoves(packed)) return false
    const lone = { ...packed, angleValues: undefined }
    const mismatched = { ...packed, angleValues: new Float64Array([0]) }
    const overLong = { ...packed, angleIndices: new Uint32Array([0, 1, 2]) }
    return !isPackedMoves(lone) && !isPackedMoves(mismatched) && !isPackedMoves(overLong)
  })(),
  'a malformed angle payload passed its own shape check',
)

check(
  'the transfer check accepts a valid angle payload',
  isPackedMoves(structuredClone(packMoves([
    { kind: 'cut', from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0, a: 0 } },
  ]))),
  'a valid angle payload was rejected after cloning',
)

console.log('\nEdge cases')

check('an empty path packs and unpacks', unpackMoves(packMoves([])).length === 0, 'empty round trip failed')

check(
  'every declared move kind round-trips',
  (() => {
    const moves: ToolpathMove[] = TRANSPORT_MOVE_KINDS.map((kind, index) => ({
      kind,
      from: { x: 0, y: 0, z: 0, a: index * 90 },
      to: { x: 1, y: 2, z: 3, a: -index * 45 },
    }))
    return canonicalize(unpackMoves(packMoves(moves))) === canonicalize(moves)
  })(),
  'a move kind did not survive the index encoding',
)

// ── The rotary angle (issue #393) ─────────────────────────────

check(
  'an angle-free toolpath packs to exactly the pre-rotary layout',
  (() => {
    const moves: ToolpathMove[] = [
      { kind: 'rapid', from: { x: 0, y: 0, z: 5 }, to: { x: 0, y: 0, z: 0 } },
      { kind: 'cut', from: { x: 0, y: 0, z: 0 }, to: { x: 10, y: 0, z: 0 }, feedScale: 0.5, source: 'tag' },
    ]
    const packed = packMoves(moves)
    // Not merely an empty pair: the fields are absent, so the transfer list and
    // the buffer layout are the ones an all-linear toolpath always had.
    return packed.angleIndices === undefined
      && packed.angleValues === undefined
      && transferablesOf(packResult({ operationId: 'op', moves, warnings: [], bounds: null })).length === 5
  })(),
  'an angle-free toolpath gained angle buffers, changing its packed layout',
)

check(
  'absent / 0 / -45 / 900 / mixed angles all round-trip exactly',
  (() => {
    const moves: ToolpathMove[] = [
      // Absent at both ends.
      { kind: 'cut', from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 } },
      // A real zero is not an absent angle.
      { kind: 'cut', from: { x: 1, y: 0, z: 0, a: 0 }, to: { x: 2, y: 0, z: 0, a: 0 } },
      // Negative and past a full turn, never reduced.
      { kind: 'cut', from: { x: 2, y: 0, z: 0, a: -45 }, to: { x: 3, y: 0, z: 0, a: 900 } },
      // Mixed within one toolpath: an angle at one end only, and a full
      // mantissa value that a Float32 encoding would move.
      { kind: 'rapid', from: { x: 3, y: 0, z: 0 }, to: { x: 4, y: 0, z: 0, a: 12.345678901234567 } },
      { kind: 'plunge', from: { x: 4, y: 0, z: 0, a: 12.345678901234567 }, to: { x: 4, y: 0, z: -1 } },
    ]
    const restored = unpackMoves(structuredClone(packMoves(moves)))
    return restored.every((move, index) => {
      const source = moves[index]
      const sameEnd = (end: 'from' | 'to'): boolean => {
        const expected = source[end]
        const actual = move[end]
        if (expected.a === undefined) return !('a' in actual)
        return Object.is(actual.a, expected.a)
      }
      return sameEnd('from') && sameEnd('to')
    })
  })(),
  'an angle changed, appeared, or disappeared through the packed encoding',
)

check(
  'an unknown move kind is refused, not silently remapped',
  (() => {
    try {
      packMoves([{ kind: 'teleport' as ToolpathMove['kind'], from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 0 } }])
      return false
    } catch {
      return true
    }
  })(),
  'an unencodable kind was accepted — it would arrive as a different motion',
)

check(
  'awkward doubles survive exactly',
  (() => {
    // Values chosen to break a Float32 encoding: full mantissa, tiny magnitudes,
    // and negative zero, whose sign a naive comparison would miss.
    const values = [0.1 + 0.2, 1 / 3, 1e-9, -0, 12345.678901234567, Number.MIN_SAFE_INTEGER]
    const moves: ToolpathMove[] = values.map((value) => ({
      kind: 'cut' as const,
      from: { x: value, y: -value, z: value / 7 },
      to: { x: value * 3, y: value, z: -value },
    }))
    const restored = unpackMoves(packMoves(moves))
    return restored.every((move, index) => (
      Object.is(move.from.x, moves[index].from.x)
      && Object.is(move.from.y, moves[index].from.y)
      && Object.is(move.to.z, moves[index].to.z)
    ))
  })(),
  'a coordinate changed value through the packed encoding',
)

check(
  'sparse fields land on the right moves',
  (() => {
    const moves: ToolpathMove[] = [
      { kind: 'cut', from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 } },
      { kind: 'cut', from: { x: 1, y: 0, z: 0 }, to: { x: 2, y: 0, z: 0 }, feedScale: 0.5 },
      { kind: 'rapid', from: { x: 2, y: 0, z: 0 }, to: { x: 3, y: 0, z: 0 }, source: 'tag' },
      { kind: 'cut', from: { x: 3, y: 0, z: 0 }, to: { x: 4, y: 0, z: 0 }, feedScale: 0.25, source: 'both' },
      { kind: 'plunge', from: { x: 4, y: 0, z: 0 }, to: { x: 4, y: 0, z: -1 } },
    ]
    return canonicalize(unpackMoves(packMoves(moves))) === canonicalize(moves)
  })(),
  'a sparse field was attached to the wrong move',
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
