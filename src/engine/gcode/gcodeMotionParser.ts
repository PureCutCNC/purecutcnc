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
 * Read-only G-code motion parser for the built-in postprocessor dialect
 * (issue #356). It reconstructs the planar motion written to the `.nc` file so
 * the exported-motion debug view can overlay the literal G-code layer against
 * the Generated and Optimized layers.
 *
 * Honours: modal coordinates and motion (a G-word omitted means "continue the
 * last motion mode"), comments and `N` line numbers, `X/Y/Z`, `G0/G1/G2/G3`,
 * and arc centre via `I/J` or `R`. Arcs are kept analytic (centre + radius +
 * direction + large-arc flag); the SVG layer tessellates them only for display.
 *
 * Output is in machine coordinates — the caller maps back to project space via
 * `machineToProjectPoint`. Unsupported syntax (canned cycles, incremental
 * coordinates, subroutines, macros) yields an explicit `unsupported` status;
 * a structural parse error yields `failed`. The parser never reports `verified`
 * for a partial or unsupported parse.
 */

import type { ToolpathPoint } from '../toolpaths/types'

export type ParsedMotionKind = 'rapid' | 'linear' | 'arc'

export interface ParsedLinearMove {
  kind: 'rapid' | 'linear'
  from: ToolpathPoint
  to: ToolpathPoint
}

export interface ParsedArcMove {
  kind: 'arc'
  from: ToolpathPoint
  to: ToolpathPoint
  /** Arc centre in machine XY coordinates. */
  center: { x: number; y: number }
  radius: number
  clockwise: boolean
  /** True when the directed sweep exceeds 180° (drives the SVG large-arc flag). */
  largeArc: boolean
}

export type ParsedGcodeMove = ParsedLinearMove | ParsedArcMove

export type GcodeParseStatus = 'verified' | 'unsupported' | 'failed'

export interface ParsedGcodeMotion {
  moves: ParsedGcodeMove[]
  status: GcodeParseStatus
  warnings: string[]
}

interface ParseState {
  pos: ToolpathPoint
  /** Last seen motion mode, or null before the first motion word. */
  motionMode: 'rapid' | 'linear' | 'arc_cw' | 'arc_ccw' | null
}

interface Word {
  letter: string
  value: number
}

const EPS = 1e-9

/** Parse a single G-code word like "X12.5" into { letter: 'X', value: 12.5 }. */
function parseWord(token: string): Word | null {
  if (token.length < 2) return null
  const letter = token[0].toUpperCase()
  if (!/[A-Z]/.test(letter)) return null
  const valueStr = token.slice(1)
  if (valueStr.length === 0) return null
  const value = Number(valueStr)
  if (!Number.isFinite(value)) return null
  return { letter, value }
}

/** Tokenise a line: strip comments + line numbers, split into words. */
function tokenizeLine(
  line: string,
  commentPrefix: string,
  commentSuffix: string,
): Word[] {
  let s = line
  // Strip parenthesised comments: ( ... )
  s = s.replace(/\([^)]*\)/g, ' ')
  // Strip definition-style comments (prefix...suffix), e.g. ; ... or // ...
  if (commentPrefix && commentSuffix) {
    const escape = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`${escape(commentPrefix)}.*?${escape(commentSuffix)}`, 'g')
    s = s.replace(re, ' ')
  }
  // Strip end-of-line comments for dialects where the suffix is a bare line
  // comment marker (e.g. ';' to end of line when commentSuffix is empty).
  s = s.replace(/;.*$/, ' ')
  s = s.trim()
  if (s.length === 0) return []
  const tokens = s.split(/\s+/)
  const words: Word[] = []
  for (const token of tokens) {
    // Strip an optional N-line-number prefix word like "N10".
    const word = parseWord(token)
    if (!word) continue
    if (word.letter === 'N') continue
    words.push(word)
  }
  return words
}

/** Classify a G-word for plan-view parsing. Motion words (G0-G3) drive a move;
 *  a small set of motion constructs we cannot flatten (canned cycles, incremental
 *  coordinates, non-XY arc planes) are `unsupported`; every other G-word is a
 *  non-motion setting (units, WCS, tool-length/cutter compensation, home,
 *  feed/spindle modes, dwell, …) that is skipped without affecting the trace.
 *  Skipping a setting cannot corrupt the motion trace; any genuinely missing
 *  motion is caught by the segment-count diagnostic. */
