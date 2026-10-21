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
 * coordinates, subroutines, macros, and machine-coordinate `G53` moves, whose
 * endpoint is not a work position — #1054 fix 4) yields an explicit
 * `unsupported` status; a structural parse error yields `failed`. The parser
 * never reports `verified` for a partial or unsupported parse.
 */

import type { ToolpathPoint } from '../toolpaths/types'

export type ParsedMotionKind = 'rapid' | 'linear' | 'arc'

export interface ParsedLinearMove {
  kind: 'rapid' | 'linear'
  from: ToolpathPoint
  to: ToolpathPoint
  /**
   * Present when the block ran under inverse-time feed (`G93`, issue #393).
   * The value is the F word exactly as written — 1/min, not a speed — and it
   * must never be displayed or compared as one. Absent on a program with no
   * rotary word and no inverse-time command, so such a parse is exactly what
   * it always was.
   */
  inverseTimeFeed?: number
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
  /** See {@link ParsedLinearMove.inverseTimeFeed}. */
  inverseTimeFeed?: number
}

export type ParsedGcodeMove = ParsedLinearMove | ParsedArcMove

export type GcodeParseStatus = 'verified' | 'unsupported' | 'failed'

export interface ParsedGcodeMotion {
  moves: ParsedGcodeMove[]
  status: GcodeParseStatus
  warnings: string[]
}

/**
 * How to read a program that uses a rotary axis (issue #393). Absent means the
 * program has no rotary word and no inverse-time feed, and parses exactly as
 * it did before the rotary axis existed.
 */
export interface GcodeRotaryParseOptions {
  /**
   * The word that carries the angle — `rotaryWord(definition)`. On a borrowed
   * motor this letter is the angle and is NEVER a linear coordinate, so it is
   * not read as one even on a program that also writes it as a setting.
   */
  word: 'A' | 'X' | 'Y'
  /** The controller's inverse-time feed commands, or null when it has none. */
  inverseTimeFeed: { on: string; off: string } | null
}

interface ParseState {
  pos: ToolpathPoint
  /** Last seen motion mode, or null before the first motion word. */
  motionMode: 'rapid' | 'linear' | 'arc_cw' | 'arc_ccw' | null
  /** True while the definition's inverse-time command is in force (issue #393). */
  inverseTime: boolean
  /**
   * True when `pos.z` is still a work-coordinate Z the parse can prove. A
   * `G53` block moves in machine coordinates (#1054 fix 4), so after it the
   * work-frame Z is unknown until a later block states one. X/Y are left as
   * they were: the emitter's machine-coordinate retract is Z-only.
   */
  workZKnown: boolean
}

interface Word {
  letter: string
  value: number
}

const EPS = 1e-9

interface TokenizedLine {
  words: Word[]
  /**
   * Text that is not a G-code word. Reported rather than dropped: a block the
   * tokenizer cannot fully read may state a position, so the caller must not
   * keep calling the read-back verified (#1054 fix 5).
   */
  unparsed: string[]
}

/** Tokenise a line: strip comments + line numbers, then read its words. */
function tokenizeLine(
  line: string,
  commentPrefix: string,
  commentSuffix: string,
): TokenizedLine {
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

  // `%` is the program delimiter the UCCNC and Mach3 definitions write. A line
  // that is only that delimiter (optionally with its line number) is neither a
  // word nor unreadable text; a stray `%` inside a block stays unparsed.
  if (/^(?:N\d+\s*)?%$/.test(s)) return { words: [], unparsed: [] }

  const words: Word[] = []
  const unparsed: string[] = []
  if (s.length === 0) return { words, unparsed }

  // A word is a letter immediately followed by its numeric value — the way a
  // controller reads a block, with whitespace only separating words. Splitting
  // on whitespace silently dropped a compact block like `G53G0Z0`: the whole
  // machine-coordinate retract vanished and the read-back stayed "verified"
  // (#1054 fix 5). `X1.5Y-2` and `G90G49` are read the same way.
  const pattern = /[A-Za-z][+-]?(?:\d+(?:\.\d*)?|\.\d+)/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(s)) !== null) {
    const gap = s.slice(lastIndex, match.index).trim()
    if (gap.length > 0) unparsed.push(gap)
    const letter = match[0][0].toUpperCase()
    const value = Number(match[0].slice(1))
    if (!Number.isFinite(value)) {
      // A numerically absurd word is unreadable, not a coordinate.
      unparsed.push(match[0])
      lastIndex = pattern.lastIndex
      continue
    }
    // `N` is a line number, not a command: it is a word, so it is read and then
    // ignored rather than reported as unreadable text.
    if (letter !== 'N') words.push({ letter, value })
    lastIndex = pattern.lastIndex
  }
  const tail = s.slice(lastIndex).trim()
  if (tail.length > 0) unparsed.push(tail)
  return { words, unparsed }
}

