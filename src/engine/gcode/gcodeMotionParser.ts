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
 * (issue #356). It reconstructs the motion written to the `.nc` file so the
 * exported-motion debug view can overlay the literal G-code layer against the
 * Generated and Optimized layers, and so the exported program can be checked
 * against the internal toolpath (`exportedMotion.ts`, `exportParity.ts`,
 * issue #1261).
 *
 * Honours: modal coordinates and motion (a G-word omitted means "continue the
 * last motion mode"), comments and `N` line numbers, `X/Y/Z`, `G0/G1/G2/G3`,
 * arc centre via `I/J` or `R`, the modal feed `F` (kept on every feed move),
 * and `G20`/`G21`. Arcs are kept analytic (centre + radius + direction +
 * large-arc flag); callers tessellate them.
 *
 * Canned drill cycles (issue #1261) are expanded into the moves the controller
 * makes when the caller passes the definition's `cannedCycles` block: G81
 * (drill), G82 (drill with dwell), G83 (peck) and G73 (chip break), with the
 * G98/G99 retract plane, the `R`, `Q` and `P` words, modal repeats at a new
 * X/Y and the cancel command. They follow LinuxCNC's documented sequence. The
 * peck re-entry and G73's in-hole retract are controller details that do not
 * change the cut, so G73 is marked approximate (`chipBreakRetractApproximate`).
 * Without the block a canned cycle stays `unsupported`.
 *
 * A Z-only `G53` rapid (the grblHAL footer, the bar-clearance retract of
 * #1054) is a machine-coordinate retract: it is not a work position, so it is
 * not added to the trace and the work Z is unknown afterwards, but it does not
 * make the program unsupported. A rapid that follows it without stating Z is
 * kept at the last known work Z and flagged `workZUnknown`; a *feed* move that
 * does so still downgrades the parse, because it would cut at a height the
 * program does not state (#1054 fix 4).
 *
 * Output is in machine coordinates — the caller maps back to project space via
 * `machineToProjectPoint`. Unsupported syntax (incremental coordinates,
 * subroutines, macros, a `G53` that moves X or Y) yields an explicit
 * `unsupported` status; a structural parse error yields `failed`. The parser
 * never reports `verified` for a partial or unsupported parse.
 *
 * Every finding is reported twice: as an English `warnings` line for the
 * developer debug view, and as a structured `notes` entry (a code, its line,
 * its severity) that product code translates.
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
  /**
   * The ordinary feed the block ran at, in program units per minute: the modal
   * `F` in force (issue #1261). Present on feed moves outside inverse-time
   * mode once the program has stated an F; never on a rapid.
   */
  feed?: number
  /**
   * True on a rapid that follows a `G53` retract without stating Z (issue
   * #1261): the tool is at the machine's retract height, which the program
   * does not give in work coordinates, so `z` is the last known work Z.
   */
  workZUnknown?: boolean
  /**
   * Present once the program has probed a surface and set its Z (a plasma
   * touch-off, issue #1261): Z is measured from that surface, which was set to
   * this value. The reader maps it back with the surface's own height.
   */
  touchOffZ?: number
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
  /** See {@link ParsedLinearMove.feed}. */
  feed?: number
  /** See {@link ParsedLinearMove.touchOffZ}. */
  touchOffZ?: number
}

export type ParsedGcodeMove = ParsedLinearMove | ParsedArcMove

export type GcodeParseStatus = 'verified' | 'unsupported' | 'failed'

/**
 * What a parse found, as data (issue #1261). `severity` says what it did to
 * the status: `info` leaves it alone, `unsupported` and `failed` downgrade it.
 * The codes are stable; product code translates them, never the English
 * `warnings` text.
 */
export type GcodeParseNoteCode =
  /** Text that is not a G-code word. */
  | 'unparsedText'
  /** A G-word whose motion this parser does not reconstruct (`command`). */
  | 'unsupportedCommand'
  /** A Z-only `G53` rapid: a machine-coordinate retract. */
  | 'machineCoordinateRetract'
  /** A `G53` block that moves X/Y, or has no rapid: not a retract. */
  | 'machineCoordinateMove'
  /** A rapid after a `G53` retract that does not state Z. */
  | 'rapidAfterMachineRetract'
  /** A feed move after a `G53` retract that does not state Z. */
  | 'workZUnknown'
  /** Coordinates before any motion mode was set. */
  | 'motionWithoutMode'
  /** A feed move in inverse-time mode without its own F. */
  | 'inverseTimeFeedMissing'
  /** An arc with no I/J or R word. */
  | 'arcCentreMissing'
  /** An arc whose R cannot span its endpoints. */
  | 'arcRadiusTooSmall'
  /** A canned cycle without the Z, R or (peck) Q it needs. */
  | 'cannedCycleIncomplete'
  /** A canned cycle on a block that also turns the rotary axis. */
  | 'cannedCycleWithRotary'
  /** No G98/G99 in the program before a cycle: G98 was assumed. */
  | 'cannedRetractModeAssumed'
  /** G73's in-hole retract is controller-specific and modelled approximately. */
  | 'chipBreakRetractApproximate'
  /** A probe move (`G38.2`–`G38.5`): it stops where it touches, so Z is unknown until a touch-off. */
  | 'probeMove'
  /** `G10 L20`/`G92` setting Z after a probe: Z is measured from the probed surface from here on. */
  | 'touchOffZ'
  /** `G10 L20`/`G92` setting only the rotary word: the angle restarts there, the bar does not move. */
  | 'rotaryZeroed'
  /** Any other work-offset change (`G10`, `G92` with axis words). */
  | 'workOffsetChange'
  /** An internal failure reading a block. */
  | 'parseFailure'
  /** A ShopBot statement or parameter set the ShopBot parser does not read. */
  | 'unsupportedStatement'

export interface GcodeParseNote {
  code: GcodeParseNoteCode
  /** One-based program line. */
  line: number
  severity: 'info' | 'unsupported' | 'failed'
  /** The command the note is about, as written (e.g. `G91`), when there is one. */
  command?: string
}

export interface ParsedGcodeMotion {
  moves: ParsedGcodeMove[]
  status: GcodeParseStatus
  /** English, for the developer debug view only. Product code reads `notes`. */
  warnings: string[]
  /**
   * The same findings as structured codes (issue #1261). Optional so a
   * hand-built parse result stays valid; both bundled parsers always set it.
   */
  notes?: GcodeParseNote[]
  /**
   * Which machine linear axes any motion block states (issue #1261). An axis
   * the program never states is wherever the controller already was — a
   * borrowed rotary motor's letter, or a cross axis held by touch-off (#1156)
   * — so a reader must not take the parser's starting 0 for it.
   */
  statedAxes?: { x: boolean; y: boolean; z: boolean }
}

/**
 * The controller's canned drill cycles, as the definition spells them (issue
 * #1261) — `definition.cannedCycles`. A null command is a cycle this machine
 * does not have, and is read as unsupported if a program writes it anyway.
 */
export interface GcodeCannedCycleParseOptions {
  drillCommand: string | null
  drillWithDwellCommand: string | null
  peckDrillCommand: string | null
  chipBreakDrillCommand: string | null
  peckStepWord: string
  cancelCommand: string
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

type MotionMode = 'rapid' | 'linear' | 'arc_cw' | 'arc_ccw' | 'canned'

type CannedKind = 'simple' | 'dwell' | 'peck' | 'chip_breaking'

/** The modal words of a run of canned cycles (issue #1261). */
interface CannedState {
  kind: CannedKind
  command: string
  /** The bottom Z, modal across the run. */
  z: number | undefined
  /** The retract plane, modal across the run. */
  r: number | undefined
  /** The peck step, modal across the run. */
  q: number | undefined
  /** The work Z when the run began — G98's return height. */
  initialZ: number
}

interface ParseState {
  pos: ToolpathPoint
  /** Last seen motion mode, or null before the first motion word. */
  motionMode: MotionMode | null
  /** True while the definition's inverse-time command is in force (issue #393). */
  inverseTime: boolean
  /**
   * True when `pos.z` is still a work-coordinate Z the parse can prove. A
   * `G53` block moves in machine coordinates (#1054 fix 4), so after it the
   * work-frame Z is unknown until a later block states one. X/Y are left as
   * they were: the emitter's machine-coordinate retract is Z-only.
   */
  workZKnown: boolean
  /** The modal ordinary feed (issue #1261); cleared by inverse-time mode. */
  feed: number | undefined
  /** G20/G21; millimetres until the program says otherwise. */
  units: 'mm' | 'inch'
  /** G98/G99, or null while the program has stated neither. */
  retractMode: 'G98' | 'G99' | null
  /** The canned-cycle run in force, or null. */
  canned: CannedState | null
  /** True after a probe move, until its touch-off sets Z. */
  probed: boolean
  /** The Z the probed surface was set to, once a touch-off has run. */
  touchOffZ: number | undefined
  /** Physical angle minus written angle, after a rotary zero (`G92 A0`). */
  angleOffset: number
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
 *  a small set of motion constructs we cannot flatten (canned cycles the caller
 *  gave no definition for, incremental coordinates, non-XY arc planes) are
 *  `unsupported`; `G53` is a machine-coordinate move, which this parser tracks
 *  separately so it is never read as a work position (#1054 fix 4); every other
 *  G-word is a non-motion setting (units, WCS, tool-length/cutter compensation,
 *  home, feed/spindle modes, dwell, …) that is skipped without affecting the
 *  trace. Skipping a setting cannot corrupt the motion trace; any genuinely
 *  missing motion is caught by the segment-count diagnostic. */
function motionModeForG(gValue: number): 'rapid' | 'linear' | 'arc_cw' | 'arc_ccw' | 'machine' | 'non-motion' | 'unsupported' {
  switch (gValue) {
    case 0: return 'rapid'
    case 1: return 'linear'
    case 2: return 'arc_cw'
    case 3: return 'arc_ccw'
    // Canned drill cycles (G73/G81/G82/G83) without the definition's cycle
    // block, incremental coordinates (G91), and non-XY arc planes (G18 XZ /
    // G19 YZ) imply motion this parser cannot reconstruct — flag them.
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
 * LinuxCNC's peck clearance: how far above the last depth a G83 re-entry stops,
 * and how far G73 backs off between pecks (0.010 in). Controllers differ here;
 * the cut — the feed down the hole axis — does not.
 */
const PECK_CLEARANCE = { mm: 0.254, inch: 0.01 } as const

/** Which canned cycle a G-word is, under the definition's own commands. */
function cannedKindFor(
  word: Word,
  canned: GcodeCannedCycleParseOptions,
): { kind: CannedKind; command: string } | null {
  const entries: Array<[string | null, CannedKind]> = [
    [canned.drillCommand, 'simple'],
    [canned.drillWithDwellCommand, 'dwell'],
    [canned.peckDrillCommand, 'peck'],
    [canned.chipBreakDrillCommand, 'chip_breaking'],
  ]
  for (const [command, kind] of entries) {
    if (command === null) continue
    const parsed = commandWord(command)
    if (parsed !== null && parsed.letter === word.letter && parsed.value === word.value) {
      return { kind, command: command.trim() }
    }
  }
  return null
}

/**
 * Parse a literal G-code program into a motion sequence.
 *
 * @param gcode           The full G-code text (as written to the `.nc` file).
 * @param arcFormat       The machine's arc centre format ('ij' or 'r'); used
 *                        only for documentation — both are accepted when present.
 * @param commentPrefix   Definition comment prefix (e.g. '(' or ';').
 * @param commentSuffix   Definition comment suffix (e.g. ')' or '').
 * @param rotary          How the program spells a rotary axis (issue #393).
 *                        Absent means it has none and parses as it always did.
 * @param cannedCycles    The definition's canned cycles (issue #1261). Absent
 *                        or null, a canned cycle is `unsupported`.
 */
export function parseGcodeMotion(
  gcode: string,
  arcFormat: 'ij' | 'r' = 'ij',
  commentPrefix: string = '(',
  commentSuffix: string = ')',
  rotary?: GcodeRotaryParseOptions,
  cannedCycles?: GcodeCannedCycleParseOptions | null,
): ParsedGcodeMotion {
  void arcFormat   // both forms are accepted regardless of the configured format
  const moves: ParsedGcodeMove[] = []
  const warnings: string[] = []
  const notes: GcodeParseNote[] = []
  const statedAxes = { x: false, y: false, z: false }
  let status: GcodeParseStatus = 'verified'

  const note = (
    line: number,
    code: GcodeParseNoteCode,
    severity: GcodeParseNote['severity'],
    message: string,
    command?: string,
  ) => {
    if (severity === 'failed') status = 'failed'
    else if (severity === 'unsupported' && status === 'verified') status = 'unsupported'
    warnings.push(`line ${line}: ${message}`)
    notes.push(command === undefined ? { code, line, severity } : { code, line, severity, command })
  }

  const inverseOn = rotary?.inverseTimeFeed ? commandWord(rotary.inverseTimeFeed.on) : null
  const inverseOff = rotary?.inverseTimeFeed ? commandWord(rotary.inverseTimeFeed.off) : null
  const cancelWord = cannedCycles ? commandWord(cannedCycles.cancelCommand) : null

  const state: ParseState = {
    pos: { x: 0, y: 0, z: 0 },
    motionMode: null,
    inverseTime: false,
    workZKnown: true,
    feed: undefined,
    units: 'mm',
    retractMode: null,
    canned: null,
    probed: false,
    touchOffZ: undefined,
    angleOffset: 0,
  }

  const lines = gcode.split(/\r?\n/)
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const lineNumber = lineIndex + 1
    const { words, unparsed } = tokenizeLine(lines[lineIndex], commentPrefix, commentSuffix)
    // Text the tokenizer cannot read is never silently dropped (#1054 fix 5).
    // The block may state a position, so the whole read-back is downgraded —
    // even when the words it did read are enough to draw a segment.
    if (unparsed.length > 0) {
      note(
        lineNumber,
        'unparsedText',
        'unsupported',
        `unparsed G-code text ${unparsed.map((text) => `"${text}"`).join(', ')}; the block is not fully understood`,
      )
    }
    if (words.length === 0) continue

    // Resolve the motion mode for this line: an explicit G0/G1/G2/G3 wins;
    // otherwise the line is modal and continues the last mode.
    let explicitMode: 'rapid' | 'linear' | 'arc_cw' | 'arc_ccw' | 'machine' | 'non-motion' | 'unsupported' | null = null
    let unsupportedCommand: string | null = null
    let iWord: number | undefined
    let jWord: number | undefined
    let rWord: number | undefined
    let qWord: number | undefined
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
    // A canned cycle this block starts (issue #1261), and whether it cancels one.
    let lineCanned: { kind: CannedKind; command: string } | null = null
    let lineCancels = false
    // Probes, work-offset changes and homing (issue #1261): their axis words
    // are not a move to that work position.
    let probe: string | null = null
    let offsetChange: string | null = null
    let homing: string | null = null

    for (const word of words) {
      // The definition's own inverse-time commands may be any letter; they are
      // matched by letter and value, not assumed to be G words.
      if (inverseOn !== null && word.letter === inverseOn.letter && word.value === inverseOn.value) inverseSwitch = true
      else if (inverseOff !== null && word.letter === inverseOff.letter && word.value === inverseOff.value) inverseSwitch = false
      if (cannedCycles && cancelWord !== null && word.letter === cancelWord.letter && word.value === cancelWord.value) {
        lineCancels = true
        continue
      }
      if (cannedCycles && word.letter === cannedCycles.peckStepWord.trim().toUpperCase()) {
        qWord = word.value
        continue
      }
      switch (word.letter) {
        case 'G': {
          const canned = cannedCycles ? cannedKindFor(word, cannedCycles) : null
          if (canned !== null) {
            lineCanned = canned
            break
          }
          if (word.value === 53) machineCoordinate = true
          if (word.value === 20) state.units = 'inch'
          if (word.value === 21) state.units = 'mm'
          if (word.value === 98) state.retractMode = 'G98'
          if (word.value === 99) state.retractMode = 'G99'
          if (word.value >= 38.2 - EPS && word.value <= 38.5 + EPS) probe = `G${word.value}`
          if (word.value === 10 || word.value === 92) offsetChange = `G${word.value}`
          if (word.value === 28 || word.value === 30) homing = `G${word.value}`
          const mode = motionModeForG(word.value)
          if (mode === 'unsupported') unsupportedCommand = `G${word.value}`
          // A setting never hides a motion word written earlier on the block,
          // and nothing hides an unsupported one (`G91 G0 X1` is incremental).
          if (explicitMode !== 'unsupported' && (mode !== 'non-motion' || explicitMode === null)) explicitMode = mode
          if (mode === 'rapid' || mode === 'linear' || mode === 'arc_cw' || mode === 'arc_ccw') {
            lineMotion = mode
          }
          break
        }
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
        // S (spindle), T (tool), M-codes, P (dwell), and any other letter are
        // non-positional and ignored for the trace.
        default: break
      }
    }

    // Feed mode (issue #393): G93/G94 are modal, but the inverse-time F is not.
    // It belongs to the block that writes it — a controller in inverse-time mode
    // needs an F on every feed block, so carrying the previous one forward would
    // report a program the machine stops on.
    if (inverseSwitch === true) {
      state.inverseTime = true
      state.feed = undefined
    } else if (inverseSwitch === false) {
      state.inverseTime = false
    }
    const inverseTimeFeed = state.inverseTime && feedWord !== undefined && feedWord > 0
      ? feedWord
      : undefined
    // The ordinary feed is modal (issue #1261): an F on any block, a lone F
    // line included, sets the speed of the feed moves that follow it.
    if (!state.inverseTime && feedWord !== undefined && feedWord > 0) state.feed = feedWord

    const hasAxisWords = x !== undefined || y !== undefined || z !== undefined || angleWord !== undefined
    if (angleWord !== undefined && offsetChange === null) angleWord += state.angleOffset

    // A home move goes through a stored position this parser does not know.
    if (homing !== null) {
      note(lineNumber, 'unsupportedCommand', 'unsupported', `unsupported G-code construct (${homing})`, homing)
      state.motionMode = null
      continue
    }

    // A probe stops where it touches (issue #1261): no work position, Z unknown
    // until a touch-off states one. A probe across X/Y is not a touch-off.
    if (probe !== null) {
      if (x !== undefined || y !== undefined || angleWord !== undefined) {
        note(lineNumber, 'unsupportedCommand', 'unsupported', `unsupported probe move (${probe})`, probe)
      } else {
        note(lineNumber, 'probeMove', 'info', `${probe} probe; the work-frame Z is unknown until a touch-off`, probe)
      }
      state.workZKnown = false
      state.probed = true
      state.motionMode = null
      continue
    }

    // A work-offset change moves nothing. Two forms are understood: setting Z
    // right after a probe (a touch-off: Z is measured from the probed surface
    // from here on) and setting only the angle (the bar's zero, #1103).
    if (offsetChange !== null && hasAxisWords) {
      if (z !== undefined && x === undefined && y === undefined && angleWord === undefined && state.probed) {
        note(lineNumber, 'touchOffZ', 'info', `${offsetChange} touch-off; Z is measured from the probed surface`, offsetChange)
        state.pos = { ...state.pos, z }
        state.touchOffZ = z
        state.workZKnown = true
        state.probed = false
      } else if (angleWord !== undefined && x === undefined && y === undefined && z === undefined) {
        note(lineNumber, 'rotaryZeroed', 'info', `${offsetChange} sets the rotary angle; the bar does not turn`, offsetChange)
        state.angleOffset = (state.pos.a ?? 0) - angleWord
      } else {
        note(lineNumber, 'workOffsetChange', 'unsupported', `unsupported work-offset change (${offsetChange})`, offsetChange)
      }
      continue
    }

    // The cancel command ends a run of canned cycles; motion needs a new word.
    if (lineCancels) {
      state.canned = null
      if (state.motionMode === 'canned') state.motionMode = null
    }

    // A G53 block moves in machine coordinates (#1054 fix 4). Its words are not
    // a work-frame position, so the block is not added to the trace and its Z is
    // never taken as the tracked work Z — that is exactly how the retract used
    // to reappear as a work "Z0". The work Z is unknown until a later block
    // states one. A Z-only rapid is the emitter's own retract to the machine's
    // safe height (issue #1261): the tool only goes up, so the program is still
    // understood. Anything else — X or Y in machine coordinates, a feed, a bare
    // G53 — cannot be placed in the work frame and downgrades the parse.
    if (machineCoordinate || explicitMode === 'machine') {
      const effectiveMotion = lineMotion ?? (state.motionMode === 'canned' ? null : state.motionMode)
      const zOnlyRetract = effectiveMotion === 'rapid'
        && z !== undefined && x === undefined && y === undefined && angleWord === undefined
        && iWord === undefined && jWord === undefined && rWord === undefined
      if (zOnlyRetract) {
        note(lineNumber, 'machineCoordinateRetract', 'info', 'G53 machine-coordinate retract; the work-frame Z afterwards is unknown', 'G53')
      } else {
        note(lineNumber, 'machineCoordinateMove', 'unsupported', 'G53 machine-coordinate move; the work-frame Z afterwards is unknown', 'G53')
      }
      if (lineMotion !== null) state.motionMode = lineMotion
      state.workZKnown = false
      continue
    }

    if (explicitMode === 'unsupported') {
      note(lineNumber, 'unsupportedCommand', 'unsupported', `unsupported G-code construct (${unsupportedCommand ?? 'G'})`, unsupportedCommand ?? undefined)
      // An unsupported construct may have left modal state ambiguous; reset it
      // so a later modal line is not silently continued from it.
      state.motionMode = null
      state.canned = null
      continue
    }

    const hasPosition = x !== undefined || y !== undefined || z !== undefined || angleWord !== undefined
    const hasArcWords = iWord !== undefined || jWord !== undefined || rWord !== undefined

    // Canned cycles (issue #1261): a block that writes the cycle's command, or
    // a later block with a new position while the cycle is still the motion
    // mode, drills one hole. An explicit G0-G3 ends the run.
    if (lineMotion !== null && state.motionMode === 'canned') state.canned = null
    const cannedBlock = lineCanned !== null || (lineMotion === null && state.motionMode === 'canned' && (hasPosition || rWord !== undefined))
    if (cannedBlock) {
      if (x !== undefined) statedAxes.x = true
      if (y !== undefined) statedAxes.y = true
      expandCannedCycle(lineNumber, lineCanned, x, y, z, rWord, qWord, angleWord)
      continue
    }

    // No coordinate, arc or angle words and no explicit motion → non-motion line.
    if (!hasPosition && !hasArcWords) {
      // A bare motion-mode line (e.g. "G0" alone, or a units/WCS line) just
      // sets the modal mode without moving.
      if (lineMotion !== null) state.motionMode = lineMotion
      continue
    }

    // Determine the effective motion mode for this line.
    let mode: 'rapid' | 'linear' | 'arc_cw' | 'arc_ccw'
    if (lineMotion !== null) {
      mode = lineMotion
      state.motionMode = mode
    } else if (state.motionMode !== null && state.motionMode !== 'canned') {
      mode = state.motionMode
    } else {
      // Coordinates present but no motion mode established (the postprocessor
      // always emits a G-word on the first motion line, so this is unexpected).
      note(lineNumber, 'motionWithoutMode', 'unsupported', 'motion coordinates with no established motion mode')
      mode = 'linear'
      state.motionMode = 'linear'
    }

    // A feed move in inverse-time mode must carry its own positive F (issue
    // #393). "Verified" means the trace matches what a controller would run, and
    // a controller rejects this block — so it is reported the same way as any
    // other construct the parser cannot reconstruct, not as verified.
    if (state.inverseTime && mode !== 'rapid' && inverseTimeFeed === undefined) {
      note(lineNumber, 'inverseTimeFeedMissing', 'unsupported', 'feed move in inverse-time mode without its own F word')
    }

    // A modal move after a G53 retract inherits no provable work Z (#1054 fix
    // 4): the retract moved the machine, not the work frame, so the block's
    // tracked Z would be a number the program does not state. A rapid there is
    // travel at the machine's retract height (issue #1261) and is kept, marked;
    // a feed would cut at an unstated height, so the parse is not verified.
    const zUnknown = z === undefined && !state.workZKnown
    if (zUnknown) {
      if (mode === 'rapid') {
        note(lineNumber, 'rapidAfterMachineRetract', 'info', 'rapid after a G53 retract does not state Z; it travels at the machine retract height')
      } else {
        note(lineNumber, 'workZUnknown', 'unsupported', 'move after a G53 block does not state Z; the work-frame Z is unknown')
      }
    }

    if (x !== undefined) statedAxes.x = true
    if (y !== undefined) statedAxes.y = true
    if (z !== undefined) statedAxes.z = true

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
    const feedFields = {
      ...(mode === 'rapid'
        ? (zUnknown ? { workZUnknown: true } : null)
        : inverseTimeFeed !== undefined
          ? { inverseTimeFeed }
          : state.feed !== undefined && !state.inverseTime
            ? { feed: state.feed }
            : null),
      ...(state.touchOffZ !== undefined ? { touchOffZ: state.touchOffZ } : null),
    }

    try {
      if (mode === 'rapid' || mode === 'linear') {
        moves.push({ kind: mode, from, to, ...feedFields })
      } else {
        const clockwise = mode === 'arc_cw'
        const result = applyArc(state, to, iWord, jWord, rWord, clockwise)
        if ('error' in result) {
          note(
            lineNumber,
            result.error === 'arc missing I/J or R centre word' ? 'arcCentreMissing' : 'arcRadiusTooSmall',
            'unsupported',
            result.error,
          )
          // Fall back to a linear segment so the trace stays continuous, but
          // the status downgrade guarantees the diagnostic is not "verified".
          moves.push({ kind: 'linear', from, to, ...feedFields })
        } else {
          moves.push({ ...result, ...feedFields })
        }
      }
    } catch {
      note(lineNumber, 'parseFailure', 'failed', 'parse failure')
    }

    state.pos = to
    // A block that states Z re-establishes the work frame, whatever a previous
    // machine-coordinate move did.
    if (z !== undefined) state.workZKnown = true
  }

  return { moves, status, warnings, notes, statedAxes }

  /**
   * One hole of a canned cycle, as the moves LinuxCNC documents for it: rapid
   * up to R when below it, rapid over the hole, rapid down to R, the cycle's
   * own feeds and retracts, and the retract to the clear plane — R under G99,
   * the higher of R and the run's starting Z under G98.
   */
  function expandCannedCycle(
    lineNumber: number,
    started: { kind: CannedKind; command: string } | null,
    x: number | undefined,
    y: number | undefined,
    z: number | undefined,
    r: number | undefined,
    q: number | undefined,
    angle: number | undefined,
  ): void {
    if (angle !== undefined) {
      note(lineNumber, 'cannedCycleWithRotary', 'unsupported', 'canned cycle on a block that turns the rotary axis', started?.command)
      state.motionMode = null
      state.canned = null
      return
    }
    if (started !== null) {
      // A new command keeps the run (and its starting Z) when it follows a
      // cycle directly; a run that starts here begins at the current work Z.
      const previous = state.canned
      state.canned = {
        kind: started.kind,
        command: started.command,
        z: previous?.z,
        r: previous?.r,
        q: previous?.q,
        initialZ: previous?.initialZ ?? state.pos.z,
      }
      state.motionMode = 'canned'
    }
    const run = state.canned
    if (run === null) {
      note(lineNumber, 'motionWithoutMode', 'unsupported', 'canned-cycle words with no cycle in force')
      return
    }
    if (z !== undefined) run.z = z
    if (r !== undefined) run.r = r
    if (q !== undefined) run.q = q
    const needsPeck = run.kind === 'peck' || run.kind === 'chip_breaking'
    if (run.z === undefined || run.r === undefined || (needsPeck && !(run.q !== undefined && run.q > 0))) {
      note(lineNumber, 'cannedCycleIncomplete', 'unsupported', `canned cycle ${run.command} without its Z, R or peck step`, run.command)
      return
    }
    if (!state.workZKnown) {
      note(lineNumber, 'workZUnknown', 'unsupported', 'canned cycle after a G53 block; the work-frame Z is unknown', run.command)
    }
    if (state.retractMode === null) {
      note(lineNumber, 'cannedRetractModeAssumed', 'info', 'no G98/G99 before the canned cycle; G98 assumed', run.command)
      state.retractMode = 'G98'
    }
    if (run.kind === 'chip_breaking') {
      note(lineNumber, 'chipBreakRetractApproximate', 'info', 'G73 in-hole retract is controller-specific and modelled approximately', run.command)
    }

    const feedFields = state.feed !== undefined ? { feed: state.feed } : null
    const bottom = run.z
    const retract = run.r
    const clear = state.retractMode === 'G99' ? retract : Math.max(retract, run.initialZ)
    const holeX = x ?? state.pos.x
    const holeY = y ?? state.pos.y
    const rapid = (to: ToolpathPoint) => {
      if (to.x === state.pos.x && to.y === state.pos.y && to.z === state.pos.z) return
      moves.push({ kind: 'rapid', from: { ...state.pos }, to })
      state.pos = to
    }
    const feed = (toZ: number) => {
      const to = { x: holeX, y: holeY, z: toZ }
      moves.push({ kind: 'linear', from: { ...state.pos }, to, ...feedFields })
      state.pos = to
    }

    if (state.pos.z < retract) rapid({ ...state.pos, z: retract })
    rapid({ x: holeX, y: holeY, z: state.pos.z })
    rapid({ x: holeX, y: holeY, z: retract })
    if (needsPeck) {
      const step = run.q!
      const clearance = Math.min(PECK_CLEARANCE[state.units], step)
      let depth = retract
      while (depth - step > bottom + EPS) {
        depth -= step
        feed(depth)
        if (run.kind === 'peck') {
          rapid({ x: holeX, y: holeY, z: retract })
          rapid({ x: holeX, y: holeY, z: depth + clearance })
        } else {
          rapid({ x: holeX, y: holeY, z: depth + clearance })
        }
      }
    }
    feed(bottom)
    rapid({ x: holeX, y: holeY, z: clear })
    statedAxes.z = true
    state.workZKnown = true
  }
}