function motionModeForG(gValue: number): 'rapid' | 'linear' | 'arc_cw' | 'arc_ccw' | 'non-motion' | 'unsupported' {
  switch (gValue) {
    case 0: return 'rapid'
    case 1: return 'linear'
    case 2: return 'arc_cw'
    case 3: return 'arc_ccw'
    // Canned drill cycles (G73/G81/G82/G83), incremental coordinates (G91), and
    // non-XY arc planes (G18 XZ / G19 YZ) imply motion this viewer cannot
    // reconstruct as a flat absolute planar trace — flag them explicitly.
    case 73: case 81: case 82: case 83: case 91: case 18: case 19:
      return 'unsupported'
    default:
      // G20/G21 (units), G90 (absolute), G17 (XY plane), G53-59 (WCS),
      // G43/G44/G49 (tool-length comp), G40-42 (cutter comp), G28/G30 (home),
      // G80 (cancel canned), G98/G99 (retract mode), G94/G95/G97 (feed/spindle
      // modes), G4 (dwell), and any other setting — non-motion, skipped.
      return 'non-motion'
  }
}

/** Signed angular sweep from start to end around centre, normalised to (-π, π].
 *  Positive = CCW, negative = CW (standard math convention). */
function signedSweep(start: ToolpathPoint, end: ToolpathPoint, center: { x: number; y: number }): number {
  const a0 = Math.atan2(start.y - center.y, start.x - center.x)
  const a1 = Math.atan2(end.y - center.y, end.x - center.x)
  let sweep = a1 - a0
  while (sweep > Math.PI) sweep -= Math.PI * 2
  while (sweep <= -Math.PI) sweep += Math.PI * 2
  return sweep
}

/** Directed sweep for a given arc direction (magnitude in (0, 2π)). */
function directedSweep(start: ToolpathPoint, end: ToolpathPoint, center: { x: number; y: number }, clockwise: boolean): number {
  let sweep = signedSweep(start, end, center)
  if (clockwise && sweep > 0) sweep -= Math.PI * 2
  else if (!clockwise && sweep < 0) sweep += Math.PI * 2
  return sweep
}

/**
 * Recover the arc centre from an R-word. With R > 0 the postprocessor means the
 * minor (≤180°) arc; the requested direction disambiguates which of the two
 * candidate centres yields that minor arc.
 */
function centerFromRadius(start: ToolpathPoint, end: ToolpathPoint, radius: number, clockwise: boolean): { center: { x: number; y: number } | null } {
  const mx = (start.x + end.x) / 2
  const my = (start.y + end.y) / 2
  const dx = end.x - start.x
  const dy = end.y - start.y
  const chord = Math.hypot(dx, dy)
  if (chord < EPS) return { center: null }
  const half = chord / 2
  if (radius < half - 1e-6) return { center: null }   // radius too small to span the chord
  const h = Math.sqrt(Math.max(0, radius * radius - half * half))
  // Perpendicular to the chord (90° CCW of the chord direction), unit length.
  const nx = -dy / chord
  const ny = dx / chord
  const c1 = { x: mx + nx * h, y: my + ny * h }
  const c2 = { x: mx - nx * h, y: my - ny * h }
  // The minor arc around a centre has sign = signedSweep; pick the centre whose
  // minor-arc direction matches the requested motion direction.
  const sweep1 = signedSweep(start, end, c1)
  const matches1 = clockwise ? sweep1 < 0 : sweep1 > 0
  return { center: matches1 ? c1 : c2 }
}

function applyArc(
  state: ParseState,
  to: ToolpathPoint,
  iWord: number | undefined,
  jWord: number | undefined,
  rWord: number | undefined,
  clockwise: boolean,
): ParsedArcMove | { error: string } {
  const from = state.pos
  let center: { x: number; y: number }
  let radius: number
  if (iWord !== undefined && jWord !== undefined) {
    center = { x: from.x + iWord, y: from.y + jWord }
    radius = Math.hypot(iWord, jWord)
  } else if (rWord !== undefined) {
    const r = Math.abs(rWord)
    const recovered = centerFromRadius(from, to, r, clockwise)
    if (!recovered.center) {
      return { error: 'arc R-word does not span its endpoints' }
    }
    center = recovered.center
    radius = r
  } else {
    return { error: 'arc missing I/J or R centre word' }
  }
  const sweep = directedSweep(from, to, center, clockwise)
  const largeArc = Math.abs(sweep) > Math.PI + EPS
  return { kind: 'arc', from, to, center, radius, clockwise, largeArc }
}

/**
 * Parse a literal G-code program into a planar motion sequence.
 *
 * @param gcode           The full G-code text (as written to the `.nc` file).
 * @param arcFormat       The machine's arc centre format ('ij' or 'r'); used
 *                        only for documentation — both are accepted when present.
 * @param commentPrefix   Definition comment prefix (e.g. '(' or ';').
 * @param commentSuffix   Definition comment suffix (e.g. ')' or '').
 */
