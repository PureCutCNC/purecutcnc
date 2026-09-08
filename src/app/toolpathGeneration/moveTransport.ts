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
 * Packing a toolpath's moves into transferable buffers (issue #675, slice 6).
 *
 * ## Why
 *
 * Slices 1-5 sent results by structured clone. Measured on the 249k-move
 * trochoidal fixture that cost **821 ms**, about half of it deserialising on
 * the main thread — enough that the worker backend blocked the UI *longer* than
 * generating inline did, which is the one outcome that made the whole exercise
 * pointless for big jobs.
 *
 * The cost is not the bytes, it is the objects: 249k moves are ~750k small
 * objects, and clone walks and rebuilds every one. Packed into typed arrays the
 * same data transfers as three buffers — a pointer handoff — and the same
 * fixture costs **23 ms to pack and 33 ms to unpack**.
 *
 * ## Fidelity, which is the whole risk
 *
 * A packed format is a second description of what a move is, and a field it
 * forgets is a field that silently disappears from a program. Two things keep
 * that honest:
 *
 *  - **Coordinates are `Float64Array`, never `Float32Array`.** Measured across
 *    every coordinate of that fixture, Float64 round-trips exactly (0 of ~1.5M
 *    values drift). Float32 would quietly move the toolpath.
 *  - The parity corpus is the backstop. `workerRuntime.test.ts` compares worker
 *    results against pre-extraction hashes, so a dropped field fails there
 *    immediately rather than reaching a machine.
 *
 * `source` and `feedScale` are **sparse** — on that fixture 1,622 and 1,620 of
 * 249,663 moves — so they are carried as index/value pairs rather than
 * full-length arrays. Encoding them densely would have added 4 MB of mostly
 * padding to every transfer.
 */

import type { ToolpathMove, ToolpathMoveKind, ToolpathResult } from '../../engine/toolpaths/types'

/**
 * The move kinds, in a fixed order that **is** the wire encoding.
 *
 * Appending is safe; reordering or removing is a breaking protocol change and
 * must bump `TOOLPATH_PROTOCOL_VERSION`, because an index means a different
 * kind either side of it.
 */
export const TRANSPORT_MOVE_KINDS: readonly ToolpathMoveKind[] = [
  'rapid',
  'plunge',
  'cut',
  'lead_in',
  'lead_out',
]

const KIND_INDEX = new Map<ToolpathMoveKind, number>(
  TRANSPORT_MOVE_KINDS.map((kind, index) => [kind, index]),
)

/** Six doubles per move: from x/y/z then to x/y/z. */
const COORDS_PER_MOVE = 6

export interface PackedMoves {
  count: number
  /** Index into `TRANSPORT_MOVE_KINDS`, one per move. */
  kinds: Uint8Array
  /** `count * 6` doubles, from.x/y/z then to.x/y/z. */
  coords: Float64Array
  /** Indices of moves carrying a feed scale, ascending. */
  feedScaleIndices: Uint32Array
  feedScaleValues: Float64Array
  /** Indices of moves carrying a debug source tag, ascending. */
  sourceIndices: Uint32Array
  /** Tags, parallel to `sourceIndices`. Strings cannot live in a typed array,
   *  so these clone normally — there are few, and they repeat. */
  sourceValues: string[]
}

/** A result whose moves have been lifted out into buffers. */
export interface TransportedResult extends Omit<ToolpathResult, 'moves'> {
  packedMoves: PackedMoves
}

