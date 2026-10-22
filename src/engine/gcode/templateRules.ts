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
 * Machine-template restrictions (#1057 slice F).
 *
 * A machine definition carries free-form text — a *template* — that the
 * postprocessor writes into the program verbatim. Five review rounds of #1057
 * each found another way an arbitrary template could leave the controller in a
 * state the program did not expect: a stale X/Y/Z/A, a motion mode, incremental
 * distance mode, a torch left on. Restricting the templates is how a real
 * post-processor prevents that, and it is what this module enforces at the
 * schema boundary.
 *
 * Three classes, decided by Frank on 2026-10-21:
 *
 * - **Program header** — written before any motion, so modal setup is allowed:
 *   `G90`, `G17`, `G40`, `G49`, `G80`, `G94`, `G92.1`, `G97`, the units words,
 *   work-coordinate select, a bare program number, a parameter assignment,
 *   comments, and M codes that do not move. No motion word and no axis word.
 * - **Tool change and end of program (footer)** — anything is allowed: motion,
 *   `G53`, `G28`/`G30`, `M6`, O-word calls, macros. The emitter follows a tool
 *   change with one full restart block of its own, and nothing follows the
 *   footer, so neither can leave the program running from a stale state.
 * - **Every other template** — inert only. A template that runs *inside* the
 *   program (spindle, coolant, operation header, pause, inverse-time, units,
 *   canned cycle, plasma torch, material/THC) may contain only comments,
 *   parameter words and commands that neither move an axis nor change a mode.
 *   The two mode templates keep their own word (`G93`/`G94` for inverse time,
 *   `G20`/`G21` for units), the torch keeps its torch words, and the
 *   material/THC handshake keeps its controller-owned commands.
 *
 * The schema (`MachineDefinitionSchema`) reports a violation against the
 * template field that carries it; machine import and the machine editor show
 * that message, so a definition that breaks the rule cannot be saved, imported
 * or loaded from a project snapshot.
 *
 * The emitter relies on this: since no template inside the program can move an
 * axis or change a mode, it no longer carries per-axis invalidation and recovery
 * for them. See `postprocessor.ts` / `opensbpEmitter.ts` (the restart block) and
 * `motionPipeline.ts`.
 */

/**
 * The rule a template field is held to.
 *
 * `anything` covers the tool-change block and the end of the program; every
 * other kind is a closed allowlist and names the reason in its message.
 */
export type TemplateRule =
  | { kind: 'anything' }
  | { kind: 'header' }
  | { kind: 'inert', label: string }
  | { kind: 'units' }
  | { kind: 'inverse-time-on' }
  | { kind: 'inverse-time-off' }
  | { kind: 'torch' }
  | { kind: 'material' }
  | { kind: 'canned-cycle' }
  | { kind: 'canned-retract' }
  | { kind: 'canned-cancel' }
  /**
   * A field that is one command (or one command prefix) and nothing else: a
   * rapid/linear/arc word, the feed or RPM letter, the peck word, the
   * machine-coordinate retract or the plasma probe/set-zero command. Reviewed
   * as a single line against an exact per-field pattern, never as free text
   * (Codex review of #1057 slice F, finding 1: `rpmCommand: "G91\nS"` wrote a
   * motion word after the restart).
   */
  | { kind: 'command', label: string, pattern: RegExp, hint: string }

/** The single-word command fields, by the shape they must have. */
type CommandField =
  | 'rapid'
  | 'linear'
  | 'arc-cw'
  | 'arc-ccw'
  | 'feed'
  | 'rpm'
  | 'peck'
  | 'machine-rapid'
  | 'probe'
  | 'set-zero'

/**
 * What every string field of the machine definition schema is, so a new field
 * cannot reach the emitter unclassified (Codex review of slice F, finding 1).
 *
 * `metadata`/`enum`/`comment` are not program text and are only here so the
 * enumeration is complete. `template` and `command` are validated.
 */
export type StringFieldClass =
  | { kind: 'metadata' }
  | { kind: 'enum' }
  | { kind: 'comment' }
  | { kind: 'template', rule: TemplateRule }
  | { kind: 'command', command: CommandField }

/** One string field of `MachineDefinitionSchema`, with its class. */
export interface MachineStringFieldSpec {
  /** Schema path; an array's elements share the container's path. */
  path: readonly string[]
  /** True when the schema declares an array of strings. */
  array?: boolean
  class: StringFieldClass
}

/**
 * The definition shape these rules read. Structural rather than
 * `MachineDefinition`, so the module does not import the schema that imports
 * it; the schema's parsed output satisfies it.
 */
export interface TemplateRuleDefinition {
  program: {
    header: readonly string[]
    operationHeader: readonly string[]
    footer: readonly string[]
    commentPrefix: string
  }
  units: {
    mmCommand: string | null
    inchCommand: string | null
  }
  workCoordinates: {
    selectCommand: string | null
  }
  motion: {
    rapidCommand: string
    linearCommand: string
    cwArcCommand: string
    ccwArcCommand: string
    machineCoordinateCommand?: string | null
  }
  feedSpeed: {
    feedCommand: string
    rpmCommand: string
    spindleOnCW: string
    spindleOnCCW: string
    spindleOff: string
  }
  toolChange: {
    commands: readonly string[]
    pauseCommand: string
  }
  coolant: {
    floodOnCommand: string
    mistOnCommand: string
    coolantOffCommand: string
  } | null
  cannedCycles: {
    drillCommand: string | null
    drillWithDwellCommand: string | null
    peckDrillCommand: string | null
    chipBreakDrillCommand: string | null
    peckStepWord: string
    retractMode: 'G98' | 'G99' | null
    cancelCommand: string
  } | null
  rotary?: {
    inverseTimeFeed: { on: string, off: string } | null
  }
  plasma?: {
    torchOnCommand: string
    torchOffCommand: string
    materialSelectCommand?: string
    materialWaitCommand?: string
    materialFeedCommand?: string
    thcOnCommand?: string
    thcOffCommand?: string
    touchOff?: {
      probeCommand: string
      setZeroCommand: string
    }
  }
  stop: {
    programEndCommand: string
  }
}

/** One refused template: the field it lives in and why. */
export interface TemplateRuleViolation {
  path: Array<string | number>
  message: string
}

interface TemplateField {
  path: Array<string | number>
  text: string
  rule: TemplateRule
}

/**
 * `G`/`M` commands a program header may spell (before the first move). The
 * non-modal state that does not move: plane, units, distance, feed mode, cutter
 * compensation cancel, work-coordinate select, path control, cycle cancel,
 * offset reset and constant-surface-speed cancel. `G43`/`G44` apply an offset
 * and `G91` changes the distance mode, so neither is here.
 */
const HEADER_G_COMMANDS: ReadonlySet<string> = new Set([
  'G4', 'G17', 'G20', 'G21', 'G40', 'G49', 'G54', 'G55', 'G56', 'G57', 'G58',
  'G59', 'G61', 'G64', 'G80', 'G90', 'G92.1', 'G94', 'G97',
])

/**
 * M codes a program header may spell: nothing that moves an axis or invokes
 * another program. `M52` is LinuxCNC's overrides enable, which is how the
 * bundled QtPlasmaC header turns hole handling on.
 */
const HEADER_M_COMMANDS: ReadonlySet<string> = new Set([
  'M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M7', 'M8', 'M9', 'M30', 'M52',
])

/**
 * `G`/`M` commands an inert template may spell. Only a dwell is truly inert:
 * every other G word an earlier version allowed (`G40`, `G49`, `G61`, `G64`,
 * `G80`, `G97`) changes controller state, and a state change written inside the
 * program is exactly what the class rule exists to prevent (Codex review of
 * slice F, finding 4). `G80` and `G49` remain legal in a program header, which
 * runs before any motion and before the first tool change, and in the
 * tool-change and footer templates, which the emitter distrusts.
 *
 * The M codes are the spindle, coolant, pause and stop commands: they start or
 * stop a device but move no axis and change no motion mode.
 */
const INERT_G_COMMANDS: ReadonlySet<string> = new Set(['G4'])
const INERT_M_COMMANDS: ReadonlySet<string> = new Set([
  'M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M7', 'M8', 'M9', 'M30',
])

/** A canned-cycle command word: a cycle the emitter itself positions. */
const CANNED_CYCLE_COMMANDS: ReadonlySet<string> = new Set([
  'G73', 'G81', 'G82', 'G83', 'G84', 'G85', 'G86', 'G87', 'G88', 'G89',
])

/** A material/THC output command (LinuxCNC M62–M67, QtPlasmaC M190/M191). */
const MATERIAL_COMMANDS: ReadonlySet<string> = new Set([
  'M62', 'M63', 'M64', 'M65', 'M66', 'M67', 'M190', 'M191',
])

/**
 * Letters that name an axis, an arc offset or a cycle plane. No rule here
 * accepts one: an axis word is how a "harmless" template parks the machine.
 */
const AXIS_LETTERS: ReadonlySet<string> = new Set([
  'X', 'Y', 'Z', 'A', 'B', 'C', 'U', 'V', 'W', 'I', 'J', 'K', 'R',
])

/** Words that carry a number but move nothing: feed, speed, tool, offset, parameter. */
const PARAMETER_LETTERS: ReadonlySet<string> = new Set([
  'F', 'S', 'T', 'N', 'H', 'D', 'P', 'Q', 'L',
])

/** The letters a material/THC handshake word may carry. */
const MATERIAL_LETTERS: ReadonlySet<string> = new Set(['P', 'L', 'Q', 'T', 'E', 'F', 'S'])

/** The torch command words. A torch on/off template is nothing else. */
const TORCH_COMMANDS: ReadonlySet<string> = new Set(['M3', 'M4', 'M5'])

/**
 * Placeholders that carry text the operator typed: the project name, an
 * operation's name or description, and a tool's name. They may only be
 * substituted inside a comment (Codex review of slice F, finding 3): a
 * template that puts one in code writes arbitrary user text into the program,
 * and a closing `)` or a newline in it escapes the comment entirely.
 */
const USER_TEXT_PLACEHOLDERS: ReadonlySet<string> = new Set([
  'programName', 'operationName', 'operationDescription', 'toolName',
])

/**
 * Every placeholder the emitter fills in with a value the definition author
 * controls or a number it formats. They cannot escape a comment or write an
 * arbitrary word, so they are judged by what they expand to.
 */
const NUMERIC_PLACEHOLDERS: ReadonlySet<string> = new Set([
  'date', 'units', 'operationIndex', 'operationKind', 'operationPass',
  'operationTarget', 'toolNumber', 'feed', 'plungeFeed', 'rpm', 'materialNumber',
])

/** The exact per-field shape a single-word command field must have. */
const COMMAND_CORES: Record<CommandField, { core: string, label: string, hint: string }> = {
  rapid: {
    core: 'G0{1,2}',
    label: 'rapid command',
    hint: 'the rapid command is one G0 or G00 word and nothing else',
  },
  linear: {
    core: 'G0?1',
    label: 'linear command',
    hint: 'the linear command is one G1 or G01 word and nothing else',
  },
  'arc-cw': {
    core: 'G0?2',
    label: 'clockwise arc command',
    hint: 'the clockwise arc command is one G2 or G02 word and nothing else',
  },
  'arc-ccw': {
    core: 'G0?3',
    label: 'counter-clockwise arc command',
    hint: 'the counter-clockwise arc command is one G3 or G03 word and nothing else',
  },
  feed: {
    core: 'F',
    label: 'feed command',
    hint: 'the feed command is the letter F; the emitter appends the number',
  },
  rpm: {
    core: 'S?',
    label: 'RPM command',
    hint: 'the RPM command is the letter S; the emitter appends the number, and a blank field writes none',
  },
  peck: {
    core: 'Q',
    label: 'peck-step word',
    hint: 'the peck-step word is the letter Q; the emitter appends the depth',
  },
  'machine-rapid': {
    core: 'G53(?:\\s+G0{1,2})?',
    label: 'machine-coordinate rapid command',
    hint: 'the machine-coordinate command is G53, optionally followed by G0 or G00; the emitter appends only Z',
  },
  probe: {
    core: 'G38\\.[2-5]',
    label: 'probe command',
    hint: 'the probe command is one G38.2-G38.5 word; the emitter appends only Z and F',
  },
  'set-zero': {
    core: '(?:G10\\s+L(?:2|20)\\s+P0|G92(?:\\.1)?)',
    label: 'set-zero command',
    hint: 'the set-zero command is G10 L2/L20 P0 or G92/G92.1; the emitter appends only Z, and it must set the current work coordinate',
  },
}

/** A regex that matches `core` alone, with the definition's comment marker optional. */
function commandPattern(command: CommandField, commentPrefix: string): RegExp {
  const marker = commentPrefix.length > 0
    ? `(?:${commentPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*)?`
    : ''
  return new RegExp(`^\\s*${marker}${COMMAND_CORES[command].core}\\s*$`, 'i')
}

/** A template whose whole text is one line of code. */
function template(rule: TemplateRule): StringFieldClass {
  return { kind: 'template', rule }
}

/**
 * EVERY string field of `MachineDefinitionSchema`, with its class. A test
 * enumerates the schema's string fields and fails when one of them is missing
 * here, so a new field cannot be added without deciding what it is. This table
 * is also what `templateFields` walks: the classification and the validation
 * cannot drift apart.
 */
export const MACHINE_STRING_FIELDS: readonly MachineStringFieldSpec[] = [
  { path: ['id'], class: { kind: 'metadata' } },
  { path: ['name'], class: { kind: 'metadata' } },
  { path: ['description'], class: { kind: 'metadata' } },
  { path: ['vendor'], class: { kind: 'metadata' } },
  { path: ['fileExtension'], class: { kind: 'metadata' } },
  { path: ['outputDialect'], class: { kind: 'enum' } },
  { path: ['machineKind'], class: { kind: 'enum' } },

  { path: ['plasma', 'torchOnCommand'], class: template({ kind: 'torch' }) },
  { path: ['plasma', 'torchOffCommand'], class: template({ kind: 'torch' }) },
  { path: ['plasma', 'materialSelectCommand'], class: template({ kind: 'material' }) },
  { path: ['plasma', 'materialWaitCommand'], class: template({ kind: 'material' }) },
  { path: ['plasma', 'materialFeedCommand'], class: template({ kind: 'material' }) },
  { path: ['plasma', 'thcOnCommand'], class: template({ kind: 'material' }) },
  { path: ['plasma', 'thcOffCommand'], class: template({ kind: 'material' }) },
  { path: ['plasma', 'pierceMode'], class: { kind: 'enum' } },
  { path: ['plasma', 'touchOff', 'probeCommand'], class: { kind: 'command', command: 'probe' } },
  { path: ['plasma', 'touchOff', 'setZeroCommand'], class: { kind: 'command', command: 'set-zero' } },

  { path: ['rotary', 'about'], class: { kind: 'enum' } },
  { path: ['rotary', 'drive'], class: { kind: 'enum' } },
  { path: ['rotary', 'inverseTimeFeed', 'on'], class: template({ kind: 'inverse-time-on' }) },
  { path: ['rotary', 'inverseTimeFeed', 'off'], class: template({ kind: 'inverse-time-off' }) },

  { path: ['coordinateSystem', 'xAxis'], class: { kind: 'enum' } },
  { path: ['coordinateSystem', 'yAxis'], class: { kind: 'enum' } },
  { path: ['coordinateSystem', 'zAxis'], class: { kind: 'enum' } },

  { path: ['units', 'mmCommand'], class: template({ kind: 'units' }) },
  { path: ['units', 'inchCommand'], class: template({ kind: 'units' }) },

  { path: ['program', 'header'], array: true, class: template({ kind: 'header' }) },
  { path: ['program', 'operationHeader'], array: true, class: template({ kind: 'inert', label: 'operation header' }) },
  { path: ['program', 'footer'], array: true, class: template({ kind: 'anything' }) },
  { path: ['program', 'commentPrefix'], class: { kind: 'comment' } },
  { path: ['program', 'commentSuffix'], class: { kind: 'comment' } },

  { path: ['workCoordinates', 'selectCommand'], class: template({ kind: 'header' }) },

  { path: ['motion', 'rapidCommand'], class: { kind: 'command', command: 'rapid' } },
  { path: ['motion', 'linearCommand'], class: { kind: 'command', command: 'linear' } },
  { path: ['motion', 'cwArcCommand'], class: { kind: 'command', command: 'arc-cw' } },
  { path: ['motion', 'ccwArcCommand'], class: { kind: 'command', command: 'arc-ccw' } },
  { path: ['motion', 'arcFormat'], class: { kind: 'enum' } },
  { path: ['motion', 'machineCoordinateCommand'], class: { kind: 'command', command: 'machine-rapid' } },

  { path: ['feedSpeed', 'feedCommand'], class: { kind: 'command', command: 'feed' } },
  { path: ['feedSpeed', 'rpmCommand'], class: { kind: 'command', command: 'rpm' } },
  { path: ['feedSpeed', 'spindleOnCW'], class: template({ kind: 'inert', label: 'spindle-on' }) },
  { path: ['feedSpeed', 'spindleOnCCW'], class: template({ kind: 'inert', label: 'spindle-on' }) },
  { path: ['feedSpeed', 'spindleOff'], class: template({ kind: 'inert', label: 'spindle-off' }) },

  { path: ['toolChange', 'commands'], array: true, class: template({ kind: 'anything' }) },
  { path: ['toolChange', 'pauseCommand'], class: template({ kind: 'inert', label: 'pause' }) },

  { path: ['cannedCycles', 'drillCommand'], class: template({ kind: 'canned-cycle' }) },
  { path: ['cannedCycles', 'drillWithDwellCommand'], class: template({ kind: 'canned-cycle' }) },
  { path: ['cannedCycles', 'peckDrillCommand'], class: template({ kind: 'canned-cycle' }) },
  { path: ['cannedCycles', 'chipBreakDrillCommand'], class: template({ kind: 'canned-cycle' }) },
  { path: ['cannedCycles', 'peckStepWord'], class: { kind: 'command', command: 'peck' } },
  { path: ['cannedCycles', 'retractMode'], class: template({ kind: 'canned-retract' }) },
  { path: ['cannedCycles', 'cancelCommand'], class: template({ kind: 'canned-cancel' }) },

  { path: ['coolant', 'floodOnCommand'], class: template({ kind: 'inert', label: 'coolant' }) },
  { path: ['coolant', 'mistOnCommand'], class: template({ kind: 'inert', label: 'coolant' }) },
  { path: ['coolant', 'coolantOffCommand'], class: template({ kind: 'inert', label: 'coolant' }) },

  { path: ['stop', 'programEndCommand'], class: template({ kind: 'anything' }) },
]

interface ScanOptions {
  /** A controller-owned feed expression (`F#<_hal[plasmac.cut-feed-rate]>`). */
  parameterExpressions: boolean
  /** A parameter assignment (`#<holes> = 1`), which moves nothing. */
  assignment: boolean
  /** A numeric `$` selector, such as QtPlasmaC's `M5 $0`. */
  allowSelectors: boolean
}

interface ScannedWord {
  letter: string
  value?: string
}

/**
 * One program line with its comments removed: an embedded or leading
 * `( … )` comment, a standard `;` line comment, and everything from the
 * definition's own line-comment prefix to the end of the line. Code after a
 * parenthesised comment is still code, which is why a line is never skipped
 * just because it starts with one.
 */
function lineCode(line: string, commentPrefix: string): string {
  let code = line.replace(/\([^)]*\)/g, ' ')
  // `;` is a comment in every bundled G-code dialect, including the two whose
  // definition prefix is `(` and whose own fields comment with `;`
  // (QtPlasmaC's unused-router-speed lines). A comment cannot move an axis.
  const semicolon = code.indexOf(';')
  if (semicolon >= 0) code = code.slice(0, semicolon)
  // `(` is the parenthesised-comment marker, already removed above; slicing at
  // it would throw away the code that follows.
  if (commentPrefix.length > 0 && commentPrefix !== '(') {
    const at = code.indexOf(commentPrefix)
    if (at >= 0) code = code.slice(0, at)
  }
  return code
}