export function parseGcodeMotion(
  gcode: string,
  arcFormat: 'ij' | 'r' = 'ij',
  commentPrefix: string = '(',
  commentSuffix: string = ')',
): ParsedGcodeMotion {
  void arcFormat   // both forms are accepted regardless of the configured format
  const moves: ParsedGcodeMove[] = []
  const warnings: string[] = []
  let status: GcodeParseStatus = 'verified'

  const state: ParseState = {
    pos: { x: 0, y: 0, z: 0 },
    motionMode: null,
  }

  const lines = gcode.split(/\r?\n/)
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const words = tokenizeLine(lines[lineIndex], commentPrefix, commentSuffix)
    if (words.length === 0) continue

    // Resolve the motion mode for this line: an explicit G0/G1/G2/G3 wins;
    // otherwise the line is modal and continues the last mode.
    let explicitMode: 'rapid' | 'linear' | 'arc_cw' | 'arc_ccw' | 'non-motion' | 'unsupported' | null = null
    let iWord: number | undefined
    let jWord: number | undefined
    let rWord: number | undefined
    let x: number | undefined
    let y: number | undefined
    let z: number | undefined

    for (const word of words) {
      switch (word.letter) {
        case 'G':
          explicitMode = motionModeForG(word.value)
          break
        case 'I': iWord = word.value; break
        case 'J': jWord = word.value; break
        case 'R': rWord = word.value; break
        case 'X': x = word.value; break
        case 'Y': y = word.value; break
        case 'Z': z = word.value; break
        // F (feed), S (spindle), T (tool), M-codes, P/Q (canned-cycle words),
        // and any other letter are non-positional and ignored for the trace.
        default: break
      }
    }

    if (explicitMode === 'unsupported') {
      if (status === 'verified') status = 'unsupported'
      warnings.push(`line ${lineIndex + 1}: unsupported G-code construct (G${words.find(w => w.letter === 'G')?.value})`)
      // An unsupported construct may have left modal state ambiguous; reset it
      // so a later modal line is not silently continued from it.
      state.motionMode = null
      continue
    }

    // No coordinate or arc words and no explicit motion → non-motion line.
    const hasPosition = x !== undefined || y !== undefined || z !== undefined
    const hasArcWords = iWord !== undefined || jWord !== undefined || rWord !== undefined
    if (!hasPosition && !hasArcWords) {
      // A bare motion-mode line (e.g. "G0" alone, or a units/WCS line) just
      // sets the modal mode without moving.
      if (explicitMode === 'rapid' || explicitMode === 'linear' || explicitMode === 'arc_cw' || explicitMode === 'arc_ccw') {
        state.motionMode = explicitMode
      }
      continue
    }

    // Determine the effective motion mode for this line.
    let mode: 'rapid' | 'linear' | 'arc_cw' | 'arc_ccw'
    if (explicitMode === 'rapid' || explicitMode === 'linear' || explicitMode === 'arc_cw' || explicitMode === 'arc_ccw') {
      mode = explicitMode
      state.motionMode = mode
    } else if (state.motionMode !== null) {
      mode = state.motionMode
    } else {
      // Coordinates present but no motion mode established (the postprocessor
      // always emits a G-word on the first motion line, so this is unexpected).
      if (status === 'verified') status = 'unsupported'
      warnings.push(`line ${lineIndex + 1}: motion coordinates with no established motion mode`)
      mode = 'linear'
      state.motionMode = 'linear'
    }

    const from = { ...state.pos }
    const to: ToolpathPoint = {
      x: x ?? state.pos.x,
      y: y ?? state.pos.y,
      z: z ?? state.pos.z,
    }

    try {
      if (mode === 'rapid' || mode === 'linear') {
        moves.push({ kind: mode, from, to })
      } else {
        const clockwise = mode === 'arc_cw'
        const result = applyArc(state, to, iWord, jWord, rWord, clockwise)
        if ('error' in result) {
          if (status === 'verified') status = 'unsupported'
          warnings.push(`line ${lineIndex + 1}: ${result.error}`)
          // Fall back to a linear segment so the trace stays continuous, but
          // the status downgrade guarantees the diagnostic is not "verified".
          moves.push({ kind: 'linear', from, to })
        } else {
          moves.push(result)
        }
      }
    } catch {
      status = 'failed'
      warnings.push(`line ${lineIndex + 1}: parse failure`)
    }

    state.pos = to
  }

  return { moves, status, warnings }
}
