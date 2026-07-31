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

import type { AdapterResult, ConversionFinding, SourceAdapter } from '../types'

/**
 * Mastercam `.pst` GPP/MP post-processor definition files. Three sections are
 * genuinely static text:
 *  - a leading block of `# Key           : Value` header-metadata comments;
 *  - a flat section of `name : value #comment` control-switch assignments;
 *  - a positional `name  CODE  #comment` "string select" table (`sgXX`/`smXX`
 *    entries, dereferenced later via `fstrsel <firstEntry> <selectorVar>
 *    <targetVar>`, e.g. `fstrsel sg00 gcode sgcode`) — Mastercam's own literal
 *    lookup from an internal selector value to the G/M-code text it emits.
 * Everything else is the `p*`-prefixed postblocks: named procedures written in
 * Mastercam's own procedural post language, with real control flow
 * (`if`/`else`, nested block calls, functions like `fsg1`/`fsg2`/`newfs`/
 * `frange`). Those are read only far enough to tell which postblocks exist and
 * which use a table entry/literal unconditionally (safe to map) versus which
 * assemble output through conditions on per-operation data this extractor
 * does not evaluate (reported unsupported/omitted) — never executed.
 */

interface HeaderField {
  key: string
  value: string
}

interface SwitchAssignment {
  value: string
  comment: string
  line: number
}