/**
 * Split one rendered template line into the words it spells, or return the
 * token the rule does not understand.
 *
 * The scan is deliberately the same one the emitter used before the rule
 * existed: comments first, then block delete, the program delimiter, a bare
 * O-word program number, `$` selectors, macro variables and expressions, and
 * finally letter/value words. Anything between two words that is not
 * whitespace is itself an offending token, so no unknown syntax slips through
 * as a word this module happens not to know.
 */
function scanTemplateLine(
  line: string,
  commentPrefix: string,
  options: ScanOptions,
): { words: ScannedWord[] } | { word: string } {
  let code = lineCode(line, commentPrefix).trim()
  // Block delete marks an optional block; it is not a word.
  while (code.startsWith('/')) code = code.slice(1).trimStart()
  if (code.length === 0) return { words: [] }
  // The program delimiter cannot move an axis.
  if (code === '%') return { words: [{ letter: '%' }] }
  // A parameter assignment names a variable and computes a value; it moves
  // nothing on its own. Only the header allows one (the bundled QtPlasmaC
  // program number). It does not end the line: `#1=1 G0Z-2` is an assignment
  // followed by a motion word, and the scan must still see the motion (Codex
  // review of slice F, finding 2). Consuming every assignment token and
  // continuing is what makes the rest of the line visible.
  if (options.assignment) {
    code = code.replace(/#(?:<[^>\n]*>|\d+)\s*=\s*[-+]?(?:\d+(?:\.\d*)?|\.\d+)/g, ' ')
  }
  // An O-word is the interpreter's program/subroutine/macro syntax. A bare
  // O-word names the program (`O0001 (part.nc)`) and moves nothing; anything
  // after it is a keyword or a macro body and is refused.
  const oWord = /(?:^|\s)[Oo]\s*(?:<[^>]*>|\d+(?:\.\d+)?)/.exec(code)
  if (oWord) {
    const rest = code.slice(0, oWord.index ?? 0)
      + code.slice((oWord.index ?? 0) + oWord[0].length)
    if (rest.trim().length > 0) return { word: oWord[0].trim() }
    return { words: [{ letter: 'O' }] }
  }
  // A numeric selector is an argument of the command, not an expression, and
  // it names no axis. Every other `$` (a system command, a macro variable) is
  // arbitrary text and is refused.
  if (!options.allowSelectors && code.includes('$')) return { word: '$' }
  // A controller-owned feed value is a parameter expression, not a word value.
  if (options.parameterExpressions) {
    code = code.replace(/([FS])\s*#<[^>\n]*>/g, '$1 1')
  }
  code = code.replace(/\$\d+(?:\.\d+)?/g, ' ')
  for (const character of ['#', '[', ']', '$', '=']) {
    if (code.includes(character)) return { word: character }
  }

  const words: ScannedWord[] = []
  let at = 0
  for (const match of code.matchAll(/([A-Za-z])\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))?/g)) {
    const start = match.index ?? at
    // Anything between two words that is not whitespace is not a known word.
    if (start !== at && code.slice(at, start).trim().length > 0) {
      return { word: code.slice(at, start).trim() }
    }
    at = start + match[0].length
    const letter = match[1].toUpperCase()
    if (match[2] === undefined) return { word: letter }
    words.push({ letter, value: match[2] })
  }
  const tail = code.slice(at).trim()
  if (tail.length > 0) return { word: tail }
  return { words }
}

