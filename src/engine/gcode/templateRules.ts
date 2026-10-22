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
  feedSpeed: {
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
 * `G`/`M` commands an inert template may spell: dwell, compensation and
 * tool-length *cancel*, path control, cycle cancel, and the spindle/coolant/
 * pause/end M codes. Nothing that selects a frame (`G54`–`G59`), applies an
 * offset (`G43`/`G44`/`G41`/`G42`), changes plane/units/distance/feed mode, or
 * selects a cycle.
 */
const INERT_G_COMMANDS: ReadonlySet<string> = new Set([
  'G4', 'G40', 'G49', 'G61', 'G64', 'G80', 'G97',
])
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
  // nothing. Only the header allows one (the bundled QtPlasmaC program number).
  if (options.assignment && /^#\S*\s*=/.test(code)) return { words: [] }
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

/**
 * The first word on one line that breaks `rule`, or null when the line is
 * acceptable. `anything` is never checked: the tool change and the footer may
 * do what they like.
 */
function checkTemplateLine(
  line: string,
  rule: TemplateRule,
  commentPrefix: string,
): string | null {
  if (rule.kind === 'anything') return null
  const scan = scanTemplateLine(line, commentPrefix, {
    parameterExpressions: rule.kind === 'material',
    assignment: rule.kind === 'header',
    allowSelectors: rule.kind === 'torch' || rule.kind === 'material',
  })
  if ('word' in scan) return scan.word

  for (const word of scan.words) {
    const command = commandOf(word)
    switch (rule.kind) {
      case 'header':
        // A bare O-word names the program and the delimiter frames it; both
        // move nothing.
        if (word.letter === 'O' || word.letter === '%') continue
        if (command !== null) {
          const allowed = word.letter === 'G' ? HEADER_G_COMMANDS : HEADER_M_COMMANDS
          if (!allowed.has(command)) return showWord(word)
          continue
        }
        if (AXIS_LETTERS.has(word.letter) || !PARAMETER_LETTERS.has(word.letter)) return showWord(word)
        continue
      case 'inert':
        if (command !== null) {
          const allowed = word.letter === 'G' ? INERT_G_COMMANDS : INERT_M_COMMANDS
          if (!allowed.has(command)) return showWord(word)
          continue
        }
        if (!PARAMETER_LETTERS.has(word.letter)) return showWord(word)
        continue
      case 'units':
        // The units template is its own G20/G21 and nothing else.
        if (word.letter !== 'G' || (command !== 'G20' && command !== 'G21')) return showWord(word)
        continue
      case 'inverse-time-on':
        if (command !== 'G93') return showWord(word)
        continue
      case 'inverse-time-off':
        if (command !== 'G94') return showWord(word)
        continue
      case 'torch':
        if (command !== null) {
          if (!TORCH_COMMANDS.has(command)) return showWord(word)
          continue
        }
        if (word.letter !== 'S') return showWord(word)
        continue
      case 'material':
        if (command !== null) {
          if (!MATERIAL_COMMANDS.has(command)) return showWord(word)
          continue
        }
        if (!MATERIAL_LETTERS.has(word.letter)) return showWord(word)
        continue
      case 'canned-cycle':
        if (command === null || !CANNED_CYCLE_COMMANDS.has(command)) return showWord(word)
        continue
      case 'canned-retract':
        if (command !== 'G98' && command !== 'G99') return showWord(word)
        continue
      case 'canned-cancel':
        if (command !== 'G80') return showWord(word)
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
 * judged by what it becomes. `{unitsCommand}` and `{wcsCommand}` render the
 * definition's own commands; every other placeholder renders a value or a
 * comment's text and cannot move an axis on its own.
 */
function expandPlaceholders(text: string, unitsCommand: string, wcsCommand: string): string {
  return text.replace(/\{(\w+)\}/g, (_placeholder, key: string) => {
    if (key === 'unitsCommand') return unitsCommand
    if (key === 'wcsCommand') return wcsCommand
    return '1'
  })
}

/** Every template field in the definition, with the rule it must satisfy. */
function templateFields(definition: TemplateRuleDefinition): TemplateField[] {
  const fields: TemplateField[] = []
  const add = (path: Array<string | number>, text: string | null, rule: TemplateRule): void => {
    if (text !== null) fields.push({ path, text, rule })
  }
  const addAll = (path: string[], texts: readonly string[], rule: TemplateRule): void => {
    texts.forEach((text, index) => add([...path, index], text, rule))
  }

  addAll(['program', 'header'], definition.program.header, { kind: 'header' })
  addAll(['program', 'operationHeader'], definition.program.operationHeader, { kind: 'inert', label: 'operation header' })
  // The end of the program: nothing follows it, so it may do anything.
  addAll(['program', 'footer'], definition.program.footer, { kind: 'anything' })
  addAll(['toolChange', 'commands'], definition.toolChange.commands, { kind: 'anything' })
  add(['stop', 'programEndCommand'], definition.stop.programEndCommand, { kind: 'anything' })

  add(['units', 'mmCommand'], definition.units.mmCommand, { kind: 'units' })
  add(['units', 'inchCommand'], definition.units.inchCommand, { kind: 'units' })
  add(['workCoordinates', 'selectCommand'], definition.workCoordinates.selectCommand, { kind: 'header' })

  add(['feedSpeed', 'spindleOnCW'], definition.feedSpeed.spindleOnCW, { kind: 'inert', label: 'spindle-on' })
  add(['feedSpeed', 'spindleOnCCW'], definition.feedSpeed.spindleOnCCW, { kind: 'inert', label: 'spindle-on' })
  add(['feedSpeed', 'spindleOff'], definition.feedSpeed.spindleOff, { kind: 'inert', label: 'spindle-off' })
  add(['toolChange', 'pauseCommand'], definition.toolChange.pauseCommand, { kind: 'inert', label: 'pause' })

  const coolant = definition.coolant
  if (coolant !== null) {
    add(['coolant', 'floodOnCommand'], coolant.floodOnCommand, { kind: 'inert', label: 'coolant' })
    add(['coolant', 'mistOnCommand'], coolant.mistOnCommand, { kind: 'inert', label: 'coolant' })
    add(['coolant', 'coolantOffCommand'], coolant.coolantOffCommand, { kind: 'inert', label: 'coolant' })
  }

  const canned = definition.cannedCycles
  if (canned !== null) {
    add(['cannedCycles', 'drillCommand'], canned.drillCommand, { kind: 'canned-cycle' })
    add(['cannedCycles', 'drillWithDwellCommand'], canned.drillWithDwellCommand, { kind: 'canned-cycle' })
    add(['cannedCycles', 'peckDrillCommand'], canned.peckDrillCommand, { kind: 'canned-cycle' })
    add(['cannedCycles', 'chipBreakDrillCommand'], canned.chipBreakDrillCommand, { kind: 'canned-cycle' })
    add(['cannedCycles', 'retractMode'], canned.retractMode, { kind: 'canned-retract' })
    add(['cannedCycles', 'cancelCommand'], canned.cancelCommand, { kind: 'canned-cancel' })
  }

  // `null` means the controller has no inverse-time commands: nothing is
  // written, so there is nothing to hold to a rule.
  const inverseTime = definition.rotary?.inverseTimeFeed ?? null
  if (inverseTime !== null) {
    add(['rotary', 'inverseTimeFeed', 'on'], inverseTime.on, { kind: 'inverse-time-on' })
    add(['rotary', 'inverseTimeFeed', 'off'], inverseTime.off, { kind: 'inverse-time-off' })
  }

  const plasma = definition.plasma
  if (plasma !== undefined) {
    add(['plasma', 'torchOnCommand'], plasma.torchOnCommand, { kind: 'torch' })
    add(['plasma', 'torchOffCommand'], plasma.torchOffCommand, { kind: 'torch' })
    add(['plasma', 'thcOnCommand'], plasma.thcOnCommand ?? null, { kind: 'material' })
    add(['plasma', 'thcOffCommand'], plasma.thcOffCommand ?? null, { kind: 'material' })
    add(['plasma', 'materialSelectCommand'], plasma.materialSelectCommand ?? null, { kind: 'material' })
    add(['plasma', 'materialWaitCommand'], plasma.materialWaitCommand ?? null, { kind: 'material' })
    add(['plasma', 'materialFeedCommand'], plasma.materialFeedCommand ?? null, { kind: 'material' })
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
    const word = checkTemplateLine(line, rule, commentPrefix)
    if (word !== null) words.push(word)
  }
  return words
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
    if (field.rule.kind === 'anything') continue
    const { label, hint } = describeRule(field.rule)
    for (const rawLine of field.text.split(/\r?\n/)) {
      const line = expandPlaceholders(rawLine, unitsCommand, wcsCommand)
      const word = checkTemplateLine(line, field.rule, definition.program.commentPrefix)
      if (word !== null) {
        violations.push({
          path: field.path,
          message: `${fieldName(field.path)}: the word "${word}" is not allowed in the ${label}; ${hint}.`,
        })
        break
      }
    }
  }
  return violations
}