interface TableEntry {
  code: string
  comment: string
  line: number
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/** `# Post Name           : Eding CNC` — a header-comment metadata line.
 *  Requires 2+ spaces before the colon so it never matches an ordinary prose
 *  comment that merely contains a colon (e.g. `#Cantext value:`). */
const HEADER_FIELD_LINE = /^#\s+(.+?)\s{2,}:\s*(.*)$/

/** `arcoutput   : 1     #0 = IJK, 1 = R no sign...` — a flat control switch.
 *  Anchored on a literal `:` with nothing equivalent in the `fmt`/`fs2`/
 *  string-table sections below, which are space-delimited with no colon. */
const SWITCH_LINE = /^(\w+)\s*:\s*(\S+)\s*(#.*)?$/

/** `sg00    G0      #Rapid` — one entry of the `sgXX`/`smXX` string-select
 *  table. Requires the value to look like a literal G/M-code, so this can
 *  never match the `strX "letter"` address-string definitions just above it
 *  in the file, or a table's own bare `sgcode`-style target-variable
 *  declaration line, which has no value at all. */
const TABLE_LINE = /^(s[a-z][a-z0-9_]*)\s+([GM]\d+(?:\.\d+)?)\s*(#.*)?$/

function parseHeaderFields(lines: string[]): HeaderField[] {
  const fields: HeaderField[] = []
  for (const line of lines) {
    const match = HEADER_FIELD_LINE.exec(line)
    if (match) fields.push({ key: match[1].trim(), value: match[2].trim() })
  }
  return fields
}

function parseSwitches(lines: string[]): Map<string, SwitchAssignment> {
  const switches = new Map<string, SwitchAssignment>()
  lines.forEach((line, i) => {
    const match = SWITCH_LINE.exec(line)
    if (match) switches.set(match[1], { value: match[2], comment: match[3] ?? '', line: i + 1 })
  })
  return switches
}

function parseStringTable(lines: string[]): Map<string, TableEntry> {
  const table = new Map<string, TableEntry>()
  lines.forEach((line, i) => {
    const match = TABLE_LINE.exec(line)
    if (match) table.set(match[1], { code: match[2], comment: match[3] ?? '', line: i + 1 })
  })
  return table
}

/** Finds the 0-indexed line where postblock `name` is declared (a bare word
 *  at column 0, e.g. `ptlchg          #Tool change`). Word-boundary anchored
 *  so `psof` doesn't match `psof0`, `peof` doesn't match `peof0`, etc. */
function findProcLine(lines: string[], name: string): number | null {
  const pattern = new RegExp(`^${name}\\b`)
  for (let i = 0; i < lines.length; i += 1) {
    if (pattern.test(lines[i])) return i
  }
  return null
}

/** Scans forward from a postblock's declaration line for a literal substring
 *  (e.g. a quoted `"G80"`) within its body, returning a 1-indexed line number. */
function findLiteralAfter(lines: string[], fromLine: number, literal: string, maxLines = 25): number | null {
  const end = Math.min(lines.length, fromLine + maxLines)
  for (let i = fromLine; i < end; i += 1) {
    if (lines[i].includes(literal)) return i + 1
  }
  return null
}

export const mastercamPstAdapter: SourceAdapter = {
  id: 'mastercam-pst',
  label: 'Mastercam (.pst)',
  fileExtensions: ['pst'],
  staticAnalysisOnly: true,
  convert(fileText: string): AdapterResult {
    const findings: ConversionFinding[] = []
    const lines = normalizeLineEndings(fileText).split('\n')
    const fullText = lines.join('\n')

    const header = parseHeaderFields(lines)
    const switches = parseSwitches(lines)
    const table = parseStringTable(lines)

    const mapped = (sourceField: string, targetField: string | undefined, line: number | undefined, message: string): void => {
      findings.push({
        status: 'mapped',
        sourceField,
        targetField,
        sourceLocation: line !== undefined ? { line } : undefined,
        message,
        blocksStrict: false,
      })
    }
    const omitted = (sourceField: string, targetField: string | undefined, message: string): void => {
      findings.push({ status: 'omitted', sourceField, targetField, message, blocksStrict: false })
    }
    const unsupported = (sourceField: string, targetField: string | undefined, message: string, blocksStrict: boolean): void => {
      findings.push({ status: 'unsupported', sourceField, targetField, message, blocksStrict })
    }

    /** Looks up a string-select table entry and applies its code, or reports
     *  `unsupported` if an entry this post is expected to declare is absent
     *  (a differently-structured Mastercam .pst that renamed/dropped it). */
    const fromTable = (entryName: string, targetField: string, apply: (code: string) => void, extra?: string): void => {
      const entry = table.get(entryName)
      if (!entry) {
        unsupported(entryName, targetField, `Expected string-select table entry "${entryName}" was not found in this source; kept the generic default.`, true)
        return
      }
      apply(entry.code)
      mapped(
        `${entryName} (string-select table)`,
        targetField,
        entry.line,
        `"${entryName}  ${entry.code}  ${entry.comment}" — a literal, positional entry in the sgXX/smXX string-select table, dereferenced later via fstrsel.${extra ? ` ${extra}` : ''}`,
      )
    }

    const overrides: AdapterResult['overrides'] = {
      coordinateSystem: { xAxis: 'X', yAxis: 'Y', zAxis: 'Z' },
      motion: {},
      feedSpeed: {},
      program: {},
      units: {},
    }

    // --- Header metadata + methodology (informational) ---
    const notes: string[] = []
    if (header.length > 0) {
      notes.push(`Header metadata: ${header.map((f) => `${f.key}: ${f.value}`).join('; ')}.`)
    }
    notes.push(
      'Static analysis only: the Mastercam GPP/MP post language\'s procedural postblocks (conditionals, nested block calls, functions like fsg1/fsg2/newfs/frange) were never interpreted or executed. Three purely textual sources were read: the header comment block, the flat "name : value #comment" control-switch section, and the sgXX/smXX string-select table (a positional literal lookup whose target variable, e.g. sgcode, is dereferenced later via *sgcode). Where a table\'s own selector variable (e.g. gcode) is also compared in a postblock\'s "if" conditions elsewhere in this same file (e.g. "if gcode = zero, prapidout"), that comparison was read as corroborating text, never evaluated, to confirm which table slot a PureCutCNC field corresponds to. No comparison whose operands are per-operation/runtime values (tool heights, work-offset index, spindle-direction sign) was resolved to a single answer.',
    )
    notes.push(
      'Postblocks present in source (named, not evaluated): psof/psof0 (start of file / first tool), ptlchg/ptlchg0/ptlchg1002 (toolchange), pwcs (work-offset selection), pretract (retract + spindle stop), peof/peof0 (end of file), prapid/prapidout, plin/plinout, pcir/pcirout, pncoutput (motion dispatch), pdrill, ppeck, pchpbrk, ptap, pbore1, pbore2, pmisc1, pmisc2, pdrlcommonb (canned-cycle dispatch), pcanceldc (cancel canned cycle), pcan/pcan1/pcan2 and pcant_1..pcant_10 (canned-text output), pheader, ptoolcomment, pcomment/pcomment2, pgear, pspindchng, pspindle, pxyzcout, ps_inc_calc/pe_inc_calc.',
    )

    // --- Coordinate system ---
    if (/^fmt\s+X\s+\d+\s+xabs\b/m.test(fullText) && /^fmt\s+Y\s+\d+\s+yabs\b/m.test(fullText) && /^fmt\s+Z\s+\d+\s+zabs\b/m.test(fullText)) {
      mapped('fmt X/Y/Z (position-output address declarations)', 'coordinateSystem', undefined, '"fmt X 2 xabs" / "fmt Y 2 yabs" / "fmt Z 2 zabs" declare standard X/Y/Z address letters with no axis swap or inversion in evidence.')
    }

    // --- Comment delimiters ---
    const parenCommentCount = (fullText.match(/"\("/g) ?? []).length
    if (parenCommentCount >= 2) {
      overrides.program!.commentPrefix = '('
      overrides.program!.commentSuffix = ')'
      mapped(
        '"(" / ")" literal comment wrapping (ptoolcomment, pcomment2, pheader)',
        'program.commentPrefix / program.commentSuffix',
        undefined,
        `A literal "(" ... ")" pair wraps comment/tool-note text in ${parenCommentCount} places; mapped to program.commentPrefix/commentSuffix.`,
      )
    }

    // --- Arc format ---
    const arcoutput = switches.get('arcoutput')
    if (arcoutput) {
      const arcFormat = arcoutput.value === '0' ? 'ij' : 'r'
      overrides.motion!.arcFormat = arcFormat
      mapped(
        'arcoutput',
        'motion.arcFormat',
        arcoutput.line,
        `arcoutput : ${arcoutput.value} ${arcoutput.comment} — mapped to "${arcFormat}". Cross-checked against the parc postblock, which branches "if arcoutput = zero" for I/J/K output and to R (srad/srminus) otherwise.`,
      )
    } else {
      unsupported('arcoutput', 'motion.arcFormat', 'arcoutput control switch not found in this source; kept the generic default.', true)
    }

    // --- Line numbers ---
    const omitseq = switches.get('omitseq')
    if (omitseq) {
      const lineNumbers = omitseq.value.toLowerCase() === 'no'
      overrides.program!.lineNumbers = lineNumbers
      mapped(
        'omitseq',
        'program.lineNumbers',
        omitseq.line,
        `omitseq : ${omitseq.value} ${omitseq.comment} — phrased as "omit", so "${omitseq.value}" means line numbers are ${lineNumbers ? 'ON' : 'OFF'}. No separate increment value was found (only seqmax=9999, a maximum, not a step), which is moot while line numbers are off.`,
      )
    } else {
      unsupported('omitseq', 'program.lineNumbers', 'omitseq control switch not found in this source; kept the generic default.', true)
    }

    // --- Motion commands ---
    fromTable('sg00', 'motion.rapidCommand', (c) => { overrides.motion!.rapidCommand = c }, 'Cross-checked: pncoutput dispatches "if gcode = zero, prapidout" — gcode=0 is exactly the sg00 slot.')
    fromTable('sg01', 'motion.linearCommand', (c) => { overrides.motion!.linearCommand = c }, 'Cross-checked: pncoutput dispatches "if gcode = one, plinout" — gcode=1 is exactly the sg01 slot.')
    fromTable('sg02', 'motion.cwArcCommand', (c) => { overrides.motion!.cwArcCommand = c }, 'Cross-checked: pncoutput dispatches "if gcode > one & gcode < four, pcirout" — gcode=2 is the sg02 slot.')
    fromTable('sg03', 'motion.ccwArcCommand', (c) => { overrides.motion!.ccwArcCommand = c }, 'Same pcirout dispatch; gcode=3 is the sg03 slot.')

    // --- Spindle ---
    fromTable('sm03', 'feedSpeed.spindleOnCW', (c) => { overrides.feedSpeed!.spindleOnCW = c })
    fromTable('sm04', 'feedSpeed.spindleOnCCW', (c) => { overrides.feedSpeed!.spindleOnCCW = c })
    fromTable('sm05', 'feedSpeed.spindleOff', (c) => { overrides.feedSpeed!.spindleOff = c }, 'Corroborated: pretract emits *sm05 unconditionally before a toolchange retract, and pspindchng emits *sm05 whenever spindle direction changes with a nonzero previous speed.')

    // --- Units ---
    fromTable('sg21', 'units.mmCommand', (c) => { overrides.units!.mmCommand = c }, 'Selected by met_tool (per the file header: "Metric is applied from the NCI met_tool variable").')
    fromTable('sg20', 'units.inchCommand', (c) => { overrides.units!.inchCommand = c })

    // --- Feed / speed address letters ---
    if (/^fmt\s+F\s+\d+\s+feed\b/m.test(fullText)) {
      overrides.feedSpeed!.feedCommand = 'F'
      mapped('fmt F ... feed', 'feedSpeed.feedCommand', undefined, '"fmt F 15 feed #Feedrate" declares F as the feedrate address letter.')
    }
    if (/^fmt\s+S\s+\d+\s+speed\b/m.test(fullText)) {
      overrides.feedSpeed!.rpmCommand = 'S'
      mapped('fmt S ... speed', 'feedSpeed.rpmCommand', undefined, '"fmt S 4 speed #Spindle Speed" declares S as the spindle-speed address letter.')
    }

    // --- Feed inline with motion ---
    const plinoutLine = findProcLine(lines, 'plinout')
    if (plinoutLine !== null) {
      const body = lines.slice(plinoutLine, plinoutLine + 4).join(' ')
      if (/pxout/.test(body) && /pyout/.test(body) && /pzout/.test(body) && /,\s*feed\s*,/.test(body)) {
        overrides.feedSpeed!.inlineWithMotion = true
        mapped('plinout', 'feedSpeed.inlineWithMotion', plinoutLine + 1, 'plinout emits pxout, pyout, pzout, and feed via a single pbld call on one output line — feed is written inline with the motion, confirming (not changing) the generic default.')
      }
    }

    // --- Coolant ---
    const coolant: NonNullable<AdapterResult['overrides']['coolant']> = {}
    fromTable('sm08', 'coolant.floodOnCommand', (c) => { coolant.floodOnCommand = c })
    fromTable('sm08_1', 'coolant.mistOnCommand', (c) => { coolant.mistOnCommand = c }, 'Same literal code as sm08 (Coolant Flood) — this source does not distinguish a separate mist output; both flood and mist emit M8.')
    fromTable('sm09', 'coolant.coolantOffCommand', (c) => { coolant.coolantOffCommand = c })
    overrides.coolant = coolant

    // --- Canned cycles ---
    const cannedCycles: NonNullable<AdapterResult['overrides']['cannedCycles']> = {}
    fromTable('sg81', 'cannedCycles.drillCommand', (c) => { cannedCycles.drillCommand = c })
    fromTable('sg81d', 'cannedCycles.drillWithDwellCommand', (c) => { cannedCycles.drillWithDwellCommand = c })
    fromTable('sg83', 'cannedCycles.peckDrillCommand', (c) => { cannedCycles.peckDrillCommand = c })
    fromTable('sg73', 'cannedCycles.chipBreakDrillCommand', (c) => { cannedCycles.chipBreakDrillCommand = c })
    if (/^fmt\s+Q\s+\d+\s+peck1\b/m.test(fullText)) {
      cannedCycles.peckStepWord = 'Q'
      mapped('fmt Q ... peck1', 'cannedCycles.peckStepWord', undefined, '"fmt Q 2 peck1 #First peck increment (positive)" declares Q as the peck-increment address letter.')
    }
    const pcanceldcLine = findProcLine(lines, 'pcanceldc')
    const cancelLine = pcanceldcLine !== null ? findLiteralAfter(lines, pcanceldcLine, '"G80"') : null
    if (cancelLine !== null) {
      cannedCycles.cancelCommand = 'G80'
      mapped('pcanceldc', 'cannedCycles.cancelCommand', cancelLine, 'pcanceldc ("Cancel canned drill cycle") emits a literal "G80". The same literal also appears in psof\'s startup modal-reset triple, "G40", "G49", "G80".')
    } else {
      unsupported('pcanceldc', 'cannedCycles.cancelCommand', 'Could not find a literal "G80" in pcanceldc; kept the fallback default.', false)
    }
    overrides.cannedCycles = cannedCycles

    const sg98 = table.get('sg98')
    const sg99 = table.get('sg99')
    omitted(
      'sg98/sg99 (string-select table) + pdrlcommonb',
      'cannedCycles.retractMode',
      `sg98 (${sg98?.code ?? 'G98'} — ${(sg98?.comment ?? '').replace(/^#/, '')}) and sg99 (${sg99?.code ?? 'G99'} — ${(sg99?.comment ?? '').replace(/^#/, '')}) are both literal, but pdrlcommonb selects between them per operation ("if initht <> refht, drillref = zero #G98 return level / else, drillref = one #G99 return level") by comparing two NCI height values — not resolvable to one post-wide default. Kept the fallback default.`,
    )

    // --- Program end ---
    const peofLine = findProcLine(lines, 'peof')
    const endLine = peofLine !== null ? findLiteralAfter(lines, peofLine, '"M30"') : null
    if (endLine !== null) {
      overrides.stop = { programEndCommand: 'M30' }
      mapped('peof', 'stop.programEndCommand', endLine, 'peof ("End of tool path for non-zero tool") emits a literal "M30" unconditionally.')
    } else {
      unsupported('peof', 'stop.programEndCommand', 'Could not find a literal "M30" in peof; kept the generic default.', false)
    }

    // --- Toolchange sequence: real control flow, not flattened ---
    unsupported(
      'psof / ptlchg (see notes for the full postblock list)',
      'toolChange.commands',
      'psof (start-of-file/first-tool) and ptlchg (steady-state toolchange) compose the actual toolchange sequence through conditional branches (mi1 WCS mode, stagetool, workofs-changed state) and nested calls to pwcs, pgear, pcan/pcan1/pcan2, and pcom_moveb/pcom_movea — control flow this extractor does not evaluate. Literal tokens are visible unconditionally in both (an "M6" tool-select, a "G43" tool-length-comp call), and ptlchg additionally has an unconditional "M01" optional stop before the tool change and a "G92" origin-set in its mi1<=one branch — but the full ordered sequence, and whether a given line is even emitted for a particular job, depends on that control flow. Kept the generic default toolChange.commands rather than guessing an order; verify manually against Mastercam\'s own post documentation.',
      true,
    )
    omitted(
      'psof / ptlchg / pretract / ptlchg1002',
      'toolChange.stopSpindleFirst / toolChange.pauseAfterChange / toolChange.pauseCommand',
      'pretract\'s unconditional spindle stop ("*sm05") runs from the separate ptlchg1002 callback, whose invocation order relative to ptlchg/psof is Mastercam\'s own internal NCI dispatch and is not itself stated in this file\'s text. ptlchg\'s own "M01" optional stop is emitted before the M6 tool-select, not after it, which does not match PureCutCNC\'s post-change pauseAfterChange/pauseCommand semantics. Kept the generic defaults for all three.',
    )

    // --- Work coordinate selection ---
    const pwcsLine = findProcLine(lines, 'pwcs')
    unsupported(
      'pwcs',
      'workCoordinates.selectCommand',
      `pwcs computes "g_wcs = workofs + 54" (G54..G59) for the common case, or "G54.1 P<n>" once workofs reaches 6 — selected dynamically per operation from the work-offset index, not a single fixed literal. This post's configured default (Numbered Question 301: "Work Coordinates [0-1=G92, 2=G54's] (mi1)? 2") is G54-family WCS, and the workofs=0 case computes exactly "G54", matching the kept generic default — but higher work offsets (G55 and up) are not represented.${pwcsLine !== null ? ` See pwcs at line ${pwcsLine + 1}.` : ''}`,
      false,
    )

    // --- Not resolvable / no PureCutCNC field ---
    omitted('fileExtension', 'fileExtension', 'No output NC-file extension is declared in this source text; kept the generic default.')
    omitted(
      'fs2 (numbered format specs) + fmt (address-to-format-spec mapping)',
      'numberFormat.decimalPlaces / numberFormat.trailingZeros / numberFormat.leadingZero',
      'fs2 declares numbered format specs (e.g. "fs2 2   0.4 0.3  #Decimal, absolute, 4/3 place") referenced by fmt address declarations (e.g. "fmt X 2 xabs"), but which of a spec\'s two numbers is inch vs. metric, and the precise meaning of the leading/trailing-zero flags beyond the section legend, are not documented in this file itself. Resolving actual precision would mean assuming an external convention rather than reading it off the page, so this was left at the generic default.',
    )
    omitted(
      'motion / feedSpeed (no explicit modal flag found)',
      'motion.modalMotion / feedSpeed.modalFeedSpeed',
      'No explicit "repeat every line" vs. "modal" flag for coordinate or feed/speed output was found in the flat control-switch section or the string-select table; kept the generic defaults.',
    )
    omitted(
      'sg02/sg03 (string-select table) + breakarcs',
      'motion.arcInterpolation',
      'sg02/sg03 confirm G2/G3 arc commands are used at all, consistent with the generic arcInterpolation=true default. breakarcs=1 causes Mastercam\'s own engine to pre-segment arcs at quadrant boundaries before this post ever sees them, a toolpath-generation behavior, not a change to this flag.',
    )
    omitted(
      'sg17/sg18/sg19, sg28/sg30, sg90/sg91, scc0/scc1/scc2 (string-select table)',
      undefined,
      'Additional table entries with no corresponding PureCutCNC field: sg17/18/19 (G17/G18/G19 work-plane selection — PureCutCNC is XY-plane only), sg28/sg30 (G28/G30 reference-point return), sg90/sg91 (G90/G91 absolute/incremental — not independently configurable in this schema), and scc0/scc1/scc2 (G40/G41/G42 cutter compensation, also literally embedded in psof\'s "G40","G49","G80" reset — PureCutCNC has no cutter-compensation field).',
    )
    omitted(
      'breakarcs, arctype, arccheck/atol/ltol/vtol',
      undefined,
      'Arc segmentation/tolerance switches with no PureCutCNC equivalent: breakarcs (break arcs into quadrants/180°-max arcs before output), arctype (arc-center absolute vs. incremental convention), arccheck/atol/ltol/vtol (tolerance-based small-arc-to-line conversion). motion.arcFormat only distinguishes IJK vs. R (already mapped from arcoutput); these finer-grained behaviors have no target field.',
    )
    omitted(
      'force_wcs, spaces, stagetool, max_speed, min_speed',
      undefined,
      'General output-setting switches with no PureCutCNC equivalent: force_wcs (force WCS re-output at every toolchange), spaces (whitespace between output fields), stagetool (pre-stage the next tool during the current operation), max_speed/min_speed (spindle RPM clamps — a tool/operation-level concern in PureCutCNC, not a machine-definition field).',
    )
    omitted(
      'usecandrill, usecanpeck, usecanchip, usecantap, usecanbore1, usecanbore2, usecanmisc1, usecanmisc2',
      undefined,
      'Per-cycle-type "use the canned G-code cycle vs. output the moves long-hand" enable flags — Mastercam-internal toggles, not G-code letters themselves. The canned-cycle codes they gate were already read directly from the string-select table above (cannedCycles.drillCommand etc.).',
    )
    omitted(
      'pheader / peof',
      'program.header / program.footer',
      'pheader and peof compose program start/end text via comma-separated procedure-call argument lists that mix literal quoted strings with bare variable dereferences (sprogname, date, time) — a different template grammar from the bracket-token-in-a-string-literal blocks the declarative adapters (Visual Mill, Vectric/Estlcam, ArtCAM) use, and not safely flattened into a line array here. The literal "%" start/end markers, the "(...)" comment wrapper, and the unconditional "M30" in peof were still confirmed individually above (program.commentPrefix/commentSuffix, stop.programEndCommand) since those don\'t require flattening the whole call.',
    )
    omitted('(none)', 'program.operationHeader', 'Source has no distinct per-operation header postblock separate from the toolchange sequence; kept the generic default.')

    return { overrides, findings, notes }
  },
}