/** The word as it appears, for the message (`X0`, `G91`, `$`). */
function showWord(word: ScannedWord): string {
  return word.value === undefined ? word.letter : `${word.letter}${word.value}`
}

/** The `G`/`M` command a word spells, or null for any other letter. */
function commandOf(word: ScannedWord): string | null {
  if (word.letter !== 'G' && word.letter !== 'M') return null
  return `${word.letter}${Number(word.value)}`
}

/** Why a line was refused: a word, or one of the two placeholder mistakes. */
type LineRefusalKind = 'word' | 'user-placeholder' | 'unknown-placeholder'

interface LineRefusal {
  word: string
  kind: LineRefusalKind
}

/**
 * A placeholder in *code* that the emitter cannot safely fill: operator text
 * (which may close a comment or start a new line) or a placeholder the emitter
 * does not know at all. Inside a comment both are harmless, which is why the
 * line's comments are removed before this check.
 */
function placeholderRefusal(line: string, commentPrefix: string): LineRefusal | null {
  const code = lineCode(line, commentPrefix)
  for (const match of code.matchAll(/\{(\w+)\}/g)) {
    const key = match[1]
    if (USER_TEXT_PLACEHOLDERS.has(key)) {
      return { word: match[0], kind: 'user-placeholder' }
    }
    if (!NUMERIC_PLACEHOLDERS.has(key) && key !== 'unitsCommand' && key !== 'wcsCommand') {
      return { word: match[0], kind: 'unknown-placeholder' }
    }
  }
  return null
}