export function packMoves(moves: readonly ToolpathMove[]): PackedMoves {
  const count = moves.length
  const kinds = new Uint8Array(count)
  const coords = new Float64Array(count * COORDS_PER_MOVE)

  const feedScaleIndices: number[] = []
  const feedScaleValues: number[] = []
  const sourceIndices: number[] = []
  const sourceValues: string[] = []

  for (let index = 0; index < count; index += 1) {
    const move = moves[index]
    const kindIndex = KIND_INDEX.get(move.kind)
    if (kindIndex === undefined) {
      // Refuse rather than substitute: a move kind this build cannot encode
      // would arrive as a different kind of motion, which is a wrong program.
      throw new Error(`packMoves: unknown move kind "${String(move.kind)}" at index ${index}`)
    }
    kinds[index] = kindIndex

    const offset = index * COORDS_PER_MOVE
    coords[offset] = move.from.x
    coords[offset + 1] = move.from.y
    coords[offset + 2] = move.from.z
    coords[offset + 3] = move.to.x
    coords[offset + 4] = move.to.y
    coords[offset + 5] = move.to.z

    if (move.feedScale !== undefined) {
      feedScaleIndices.push(index)
      feedScaleValues.push(move.feedScale)
    }
    if (move.source !== undefined) {
      sourceIndices.push(index)
      sourceValues.push(move.source)
    }
  }

  return {
    count,
    kinds,
    coords,
    feedScaleIndices: Uint32Array.from(feedScaleIndices),
    feedScaleValues: Float64Array.from(feedScaleValues),
    sourceIndices: Uint32Array.from(sourceIndices),
    sourceValues,
  }
}

export function unpackMoves(packed: PackedMoves): ToolpathMove[] {
  const { count, kinds, coords, feedScaleIndices, feedScaleValues, sourceIndices, sourceValues } = packed
  const moves: ToolpathMove[] = new Array<ToolpathMove>(count)

  // Sparse fields are walked with cursors rather than looked up per move, so
  // the hot loop stays a linear scan over the buffers.
  let feedCursor = 0
  let sourceCursor = 0

  for (let index = 0; index < count; index += 1) {
    const offset = index * COORDS_PER_MOVE
    const move: ToolpathMove = {
      kind: TRANSPORT_MOVE_KINDS[kinds[index]],
      from: { x: coords[offset], y: coords[offset + 1], z: coords[offset + 2] },
      to: { x: coords[offset + 3], y: coords[offset + 4], z: coords[offset + 5] },
    }
    // Assigned in declaration order (feedScale before source) so a reconstructed
    // move has the same key order as a generated one.
    if (feedCursor < feedScaleIndices.length && feedScaleIndices[feedCursor] === index) {
      move.feedScale = feedScaleValues[feedCursor]
      feedCursor += 1
    }
    if (sourceCursor < sourceIndices.length && sourceIndices[sourceCursor] === index) {
      move.source = sourceValues[sourceCursor]
      sourceCursor += 1
    }
    moves[index] = move
  }

  return moves
}

export function packResult(result: ToolpathResult): TransportedResult {
  const { moves, ...rest } = result
  // The rest of the envelope — warnings, bounds, drill cycles, step levels,
  // engagement telemetry — is small and irregular, so it keeps travelling by
  // structured clone. Only the moves are worth packing.
  return { ...rest, packedMoves: packMoves(moves) }
}

export function unpackResult(transported: TransportedResult): ToolpathResult {
  const { packedMoves, ...rest } = transported
  return { ...rest, moves: unpackMoves(packedMoves) }
}

/**
 * The buffers to hand to `postMessage`'s transfer list.
 *
 * Transferring **neuters** these on the sending side, which is why the worker
 * discards the result immediately after posting and never reads it again.
 */
export function transferablesOf(transported: TransportedResult): ArrayBuffer[] {
  const { packedMoves } = transported
  return [
    packedMoves.kinds.buffer as ArrayBuffer,
    packedMoves.coords.buffer as ArrayBuffer,
    packedMoves.feedScaleIndices.buffer as ArrayBuffer,
    packedMoves.feedScaleValues.buffer as ArrayBuffer,
    packedMoves.sourceIndices.buffer as ArrayBuffer,
  ]
}

/** Shape check for a packed payload arriving over the wire. */
export function isPackedMoves(value: unknown): value is PackedMoves {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<PackedMoves>
  return typeof candidate.count === 'number'
    && candidate.kinds instanceof Uint8Array
    && candidate.coords instanceof Float64Array
    && candidate.feedScaleIndices instanceof Uint32Array
    && candidate.feedScaleValues instanceof Float64Array
    && candidate.sourceIndices instanceof Uint32Array
    && Array.isArray(candidate.sourceValues)
    && candidate.coords.length === candidate.count * COORDS_PER_MOVE
    && candidate.kinds.length === candidate.count
}