/** Classify a G-word for plan-view parsing. Motion words (G0-G3) drive a move;
 *  a small set of motion constructs we cannot flatten (canned cycles, incremental
 *  coordinates, non-XY arc planes) are `unsupported`; `G53` is a machine-
 *  coordinate move, which this parser tracks separately so it is never read as
 *  a work position (#1054 fix 4); every other G-word is a non-motion setting
 *  (units, WCS, tool-length/cutter compensation, home, feed/spindle modes,
 *  dwell, …) that is skipped without affecting the trace. Skipping a setting
 *  cannot corrupt the motion trace; any genuinely missing motion is caught by
 *  the segment-count diagnostic. */
function motionModeForG(gValue: number): 'rapid' | 'linear' | 'arc_cw' | 'arc_ccw' | 'machine' | 'non-motion' | 'unsupported' {
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
    // A machine-coordinate move: the words name the machine's own position, not
    // the work frame, so the block cannot be added to the work-frame trace and
    // the work Z afterwards is unknown (#1054 fix 4).
    case 53:
      return 'machine'
    default:
      // G20/G21 (units), G90 (absolute), G17 (XY plane), G54-59 (WCS),
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
  return arcMoveFromCenter(from, to, center, radius, clockwise)
}

/** A parsed arc from its resolved centre; shared by every dialect's parser. */
export function arcMoveFromCenter(
  from: ToolpathPoint,
  to: ToolpathPoint,
  center: { x: number; y: number },
  radius: number,
  clockwise: boolean,
): ParsedArcMove {
  const sweep = directedSweep(from, to, center, clockwise)
  const largeArc = Math.abs(sweep) > Math.PI + EPS
  return { kind: 'arc', from, to, center, radius, clockwise, largeArc }
}

/** The letter and value of a definition command like `G93`, or null when it is not one. */
function commandWord(command: string): { letter: string; value: number } | null {
  const match = /^([A-Za-z])\s*(\d+(?:\.\d+)?)$/.exec(command.trim())
  return match ? { letter: match[1].toUpperCase(), value: Number(match[2]) } : null
}

/**
 * Parse a literal G-code program into a planar motion sequence.
 *
 * @param gcode           The full G-code text (as written to the `.nc` file).
 * @param arcFormat       The machine's arc centre format ('ij' or 'r'); used
 *                        only for documentation — both are accepted when present.
 * @param commentPrefix   Definition comment prefix (e.g. '(' or ';').
 * @param commentSuffix   Definition comment suffix (e.g. ')' or '').
 * @param rotary          How the program spells a rotary axis (issue #393).
 *                        Absent means it has none and parses as it always did.
 */