/**
 * The first word on one line that breaks `rule`, or null when the line is
 * acceptable. `anything` still checks placeholders (operator text may not be
 * written as code anywhere), but is otherwise unchecked.
 */
function checkTemplateLine(
  line: string,
  rule: TemplateRule,
  commentPrefix: string,
): LineRefusal | null {
  const placeholder = placeholderRefusal(line, commentPrefix)
  if (placeholder !== null) return placeholder
  if (rule.kind === 'anything') return null
  // A command field is one line matched whole: a rapid word, a feed letter, a
  // probe. Nothing about it is free text, so a second word, a newline or a
  // mode change makes the field wrong as a whole.
  if (rule.kind === 'command') {
    const text = line.trim()
    return rule.pattern.test(text)
      ? null
      : { word: text.length > 0 ? text : '(blank)', kind: 'word' }
  }
  const scan = scanTemplateLine(line, commentPrefix, {
    parameterExpressions: rule.kind === 'material',
    assignment: rule.kind === 'header',
    allowSelectors: rule.kind === 'torch' || rule.kind === 'material',
  })
  if ('word' in scan) return { word: scan.word, kind: 'word' }

  for (const word of scan.words) {
    const command = commandOf(word)
    switch (rule.kind) {
      case 'header':
        // A bare O-word names the program and the delimiter frames it; both
        // move nothing.
        if (word.letter === 'O' || word.letter === '%') continue
        if (command !== null) {
          const allowed = word.letter === 'G' ? HEADER_G_COMMANDS : HEADER_M_COMMANDS
          if (!allowed.has(command)) return { word: showWord(word), kind: 'word' }
          continue
        }
        if (AXIS_LETTERS.has(word.letter) || !PARAMETER_LETTERS.has(word.letter)) {
          return { word: showWord(word), kind: 'word' }
        }
        continue
      case 'inert':
        if (command !== null) {
          const allowed = word.letter === 'G' ? INERT_G_COMMANDS : INERT_M_COMMANDS
          if (!allowed.has(command)) return { word: showWord(word), kind: 'word' }
          continue
        }
        if (!PARAMETER_LETTERS.has(word.letter)) return { word: showWord(word), kind: 'word' }
        continue
      case 'units':
        // The units template is its own G20/G21 and nothing else.
        if (word.letter !== 'G' || (command !== 'G20' && command !== 'G21')) {
          return { word: showWord(word), kind: 'word' }
        }
        continue
      case 'inverse-time-on':
        if (command !== 'G93') return { word: showWord(word), kind: 'word' }
        continue
      case 'inverse-time-off':
        if (command !== 'G94') return { word: showWord(word), kind: 'word' }
        continue
      case 'torch':
        if (command !== null) {
          if (!TORCH_COMMANDS.has(command)) return { word: showWord(word), kind: 'word' }
          continue
        }
        if (word.letter !== 'S') return { word: showWord(word), kind: 'word' }
        continue
      case 'material':
        if (command !== null) {
          if (!MATERIAL_COMMANDS.has(command)) return { word: showWord(word), kind: 'word' }
          continue
        }
        if (!MATERIAL_LETTERS.has(word.letter)) return { word: showWord(word), kind: 'word' }
        continue
      case 'canned-cycle':
        if (command === null || !CANNED_CYCLE_COMMANDS.has(command)) {
          return { word: showWord(word), kind: 'word' }
        }
        continue
      case 'canned-retract':
        if (command !== 'G98' && command !== 'G99') return { word: showWord(word), kind: 'word' }
        continue
      case 'canned-cancel':
        if (command !== 'G80') return { word: showWord(word), kind: 'word' }
        continue
    }
  }
  return null
}

