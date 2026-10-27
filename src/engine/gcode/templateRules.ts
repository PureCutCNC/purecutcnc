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
 * Slice H closed three holes Codex found in the first cut (2026-10-21):
 *
 * - the definition's own `commentPrefix` was used as the comment marker while
 *   validating, so a free-text prefix (`commentPrefix: "G91"`) could turn
 *   `spindleOnCW: "G91"` into a "comment" that the emitter then wrote as code.
 *   Comment syntax is now an exact per-dialect allowlist and validation uses
 *   the dialect's real comment forms, never the user-set field.
 * - a numeric placeholder was expanded to `1` before judging the line, so
 *   `M{toolNumber}` validated as `M1` and could emit `M6`. A placeholder is
 *   now judged where it stands: a fixed word letter it may follow, never a G
 *   or M number, never joined to a following value, and never at an unknown
 *   position. Slice K below relaxes the word-adjacency half of this rule.
 * - single-command fields were split into lines before matching, so
 *   `feedCommand: "F\nF"` passed one line at a time. A command field is now
 *   one line and one command, judged whole.
 *
 * Three classes, decided by Frank on 2026-10-21:
 *
 * - **Program header** — written before any motion, so modal setup is allowed:
 *   `G90`, `G17`, `G40`, `G49`, `G80`, `G94`, `G92.1`, `G97`, `G91.1`, a bare
 *   `G0`/`G00` with no axis word, the units words, work-coordinate select, a
 *   bare program number, a parameter assignment, comments, and M codes that do
 *   not move. No other motion word and no axis word.
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
 *
 * Slice I (2026-10-21) accepts the forms QtPlasmaC documents, and no more:
 *
 * - the torch template's `$` selector is a LinuxCNC spindle number;
 * - the material feed template is exactly the controller-owned
 *   `F#<_hal[plasmac.cut-feed-rate]>`, optionally followed by a comment;
 * - a material/THC command carries only the parameter words its own LinuxCNC
 *   or QtPlasmaC command defines.
 *
 * Slice J (2026-10-21) corrects the three behaviours slice I got wrong:
 *
 * - `Q` is a real number on `M66` (a timeout in seconds) and `M67` (the analog
 *   value to set), so a decimal `Q` is valid; `P`, `L` and `E` stay integers
 *   as LinuxCNC defines them;
 * - `$-1` stops every tool and is valid on `M5` only; `$n` is valid on `M3`,
 *   `M4` and `M5` only for QtPlasmaC's documented tools 0 (torch), 1 (scribe)
 *   and 2 (spotting);
 * - the material feed expression's `F` is case-insensitive like every G-code
 *   letter; the HAL pin name itself stays exact.
 *
 * Slice K (#1119, 2026-10-26) relaxes the three cases Frank approved as
 * legitimate G-code, so a 0.5.x machine such as the #1109 reporter's loads and
 * exports unchanged:
 *
 * - a program header may spell a bare `G0`/`G00` with no axis word: it sets the
 *   motion mode and moves nothing. An axis word on the same line is still
 *   refused;
 * - a program header may spell `G91.1`, arc centres relative to the start,
 *   which is how the emitter writes I/J (`arcFitting.ts`). `G90.1` (absolute
 *   arc centres) and `G91` (incremental distance) stay refused;
 * - a numeric placeholder may end a word and be immediately followed by the
 *   next word, and may itself follow a completed word: `T{toolNumber}M6` and
 *   `G43Z0.8000H{toolNumber}` are accepted. A placeholder that would become
 *   part of a G or M number (`M{toolNumber}`, `G{x}`) or be joined to a
 *   following value (`T{toolNumber}5`) stays refused.
 *
 * The documentation for each form is cited beside the constant that enforces
 * it.
 */

/**
 * The rule a template field is held to.
 *
 * `anything` covers the end of the program, and `tool-change` the tool-change
 * block; every other kind is a closed allowlist and names the reason in its
 * message. The tool change is separate from the footer because it is the one
 * template the emitter restarts after, so it may state a tool-length offset
 * (`G43 H{toolNumber}`) that nothing after the footer could compensate for.
 */
export type TemplateRule =
  | { kind: 'anything' }
  | { kind: 'tool-change' }
  | { kind: 'header' }
  | { kind: 'inert', label: string }
  | { kind: 'units' }
  | { kind: 'inverse-time-on' }
  | { kind: 'inverse-time-off' }
  | { kind: 'torch' }
  | { kind: 'material' }
  | { kind: 'material-feed' }
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
 * `metadata`/`enum` are not program text and are only here so the enumeration
 * is complete. `comment-syntax` is the comment marker pair, checked against the
 * dialect's exact allowlist rather than against a template class. `template`
 * and `command` are validated as program text.
 */
export type StringFieldClass =
  | { kind: 'metadata' }
  | { kind: 'enum' }
  | { kind: 'comment-syntax' }
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
  /** Absent means G-code, exactly as `resolveOutputDialect` reads it. */
  outputDialect?: 'gcode' | 'opensbp'
  program: {
    header: readonly string[]
    operationHeader: readonly string[]
    footer: readonly string[]
    commentPrefix: string
    commentSuffix: string
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

/**
 * The comment syntax a definition may declare, by output dialect.
 *
 * These are the only forms the bundled definitions use and the only forms the
 * emitters know how to write: a G-code program comments with `( … )` or `;`,
 * and a ShopBot part file with `'`. The pair is *exact* — no free text, no
 * newline — because the marker is also what the emitter wraps operator text
 * in and what the validator strips before reading code (Codex review of #1057
 * slice H, finding 1).
 */
export type CommentDialect = 'gcode' | 'opensbp'

interface CommentSyntax {
  /** Markers that start a comment running to the end of the physical line. */
  lineMarkers: readonly string[]
  /** True when `( … )` is a comment. */
  parenthesized: boolean
  /** The `(prefix, suffix)` pairs a definition of this dialect may declare. */
  pairs: readonly { prefix: string, suffix: string }[]
  /** A marker a single-command field may carry in front of its command. */
  commandMarker: string | null
}

const COMMENT_SYNTAX: Readonly<Record<CommentDialect, CommentSyntax>> = {
  gcode: {
    lineMarkers: [';'],
    parenthesized: true,
    pairs: [{ prefix: '(', suffix: ')' }, { prefix: ';', suffix: '' }],
    // G-code command fields are bare commands. The ShopBot exception below
    // exists because its G-code words are written as comments in the bundled
    // definition, for a build that predates `outputDialect`.
    commandMarker: null,
  },
  opensbp: {
    lineMarkers: ["'"],
    parenthesized: false,
    pairs: [{ prefix: "'", suffix: '' }],
    commandMarker: "'",
  },
}

/** The dialect a definition exports; a definition without the field is G-code. */
function commentDialectOf(outputDialect: string | undefined): CommentDialect {
  return outputDialect === 'opensbp' ? 'opensbp' : 'gcode'
}

/** One refused template: the field it lives in and why. */
export interface TemplateRuleViolation {
  path: Array<string | number>
  message: string
}

/**
 * One template line that breaks its class rule (#1119).
 *
 * The schema reports these as issues; the machine editor, the export dialog
 * and the load warning read them directly so the user can see *which* line of
 * *which* field breaks *which* rule. A definition that still breaks a rule is
 * kept — never rewritten and never dropped — and export refuses it.
 */
export interface MachineTemplateDiagnostic {
  /** Schema path of the field carrying the text, e.g. `['program','header',3]`. */
  path: Array<string | number>
  /** The path as a person reads it: `program.header[3]`. */
  field: string
  /** One-based line within the field's text. */
  line: number
  /** The offending line exactly as stored. */
  text: string
  /** The word, placeholder or marker the rule refused. */
  word: string
  /** The rule's human name (`program header`, `units template`, …). */
  rule: string
  /** One sentence naming the field, line, offending text and rule. */
  message: string
}

interface TemplateField {
  path: Array<string | number>
  text: string
  rule: TemplateRule
  /** Rendered lines that precede this field's text in the same template array. */
  lineOffset: number
}

/**
 * `G`/`M` commands a program header may spell (before the first move). The
 * non-modal state that does not move: plane, units, distance, feed mode, cutter
 * compensation cancel, work-coordinate select, path control, cycle cancel,
 * offset reset and constant-surface-speed cancel. `G43`/`G44` apply an offset
 * and `G91` changes the distance mode, so neither is here.
 *
 * Two #1119 forms are safe before the first move and are allowed:
 *
 * - a bare `G0`/`G00` with no axis word: it selects the rapid motion mode and
 *   moves nothing, and the word loop still refuses an axis word on the same
 *   line (`G0 Z-2`);
 * - `G91.1`, arc centres relative to the start, which is exactly how the
 *   emitter writes I/J (`arcFitting.ts`: `i = center.x - segStart.x`). `G90.1`
 *   would make every emitted arc use absolute centres and `G91` would change
 *   where every following move lands, so neither is here.
 */
const HEADER_G_COMMANDS: ReadonlySet<string> = new Set([
  'G0', 'G4', 'G17', 'G20', 'G21', 'G40', 'G49', 'G54', 'G55', 'G56', 'G57',
  'G58', 'G59', 'G61', 'G64', 'G80', 'G90', 'G91.1', 'G92.1', 'G94', 'G97',
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

/**
 * A material/THC output command (LinuxCNC M62–M67, QtPlasmaC M190/M191).
 *
 * LinuxCNC defines the handshake words:
 *
 * - `M62`-`M65` (digital outputs) take a digital output number as a `P` word:
 *   https://linuxcnc.org/docs/2.9/html/gcode/m-code.html#mcode:m62-m65
 * - `M66` (wait on input) takes a digital `P` number or an analog `E` number,
 *   the wait mode `L`, and the timeout `Q`:
 *   https://linuxcnc.org/docs/2.9/html/gcode/m-code.html#mcode:m66
 * - `M67` (synchronized analog output) takes an analog `E` number and `Q`:
 *   https://linuxcnc.org/docs/2.9/html/gcode/m-code.html#mcode:m67
 *
 * QtPlasmaC's automatic material handling uses `M190 Pn`, then the
 * `M66 P3 L3 Qn` wait, then the cut-feed expression:
 * https://linuxcnc.org/docs/2.9/html/plasma/qtplasmac.html#plasma:material-handling
 */
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

/**
 * The parameter letters each material/THC command defines, so a word cannot
 * be borrowed from a different command. `M190 Pn` selects a QtPlasmaC
 * material; `P-1` returns to the default material
 * (https://linuxcnc.org/docs/2.9/html/plasma/qtplasmac.html#plasma:material-handling).
 *
 * A parameter word always carries its value, never a bare letter. `Q` is a
 * real number on `M66` (a timeout in seconds) and `M67` (the analog value to
 * set); every other word is an integer.
 */
const MATERIAL_COMMAND_LETTERS: Readonly<Record<string, ReadonlySet<string>>> = {
  M62: new Set(['P']),
  M63: new Set(['P']),
  M64: new Set(['P']),
  M65: new Set(['P']),
  M66: new Set(['P', 'L', 'Q', 'E']),
  M67: new Set(['E', 'Q']),
  M190: new Set(['P']),
  M191: new Set(['P']),
}

/**
 * True when `value` is one of the words `command` defines for `letter`.
 *
 * LinuxCNC's `Q` is a seconds timeout on `M66` and the analog value on `M67`,
 * so it accepts a decimal (https://linuxcnc.org/docs/2.9/html/gcode/m-code.html#mcode:m66,
 * https://linuxcnc.org/docs/2.9/html/gcode/m-code.html#mcode:m67). The digital
 * or analog number (`P`, `E`), the wait mode (`L`) and the QtPlasmaC material
 * number are integers.
 */
function isMaterialParameter(command: string, letter: string, value: string | undefined): boolean {
  if (value === undefined || !MATERIAL_COMMAND_LETTERS[command]?.has(letter)) return false
  const real = (command === 'M66' || command === 'M67') && letter === 'Q'
  return (real ? /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/ : /^[-+]?\d+$/).test(value)
}

/**
 * The one controller-owned feed expression a material template may contain.
 *
 * QtPlasmaC's Automatic Material Handling section documents it as the way to
 * cut at the selected material's feed rate:
 * `F#<_hal[plasmac.cut-feed-rate]>`
 * https://linuxcnc.org/docs/2.9/html/plasma/qtplasmac.html#plasma:material-handling
 *
 * No other HAL pin, macro variable or arithmetic expression is accepted: this
 * is the only parameter use the material-feed template has. G-code letters are
 * case-insensitive, so the leading `F` is matched in either case; the HAL pin
 * name is exact.
 */
const MATERIAL_FEED_EXPRESSION = 'F#<_hal[plasmac.cut-feed-rate]>'

/**
 * The torch command words. A torch on/off template is nothing else.
 *
 * QtPlasmaC's Multiple Tools section defines the `$` selector: tool 0 is the
 * plasma torch, 1 the scribe and 2 the spotting torch, and `M5 $-1` stops all
 * tools. The manual permits `$-1` *in lieu of* the `M5 $n` codes only, so the
 * sign belongs to the stop command; `$0`/`$1`/`$2` are the starting commands'
 * own selectors:
 * https://linuxcnc.org/docs/2.9/html/plasma/qtplasmac.html#plasma:multi-tool
 *
 * The Mandatory Codes section keeps `M3 S1` and `M5` with no selector valid
 * for a cutting job: https://linuxcnc.org/docs/2.9/html/plasma/qtplasmac.html
 */
const TORCH_COMMANDS: ReadonlySet<string> = new Set(['M3', 'M4', 'M5'])

/** The spindle numbers QtPlasmaC's Multiple Tools section documents. */
const TORCH_TOOL_NUMBERS: ReadonlySet<string> = new Set(['0', '1', '2'])

/**
 * True when `value` is a `$` selector QtPlasmaC documents for `command`.
 *
 * `$-1` stops every tool and is valid only on `M5`; 0, 1 and 2 are the torch,
 * scribe and spotting tools. Any other spindle number is not documented and a
 * sign or decimal is not a spindle number at all.
 */
function isTorchSelector(command: string, value: string | undefined): boolean {
  if (value === undefined) return false
  if (value === '-1') return command === 'M5'
  return TORCH_TOOL_NUMBERS.has(value)
}

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

/**
 * A numeric placeholder that may be the value of a fixed word letter.
 *
 * The letter list is deliberately short: the value has to be safe as that
 * word in every template class that accepts the letter. `toolNumber` may be a
 * `T` word anywhere the class accepts one, but an `H` offset only in a
 * tool-change/footer template, which the emitter restarts after or the program
 * ends in. A placeholder that is not here is comment-only (`date`, `units`,
 * `operationIndex`, `operationKind`, `operationPass`, `operationTarget`): it
 * renders text or a number that no word letter may carry.
 *
 * Codex review of #1057 slice H, finding 2: `M{toolNumber}` used to expand to
 * `M1` for validation and to `M6` for the sixth tool.
 */
function placeholderWordLetters(key: string, rule: TemplateRule): readonly string[] {
  switch (key) {
    case 'toolNumber':
      return rule.kind === 'tool-change' ? ['T', 'H'] : ['T']
    case 'rpm':
      return ['S']
    case 'feed':
    case 'plungeFeed':
      return ['F']
    case 'materialNumber':
      return ['P']
    default:
      return []
  }
}

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

/**
 * A regex that matches `core` alone, with the dialect's command marker
 * optional (ShopBot's apostrophe, which comments out the G-code words of a
 * `.sbp` definition). The marker comes from the dialect, never from the
 * definition's `commentPrefix` field.
 */
function commandPattern(command: CommandField, syntax: CommentSyntax): RegExp {
  const marker = syntax.commandMarker !== null
    ? `(?:${syntax.commandMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*)?`
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
  { path: ['plasma', 'materialFeedCommand'], class: template({ kind: 'material-feed' }) },
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
  { path: ['program', 'commentPrefix'], class: { kind: 'comment-syntax' } },
  { path: ['program', 'commentSuffix'], class: { kind: 'comment-syntax' } },

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

  { path: ['toolChange', 'commands'], array: true, class: template({ kind: 'tool-change' }) },
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
 * One program line with the *dialect's* comments removed: a `( … )` comment in
 * G-code, and everything from a line-comment marker (`;` in G-code, `'` in a
 * ShopBot part file) to the end of the line. Code after a parenthesised
 * comment is still code, which is why a line is never skipped just because it
 * starts with one.
 *
 * The markers come from the dialect, never from the definition's
 * `commentPrefix` field: a definition that could choose its own marker could
 * hide executable words behind it (Codex review of #1057 slice H, finding 1).
 */
function lineCode(line: string, syntax: CommentSyntax): string {
  let code = syntax.parenthesized ? line.replace(/\([^)]*\)/g, ' ') : line
  for (const marker of syntax.lineMarkers) {
    const at = code.indexOf(marker)
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
  syntax: CommentSyntax,
  options: ScanOptions,
): { words: ScannedWord[] } | { word: string } {
  let code = lineCode(line, syntax).trim()
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
  // it names no axis. QtPlasmaC's selector is a LinuxCNC spindle number:
  // `$0`, `$1`, `$2` … or `$-1` for all tools. It stays in the scan as a `$`
  // word so the torch rule can judge it against the command before it; every
  // other `$` (a system command, a macro variable, `$+1`, `$-2`, a decimal) is
  // refused by the character check or the word scan.
  for (const character of options.allowSelectors ? ['#', '[', ']', '='] : ['#', '[', ']', '$', '=']) {
    if (code.includes(character)) return { word: character }
  }

  const words: ScannedWord[] = []
  let at = 0
  for (const match of code.matchAll(/\$(-?\d+)|([A-Za-z])\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))?/g)) {
    const start = match.index ?? at
    // Anything between two words that is not whitespace is not a known word.
    if (start !== at && code.slice(at, start).trim().length > 0) {
      return { word: code.slice(at, start).trim() }
    }
    at = start + match[0].length
    if (match[1] !== undefined) {
      words.push({ letter: '$', value: match[1] })
      continue
    }
    const letter = match[2].toUpperCase()
    if (match[3] === undefined) return { word: letter }
    words.push({ letter, value: match[3] })
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

/** Why a line was refused: a word, or one of the placeholder mistakes. */
type LineRefusalKind =
  | 'word'
  | 'user-placeholder'
  | 'unknown-placeholder'
  | 'misplaced-placeholder'

interface LineRefusal {
  word: string
  kind: LineRefusalKind
}

/** True when `at` is the start of a word: line start, whitespace or block delete. */
function startsWord(code: string, at: number): boolean {
  if (at <= 0) return true
  const before = code[at - 1]
  return /\s/.test(before) || before === '/'
}

/** True when `at` ends a word: end of code or whitespace. */
function endsWord(code: string, at: number): boolean {
  const after = code[at]
  return after === undefined || /\s/.test(after)
}

/**
 * True when `at` starts a word in run-together G-code. A letter begins a new
 * word as soon as the previous word's value ends (`Z0.8000H1` is a Z word and
 * an H word), because a word is a letter plus its value and needs no
 * whitespace after the number. Line start, whitespace and block delete remain
 * boundaries, so `#T{…}` is still not a `T` word.
 */
function startsJoinedWord(code: string, at: number): boolean {
  if (startsWord(code, at)) return true
  return /[0-9.]/.test(code[at - 1] ?? '')
}

/**
 * True when `at` ends a word in run-together G-code: the next word's letter
 * starts a new word (`T1M6` ends the T word at the M), while a digit, sign or
 * dot continues the same value (`T15`) and is not a word end.
 */
function endsJoinedWord(code: string, at: number): boolean {
  return endsWord(code, at) || /[A-Za-z]/.test(code[at] ?? '')
}

/**
 * A placeholder in *code* that the emitter cannot safely fill.
 *
 * - Operator text may close a comment or start a new line, so it may only be
 *   written inside one.
 * - A numeric placeholder may only be the value of a fixed word letter
 *   (`T{toolNumber}`, `H{toolNumber}` in a tool change, `S{rpm}`, `F{feed}`,
 *   `P{materialNumber}`). It may end a word where the next word begins
 *   (`T{toolNumber}M6`) and may itself follow a completed word
 *   (`G43Z0.8000H{toolNumber}`), but it may never be the number of a `G` or
 *   `M` word, may never be joined to a following value (`T{toolNumber}5`), and
 *   any other position is forbidden. `M{toolNumber}` therefore cannot validate
 *   as `M1` and emit `M6` (Codex review of #1057 slice H, finding 2; #1119
 *   relaxed only the word-adjacency half).
 * - `{unitsCommand}`/`{wcsCommand}` expand to whole commands, so they must
 *   occupy a whole word too.
 * - An unknown placeholder is refused.
 *
 * Comments are removed first: inside one every placeholder is harmless.
 */
function placeholderRefusal(
  line: string,
  rule: TemplateRule,
  syntax: CommentSyntax,
): LineRefusal | null {
  const code = lineCode(line, syntax)
  for (const match of code.matchAll(/\{(\w+)\}/g)) {
    const key = match[1]
    const whole = match[0]
    const at = match.index ?? 0
    if (USER_TEXT_PLACEHOLDERS.has(key)) {
      return { word: whole, kind: 'user-placeholder' }
    }
    if (key === 'unitsCommand' || key === 'wcsCommand') {
      if (!startsWord(code, at) || !endsWord(code, at + whole.length)) {
        return { word: whole, kind: 'misplaced-placeholder' }
      }
      continue
    }
    if (!NUMERIC_PLACEHOLDERS.has(key)) {
      return { word: whole, kind: 'unknown-placeholder' }
    }
    const letters = placeholderWordLetters(key, rule)
    const letter = at > 0 ? code[at - 1]?.toUpperCase() : undefined
    if (
      letters.length === 0
      || letter === undefined
      || !letters.includes(letter)
      // The fixed letter must itself start a word: `#T{…}` is not a `T` word,
      // while a letter after a completed word's value does start one
      // (`G43Z0.8000H{…}`). The placeholder's value ends where the next
      // word's letter begins (`T{…}M6`), never in the middle of a number.
      || !startsJoinedWord(code, at - 1)
      || !endsJoinedWord(code, at + whole.length)
    ) {
      return { word: whole, kind: 'misplaced-placeholder' }
    }
  }
  return null
}

/**
 * A single-command field is one line and one command. A newline, a carriage
 * return, a semicolon or extra whitespace-separated content is rejected before
 * the pattern is matched, so `feedCommand: "F\nF"` cannot pass one line at a
 * time (Codex review of #1057 slice H, finding 3).
 */
function checkCommandText(text: string, rule: TemplateRule): LineRefusal | null {
  if (rule.kind !== 'command') return null
  if (/[\r\n;]/.test(text)) {
    const offending = text.split(/\r?\n/).find((line) => !rule.pattern.test(line.trim()))
    return { word: (offending ?? text).trim() || '(blank)', kind: 'word' }
  }
  const trimmed = text.trim()
  return rule.pattern.test(trimmed)
    ? null
    : { word: trimmed.length > 0 ? trimmed : '(blank)', kind: 'word' }
}

/**
 * A material feed line is the exact controller-owned expression, optionally
 * followed by a comment. Comments are removed first, so `(loaded)` or
 * `; loaded` after the expression is harmless; anything else — a different
 * HAL pin, an arithmetic expression, an extra word, a bare `F` — is not.
 *
 * G-code letters are case-insensitive, so `f#<_hal[plasmac.cut-feed-rate]>` is
 * the same word; the HAL pin name after the letter is exact.
 */
function checkMaterialFeedLine(line: string, syntax: CommentSyntax): LineRefusal | null {
  const code = lineCode(line, syntax).trim()
  if (code.length === 0) return null
  const normalized = code.slice(0, 1).toUpperCase() + code.slice(1)
  if (normalized === MATERIAL_FEED_EXPRESSION) return null
  return { word: code, kind: 'word' }
}

/**
 * The first word on one line that breaks `rule`, or null when the line is
 * acceptable. `anything` and `tool-change` still check placeholders (operator
 * text may not be written as code anywhere, and a placeholder may not spell a
 * G/M word), but are otherwise unchecked.
 */
function checkTemplateLine(
  line: string,
  rule: TemplateRule,
  syntax: CommentSyntax,
  unitsCommand: string,
  wcsCommand: string,
): LineRefusal | null {
  const placeholder = placeholderRefusal(line, rule, syntax)
  if (placeholder !== null) return placeholder
  if (rule.kind === 'anything' || rule.kind === 'tool-change') return null
  // A command field is one line matched whole: a rapid word, a feed letter, a
  // probe. Nothing about it is free text, so a second word, a newline or a
  // mode change makes the field wrong as a whole.
  if (rule.kind === 'command') return checkCommandText(line, rule)
  if (rule.kind === 'material-feed') return checkMaterialFeedLine(line, syntax)
  const expanded = expandPlaceholders(line, unitsCommand, wcsCommand)
  const scan = scanTemplateLine(expanded, syntax, {
    assignment: rule.kind === 'header',
    allowSelectors: rule.kind === 'torch',
  })
  if ('word' in scan) return { word: scan.word, kind: 'word' }

  let materialCommand: string | null = null
  let torchCommand: string | null = null
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
      case 'torch': {
        if (command !== null) {
          if (!TORCH_COMMANDS.has(command)) return { word: showWord(word), kind: 'word' }
          torchCommand = command
          continue
        }
        // A `$` selector names the spindle the preceding command acts on.
        // `$-1` stops every tool and belongs to M5 alone; `$0`/`$1`/`$2` are
        // the torch, scribe and spotting tools QtPlasmaC documents.
        if (word.letter === '$') {
          if (torchCommand === null || !isTorchSelector(torchCommand, word.value)) {
            return { word: showWord(word), kind: 'word' }
          }
          continue
        }
        if (word.letter !== 'S') return { word: showWord(word), kind: 'word' }
        continue
      }
      case 'material': {
        if (command !== null) {
          if (!MATERIAL_COMMANDS.has(command)) return { word: showWord(word), kind: 'word' }
          materialCommand = command
          continue
        }
        // The command defines which parameter letters it takes, and each one
        // must carry its value: an integer, except `Q` on M66/M67, which
        // LinuxCNC defines as a real number.
        if (materialCommand === null || !isMaterialParameter(materialCommand, word.letter, word.value)) {
          return { word: showWord(word), kind: 'word' }
        }
        continue
      }
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
        hint: 'before the first move only modal setup (including a bare G0/G00 with no axis word, and G91.1), comments, parameter assignments and non-moving M codes are allowed; there is no other motion or axis word here',
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
        hint: 'a torch template may contain only M3, M4 or M5 with an optional S word and a $ selector ($0 torch, $1 scribe, $2 spotting; $-1 stops all tools on M5)',
      }
    case 'material':
      return {
        label: 'material/THC template',
        hint: 'a material/THC template may contain only M62-M67 or M190/M191 output commands and the P/L/Q/E words those commands define (Q may be decimal on M66/M67)',
      }
    case 'material-feed':
      return {
        label: 'material feed template',
        hint: `a material feed template may contain only ${MATERIAL_FEED_EXPRESSION}, optionally followed by a comment`,
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
    case 'tool-change':
      return { label: 'tool-change template', hint: 'this template may contain anything' }
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
function fieldRule(
  fieldClass: StringFieldClass,
  syntax: CommentSyntax,
): TemplateRule | null {
  switch (fieldClass.kind) {
    case 'metadata':
    case 'enum':
    case 'comment-syntax':
      return null
    case 'template':
      return fieldClass.rule
    case 'command': {
      const command = COMMAND_CORES[fieldClass.command]
      return {
        kind: 'command',
        label: command.label,
        pattern: commandPattern(fieldClass.command, syntax),
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
  const syntax = COMMENT_SYNTAX[commentDialectOf(definition.outputDialect)]
  for (const spec of MACHINE_STRING_FIELDS) {
    const rule = fieldRule(spec.class, syntax)
    if (rule === null) continue
    const value = readPath(definition, spec.path)
    if (value === null || value === undefined) continue
    if (spec.array) {
      if (!Array.isArray(value)) continue
      // An array template is written one element per line, so a diagnostic's
      // line is the program line: the index of the element plus any embedded
      // newlines before it (#1119, "header lines 3-4").
      let lineOffset = 0
      value.forEach((text, index) => {
        if (typeof text !== 'string') return
        fields.push({ path: [...spec.path, index], text, rule, lineOffset })
        lineOffset += text.split(/\r?\n/).length
      })
    } else if (typeof value === 'string') {
      fields.push({ path: [...spec.path], text: value, rule, lineOffset: 0 })
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
 * The dialect decides the comment markers, never a caller-supplied prefix.
 */
export function refusedTemplateWords(
  text: string,
  rule: TemplateRule,
  dialect: CommentDialect = 'gcode',
  unitsCommand = 'G21',
  wcsCommand = 'G54',
): string[] {
  const syntax = COMMENT_SYNTAX[dialect]
  if (rule.kind === 'command') {
    const refusal = checkCommandText(text, rule)
    return refusal === null ? [] : [refusal.word]
  }
  const words: string[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const refusal = checkTemplateLine(rawLine, rule, syntax, unitsCommand, wcsCommand)
    if (refusal !== null) words.push(refusal.word)
  }
  return words
}

/** Escape the control characters a refusal word can carry into one line. */
function visibleWord(word: string): string {
  return word
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
}

/**
 * The refusal as a person reads it, naming the field, the one-based line and
 * the rule (#1119). `line` is omitted only by the comment-marker check, which
 * has no lines.
 */
function refusalMessage(
  path: Array<string | number>,
  rule: TemplateRule,
  refusal: LineRefusal,
  line?: number,
): string {
  const field = fieldName(path)
  const where = line === undefined ? field : `${field}: line ${line}`
  const word = visibleWord(refusal.word)
  if (refusal.kind === 'user-placeholder') {
    return `${where}: the placeholder "${word}" may only be used inside a comment; outside one it writes the operator's own text as program code.`
  }
  if (refusal.kind === 'unknown-placeholder') {
    return `${where}: the placeholder "${word}" is not one the emitter fills in; remove it or use a supported placeholder.`
  }
  if (refusal.kind === 'misplaced-placeholder') {
    const key = refusal.word.replace(/^\{/, '').replace(/\}$/, '')
    const letters = placeholderWordLetters(key, rule)
    if (letters.length === 0) {
      return `${where}: the placeholder "${word}" may only be used inside a comment; outside one there is no fixed word letter that can safely carry its value.`
    }
    const list = letters.length === 1
      ? letters[0]
      : `${letters.slice(0, -1).join(', ')} or ${letters[letters.length - 1]}`
    return `${where}: the placeholder "${word}" is not in a position the emitter can fill safely; it may only be the value of the fixed word letter ${list}, never the number of a G or M word and never joined to a following value.`
  }
  const { label, hint } = describeRule(rule)
  return `${where}: the word "${word}" is not allowed in the ${label}; ${hint}.`
}

/** The allowlisted comment forms, spelled for a refusal message. */
function describeCommentPairs(syntax: CommentSyntax): string {
  return syntax.pairs.map((pair) => (
    pair.suffix.length > 0
      ? `${JSON.stringify(pair.prefix)} with ${JSON.stringify(pair.suffix)}`
      : `${JSON.stringify(pair.prefix)} with an empty suffix`
  )).join(', or ')
}

/**
 * The definition's comment markers against the dialect's exact allowlist.
 *
 * The marker is also what the emitter wraps operator text in, so free text
 * there is code injection: `commentPrefix: "G91"` made `spindleOnCW: "G91"`
 * read as a comment and emit executable `G91 S…` (Codex review of #1057 slice
 * H, finding 1). Nothing about the marker may contain a newline, and the pair
 * must be one the dialect actually uses.
 */
function commentSyntaxViolation(
  definition: TemplateRuleDefinition,
  dialect: CommentDialect,
  syntax: CommentSyntax,
): TemplateRuleViolation | null {
  const prefix = definition.program.commentPrefix
  const suffix = definition.program.commentSuffix
  const dialectName = dialect === 'opensbp' ? 'ShopBot' : 'G-code'
  const allowed = describeCommentPairs(syntax)
  const pair = syntax.pairs.find((entry) => entry.prefix === prefix)
  if (pair === undefined) {
    return {
      path: ['program', 'commentPrefix'],
      message: `program.commentPrefix: ${JSON.stringify(prefix)} is not a comment form the ${dialectName} dialect uses; use ${allowed}.`,
    }
  }
  if (pair.suffix !== suffix) {
    return {
      path: ['program', 'commentSuffix'],
      message: `program.commentSuffix: ${JSON.stringify(suffix)} does not close ${JSON.stringify(prefix)}; use ${JSON.stringify(pair.suffix)}.`,
    }
  }
  return null
}

/**
 * Every diagnostic a definition's templates raise (#1119): the template path,
 * the one-based line, the offending text and word, and the rule that was
 * broken. Every offending line is reported, including lines after an embedded
 * newline; a single-line command field is judged whole, exactly as the schema
 * judges it.
 *
 * This is a pure function on a definition and its source of truth is the same
 * walk the schema uses, so export eligibility cannot drift from what the
 * machine editor shows. A definition that still breaks a rule is retained by
 * the loader; this list is what refuses its export until it is fixed.
 */
export function machineTemplateDiagnostics(
  definition: TemplateRuleDefinition,
): MachineTemplateDiagnostic[] {
  const dialect = commentDialectOf(definition.outputDialect)
  const syntax = COMMENT_SYNTAX[dialect]
  const unitsCommand = definition.units.mmCommand ?? definition.units.inchCommand ?? ''
  const wcsCommand = definition.workCoordinates.selectCommand ?? ''
  const diagnostics: MachineTemplateDiagnostic[] = []
  const comment = commentSyntaxViolation(definition, dialect, syntax)
  if (comment !== null) {
    const text = comment.path[1] === 'commentSuffix'
      ? definition.program.commentSuffix
      : definition.program.commentPrefix
    diagnostics.push({
      path: comment.path,
      field: fieldName(comment.path),
      line: 1,
      text,
      word: text,
      rule: 'comment syntax',
      message: comment.message,
    })
  }
  for (const field of templateFields(definition)) {
    const fieldLabel = fieldName(field.path)
    const rule = describeRule(field.rule).label
    const lines = field.text.split(/\r?\n/)
    // A command field is one line and one command: the whole field is judged
    // once, never split into lines that each match on their own. When it does
    // carry an embedded newline every line that breaks the pattern is named
    // with its own line number, and a field whose lines each match but which is
    // still several lines is refused as a whole.
    if (field.rule.kind === 'command') {
      const refusal = checkCommandText(field.text, field.rule)
      if (refusal !== null) {
        if (lines.length > 1) {
          let reported = 0
          lines.forEach((rawLine, index) => {
            const lineRefusal = checkCommandText(rawLine, field.rule)
            if (lineRefusal === null) return
            reported += 1
            diagnostics.push({
              path: field.path,
              field: fieldLabel,
              line: field.lineOffset + index + 1,
              text: rawLine,
              word: lineRefusal.word,
              rule,
              message: refusalMessage(field.path, field.rule, lineRefusal, field.lineOffset + index + 1),
            })
          })
          if (reported > 0) continue
        }
        diagnostics.push({
          path: field.path,
          field: fieldLabel,
          line: field.lineOffset + 1,
          text: field.text,
          word: refusal.word,
          rule,
          message: refusalMessage(field.path, field.rule, refusal, field.lineOffset + 1),
        })
      }
      continue
    }
    lines.forEach((rawLine, index) => {
      const refusal = checkTemplateLine(rawLine, field.rule, syntax, unitsCommand, wcsCommand)
      if (refusal === null) return
      diagnostics.push({
        path: field.path,
        field: fieldLabel,
        line: field.lineOffset + index + 1,
        text: rawLine,
        word: refusal.word,
        rule,
        message: refusalMessage(field.path, field.rule, refusal, field.lineOffset + index + 1),
      })
    })
  }
  return diagnostics
}

/**
 * Every template in the definition that breaks its class rule, one violation
 * per offending line, plus a comment marker that is not one of the dialect's
 * exact forms. The schema turns each into an issue on the field's path, so the
 * editor and machine import can say which template, which line and which word
 * are wrong.
 */
export function templateRuleViolations(definition: TemplateRuleDefinition): TemplateRuleViolation[] {
  return machineTemplateDiagnostics(definition).map(({ path, message }) => ({ path, message }))
}