export function parseGcodeMotion(
  gcode: string,
  arcFormat: 'ij' | 'r' = 'ij',
  commentPrefix: string = '(',
  commentSuffix: string = ')',
  rotary?: GcodeRotaryParseOptions,
): ParsedGcodeMotion {
  void arcFormat   // both forms are accepted regardless of the configured format
  const moves: ParsedGcodeMove[] = []
  const warnings: string[] = []
  let status: GcodeParseStatus = 'verified'

  const inverseOn = rotary?.inverseTimeFeed ? commandWord(rotary.inverseTimeFeed.on) : null
  const inverseOff = rotary?.inverseTimeFeed ? commandWord(rotary.inverseTimeFeed.off) : null

  const state: ParseState = {
    pos: { x: 0, y: 0, z: 0 },
    motionMode: null,
    inverseTime: false,
    workZKnown: true,
  }

  const lines = gcode.split(/\r?\n/)
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const { words, unparsed } = tokenizeLine(lines[lineIndex], commentPrefix, commentSuffix)
    // Text the tokenizer cannot read is never silently dropped (#1054 fix 5).
    // The block may state a position, so the whole read-back is downgraded —
    // even when the words it did read are enough to draw a segment.
    if (unparsed.length > 0) {
      if (status === 'verified') status = 'unsupported'
      warnings.push(
        `line ${lineIndex + 1}: unparsed G-code text ${unparsed.map((text) => `"${text}"`).join(', ')}; the block is not fully understood`,
      )
    }
    if (words.length === 0) continue

    // Resolve the motion mode for this line: an explicit G0/G1/G2/G3 wins;
    // otherwise the line is modal and continues the last mode.
    let explicitMode: 'rapid' | 'linear' | 'arc_cw' | 'arc_ccw' | 'machine' | 'non-motion' | 'unsupported' | null = null
    let iWord: number | undefined
    let jWord: number | undefined
    let rWord: number | undefined
    let x: number | undefined
    let y: number | undefined
    let z: number | undefined
    let feedWord: number | undefined
    let angleWord: number | undefined
    // The definition's own inverse-time commands, applied after the line's
    // words are read so G93/G94 and an F on the same block both take effect.
    let inverseSwitch: boolean | null = null
    // A G53 anywhere on the line makes the block a machine-coordinate move,
    // whatever motion word shares it (#1054 fix 4).
    let machineCoordinate = false
    // The block's own motion word, if it has one. G53 is non-modal, so a
    // `G53 G0` block still leaves G0 in force for the following blocks.
    let lineMotion: 'rapid' | 'linear' | 'arc_cw' | 'arc_ccw' | null = null

    for (const word of words) {
      // The definition's own inverse-time commands may be any letter; they are
      // matched by letter and value, not assumed to be G words.
      if (inverseOn !== null && word.letter === inverseOn.letter && word.value === inverseOn.value) inverseSwitch = true
      else if (inverseOff !== null && word.letter === inverseOff.letter && word.value === inverseOff.value) inverseSwitch = false
      switch (word.letter) {
        case 'G':
          if (word.value === 53) machineCoordinate = true
          explicitMode = motionModeForG(word.value)
          if (explicitMode === 'rapid' || explicitMode === 'linear'
            || explicitMode === 'arc_cw' || explicitMode === 'arc_ccw') {
            lineMotion = explicitMode
          }
          break
        case 'I': iWord = word.value; break
        case 'J': jWord = word.value; break
        case 'R': rWord = word.value; break
        // The rotary word (issue #393) is the angle. On a borrowed motor it is
        // the letter of the axis whose motor drives the rotation — that letter
        // carries the angle and is never a linear coordinate.
        case 'A':
          if (rotary?.word === 'A') angleWord = word.value
          break
        case 'X':
          if (rotary?.word === 'X') angleWord = word.value
          else x = word.value
          break
        case 'Y':
          if (rotary?.word === 'Y') angleWord = word.value
          else y = word.value
          break
        case 'Z': z = word.value; break
        case 'F': feedWord = word.value; break
        // S (spindle), T (tool), M-codes, P/Q (canned-cycle words), and any
        // other letter are non-positional and ignored for the trace.
        default: break
      }
    }

    // Feed mode (issue #393): G93/G94 are modal, but the inverse-time F is not.
    // It belongs to the block that writes it — a controller in inverse-time mode
    // needs an F on every feed block, so carrying the previous one forward would
    // report a program the machine stops on.
    if (inverseSwitch === true) {
      state.inverseTime = true
    } else if (inverseSwitch === false) {
      state.inverseTime = false
    }
    const inverseTimeFeed = state.inverseTime && feedWord !== undefined && feedWord > 0
      ? feedWord
      : undefined

    // A G53 block moves in machine coordinates (#1054 fix 4). Its words are not
    // a work-frame position, so the block is not added to the trace and its Z is
    // never taken as the tracked work Z — that is exactly how the retract used
    // to reappear as a work "Z0". The work Z is unknown until a later block
    // states one, and the parse can no longer be called verified: the block is
    // a construct this viewer cannot place in the work frame.
    if (machineCoordinate || explicitMode === 'machine') {
      if (status === 'verified') status = 'unsupported'
      warnings.push(`line ${lineIndex + 1}: G53 machine-coordinate move; the work-frame Z afterwards is unknown`)
      if (lineMotion !== null) state.motionMode = lineMotion
      state.workZKnown = false
      continue
    }

    if (explicitMode === 'unsupported') {
      if (status === 'verified') status = 'unsupported'
      warnings.push(`line ${lineIndex + 1}: unsupported G-code construct (G${words.find(w => w.letter === 'G')?.value})`)
      // An unsupported construct may have left modal state ambiguous; reset it
      // so a later modal line is not silently continued from it.
      state.motionMode = null
      continue
    }

    // No coordinate, arc or angle words and no explicit motion → non-motion line.
    const hasPosition = x !== undefined || y !== undefined || z !== undefined || angleWord !== undefined
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

    // A feed move in inverse-time mode must carry its own positive F (issue
    // #393). "Verified" means the trace matches what a controller would run, and
    // a controller rejects this block — so it is reported the same way as any
    // other construct the parser cannot reconstruct, not as verified.
    if (state.inverseTime && mode !== 'rapid' && inverseTimeFeed === undefined) {
      if (status === 'verified') status = 'unsupported'
      warnings.push(`line ${lineIndex + 1}: feed move in inverse-time mode without its own F word`)
    }

    // A modal move after a G53 retract inherits no provable work Z (#1054 fix
    // 4): the retract moved the machine, not the work frame, so the block's
    // tracked Z would be a number the program does not state. The move is still
    // emitted so the plan view keeps its continuity, but the parse is not
    // verified and the unproven Z is reported.
    if (z === undefined && !state.workZKnown) {
      if (status === 'verified') status = 'unsupported'
      warnings.push(`line ${lineIndex + 1}: move after a G53 block does not state Z; the work-frame Z is unknown`)
    }

    const from = { ...state.pos }
    const to: ToolpathPoint = {
      x: x ?? state.pos.x,
      y: y ?? state.pos.y,
      z: z ?? state.pos.z,
    }
    // The angle is modal like the other axes: an omitted word keeps the last
    // one, and a program that never writes one carries no `a` at all.
    const angle = angleWord ?? state.pos.a
    if (angle !== undefined) to.a = angle
    const feedFields = inverseTimeFeed !== undefined ? { inverseTimeFeed } : null

    try {
      if (mode === 'rapid' || mode === 'linear') {
        moves.push({ kind: mode, from, to, ...feedFields })
      } else {
        const clockwise = mode === 'arc_cw'
        const result = applyArc(state, to, iWord, jWord, rWord, clockwise)
        if ('error' in result) {
          if (status === 'verified') status = 'unsupported'
          warnings.push(`line ${lineIndex + 1}: ${result.error}`)
          // Fall back to a linear segment so the trace stays continuous, but
          // the status downgrade guarantees the diagnostic is not "verified".
          moves.push({ kind: 'linear', from, to, ...feedFields })
        } else {
          moves.push({ ...result, ...feedFields })
        }
      }
    } catch {
      status = 'failed'
      warnings.push(`line ${lineIndex + 1}: parse failure`)
    }

    state.pos = to
    // A block that states Z re-establishes the work frame, whatever a previous
    // machine-coordinate move did.
    if (z !== undefined) state.workZKnown = true
  }

  return { moves, status, warnings }
}