/** How a rule is named in a refusal, and the one-sentence reason. */
function describeRule(rule: TemplateRule): { label: string, hint: string } {
  switch (rule.kind) {
    case 'header':
      return {
        label: 'program header',
        hint: 'before the first move only modal setup, comments, parameter assignments and non-moving M codes are allowed; there is no motion or axis word here',
      }
    case 'inert':
      return {
        label: `${rule.label} template`,
        hint: 'a template that runs inside the program may contain only comments, parameter words and commands that neither move an axis nor change a mode',
      }
    case 'units':
      return { label: 'units template', hint: 'a units template may contain only its G20 or G21 word' }
    case 'inverse-time-on':
      return { label: 'inverse-time on template', hint: 'the inverse-time on template may contain only G93' }
    case 'inverse-time-off':
      return { label: 'inverse-time off template', hint: 'the inverse-time off template may contain only G94' }
    case 'torch':
      return {
        label: 'plasma torch template',
        hint: 'a torch template may contain only M3, M4 or M5 with an optional S word and $ selector',
      }
    case 'material':
      return {
        label: 'material/THC template',
        hint: 'a material/THC template may contain only M62-M67 or M190/M191 output commands, P/L/Q/T/E parameters and an F/S feed word',
      }
    case 'canned-cycle':
      return {
        label: 'canned-cycle template',
        hint: 'a canned-cycle template may contain only a cycle command (G73, G81-G89)',
      }
    case 'canned-retract':
      return { label: 'canned-cycle retract template', hint: 'a canned-cycle retract template may contain only G98 or G99' }
    case 'canned-cancel':
      return { label: 'canned-cycle cancel template', hint: 'a canned-cycle cancel template may contain only G80' }
    case 'anything':
      return { label: 'template', hint: 'this template may contain anything' }
    case 'command':
      return { label: rule.label, hint: rule.hint }
  }
}

/** A schema path rendered for a person: `program.header[1]`, `feedSpeed.spindleOff`. */
function fieldName(path: Array<string | number>): string {
  let name = ''
  for (const part of path) {
    if (typeof part === 'number') {
      name += `[${part}]`
    } else {
      name += name.length > 0 ? `.${part}` : part
    }
  }
  return name
}

/**
 * A template expanded the way the emitter expands it, so a placeholder is
 * judged by what it becomes rather than by the placeholder text.
 * `{unitsCommand}` and `{wcsCommand}` render the definition's own commands and
 * every value placeholder renders a number. Operator text is deliberately left
 * in place: it may only appear inside a comment (checked before this runs), and
 * a comment is removed before the words are scanned.
 */
function expandPlaceholders(text: string, unitsCommand: string, wcsCommand: string): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => {
    if (key === 'unitsCommand') return unitsCommand
    if (key === 'wcsCommand') return wcsCommand
    return NUMERIC_PLACEHOLDERS.has(key) ? '1' : whole
  })
}

/** The rule a classified field must satisfy, or null when it is not program text. */
function fieldRule(fieldClass: StringFieldClass, definition: TemplateRuleDefinition): TemplateRule | null {
  switch (fieldClass.kind) {
    case 'metadata':
    case 'enum':
    case 'comment':
      return null
    case 'template':
      return fieldClass.rule
    case 'command': {
      const command = COMMAND_CORES[fieldClass.command]
      return {
        kind: 'command',
        label: command.label,
        pattern: commandPattern(fieldClass.command, definition.program.commentPrefix),
        hint: command.hint,
      }
    }
  }
}

/** Read a dotted schema path from a definition, or undefined. */
function readPath(root: unknown, path: readonly string[]): unknown {
  let value = root
  for (const key of path) {
    if (value === null || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

/**
 * Every classified string field that is present in the definition, with the
 * rule it must satisfy. Driven by `MACHINE_STRING_FIELDS`, so a field the table
 * classifies is validated and a field it does not is caught by the enumeration
 * test before it can reach the emitter.
 */
function templateFields(definition: TemplateRuleDefinition): TemplateField[] {
  const fields: TemplateField[] = []
  for (const spec of MACHINE_STRING_FIELDS) {
    const rule = fieldRule(spec.class, definition)
    if (rule === null) continue
    const value = readPath(definition, spec.path)
    if (value === null || value === undefined) continue
    if (spec.array) {
      if (!Array.isArray(value)) continue
      value.forEach((text, index) => {
        if (typeof text === 'string') fields.push({ path: [...spec.path, index], text, rule })
      })
    } else if (typeof value === 'string') {
      fields.push({ path: [...spec.path], text: value, rule })
    }
  }
  return fields
}

/**
 * The words that break `rule` somewhere in one template text, one per
 * offending line (empty when the text is acceptable).
 *
 * This is the line-level form of the rule, for a caller that has to *drop* a
 * line rather than refuse a whole definition — the post-processor converter
 * translating a vendor preamble, which must not build a definition the schema
 * will reject. `unitsCommand`/`wcsCommand` are what the emitter would expand
 * `{unitsCommand}`/`{wcsCommand}` into; the defaults are legal header words.
 */
export function refusedTemplateWords(
  text: string,
  rule: TemplateRule,
  commentPrefix: string,
  unitsCommand = 'G21',
  wcsCommand = 'G54',
): string[] {
  const words: string[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = expandPlaceholders(rawLine, unitsCommand, wcsCommand)
    const refusal = checkTemplateLine(line, rule, commentPrefix)
    if (refusal !== null) words.push(refusal.word)
  }
  return words
}

/** The refusal as a person reads it, naming the field and saying why. */
function refusalMessage(
  path: Array<string | number>,
  rule: TemplateRule,
  refusal: LineRefusal,
): string {
  const field = fieldName(path)
  if (refusal.kind === 'user-placeholder') {
    return `${field}: the placeholder "${refusal.word}" may only be used inside a comment; outside one it writes the operator's own text as program code.`
  }
  if (refusal.kind === 'unknown-placeholder') {
    return `${field}: the placeholder "${refusal.word}" is not one the emitter fills in; remove it or use a supported placeholder.`
  }
  const { label, hint } = describeRule(rule)
  return `${field}: the word "${refusal.word}" is not allowed in the ${label}; ${hint}.`
}

/**
 * Every template in the definition that breaks its class rule, one violation
 * per field (the first offending line wins). The schema turns each into an
 * issue on the field's path, so the editor and machine import can say which
 * template and which word are wrong.
 */
export function templateRuleViolations(definition: TemplateRuleDefinition): TemplateRuleViolation[] {
  const unitsCommand = definition.units.mmCommand ?? definition.units.inchCommand ?? ''
  const wcsCommand = definition.workCoordinates.selectCommand ?? ''
  const violations: TemplateRuleViolation[] = []
  for (const field of templateFields(definition)) {
    for (const rawLine of field.text.split(/\r?\n/)) {
      const line = expandPlaceholders(rawLine, unitsCommand, wcsCommand)
      const refusal = checkTemplateLine(line, field.rule, definition.program.commentPrefix)
      if (refusal !== null) {
        violations.push({
          path: field.path,
          message: refusalMessage(field.path, field.rule, refusal),
        })
        break
      }
    }
  }
  return violations
}
