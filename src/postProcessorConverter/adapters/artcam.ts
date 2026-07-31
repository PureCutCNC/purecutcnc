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
import { extractBracketTokens, leadingLiteral, normalizeLineEndings, parseAssignments, stripLineComments, translateTokens, type Assignment } from './textFormat'

/**
 * ArtCAM `.con` post-processor files: repeated `KEY = "value"` assignment
 * records, no template blocks. A repeated key (`FORMAT`, `START`,
 * `FIRST_TOOLCHANGE`, `TOOLCHANGE`, `END`, ...) builds an ordered array —
 * `parseAssignments` already preserves every occurrence in source order.
 */

const TARGET_TOKENS: Record<string, string> = {
  T: 'toolNumber',
}

function firstOf(assignments: Assignment[], key: string): Assignment | undefined {
  return assignments.find((a) => a.key === key)
}

function allOf(assignments: Assignment[], key: string): Assignment[] {
  return assignments.filter((a) => a.key === key)
}

function literalCommand(line: string): string {
  return line.replace(/\[[A-Za-z0-9_]+\]/g, '').replace(/\s+/g, ' ').trim()
}

/** Translates a sequence of source lines into PureCutCNC template lines,
 *  dropping any line that references a value with no static placeholder. */
function translateLines(lines: string[]): { kept: string[]; dropped: string[] } {
  const kept: string[] = []
  const dropped: string[] = []
  for (const line of lines) {
    const { text, unmapped } = translateTokens(line, TARGET_TOKENS)
    if (unmapped.length > 0) {
      dropped.push(line)
      continue
    }
    if (text.trim().length > 0) kept.push(text.trim())
  }
  return { kept, dropped }
}

export const artcamAdapter: SourceAdapter = {
  id: 'artcam',
  label: 'ArtCAM (.con)',
  fileExtensions: ['con'],
  staticAnalysisOnly: false,
  convert(fileText: string): AdapterResult {
    const findings: ConversionFinding[] = []
    const stripped = stripLineComments(normalizeLineEndings(fileText), ';')
    const assignments = parseAssignments(stripped)

    const mapped = (source: Assignment, target: string, message?: string): void => {
      findings.push({
        status: 'mapped',
        sourceField: source.key,
        targetField: target,
        sourceLocation: { line: source.line },
        message: message ?? `${source.key} = "${source.value}" mapped to ${target}.`,
        blocksStrict: false,
      })
    }
    const omitted = (sourceField: string, target: string, message: string): void => {
      findings.push({ status: 'omitted', sourceField, targetField: target, message, blocksStrict: false })
    }

    const overrides: AdapterResult['overrides'] = {
      coordinateSystem: { xAxis: 'X', yAxis: 'Y', zAxis: 'Z' },
      motion: {},
      feedSpeed: {},
      program: {},
      units: {},
      toolChange: {},
      coolant: {},
    }

    const description = firstOf(assignments, 'DESCRIPTION')
    const notes: string[] = []
    if (description) notes.push(`Source self-description: DESCRIPTION = "${description.value}".`)

    const extension = firstOf(assignments, 'FILE_EXTENSION')
    if (extension) {
      overrides.fileExtension = extension.value
      mapped(extension, 'fileExtension')
    }

    // Line numbering is declared via a FORMAT = [N|...] record but every
    // ArtCAM adapter file seen so far never actually references [N] in a
    // move/toolchange/START/END template — check the whole file, not just one section.
    const usesLineNumberToken = extractBracketTokens(stripped).includes('N')
    overrides.program!.lineNumbers = usesLineNumberToken
    const lineNumStart = firstOf(assignments, 'LINE_NUM_START')
    const lineNumIncrement = firstOf(assignments, 'LINE_NUM_INCREMENT')
    if (lineNumIncrement) {
      if (usesLineNumberToken) {
        overrides.program!.lineNumberIncrement = Number(lineNumIncrement.value)
        mapped(lineNumIncrement, 'program.lineNumberIncrement')
      } else {
        omitted(
          'LINE_NUM_START/LINE_NUM_INCREMENT',
          'program.lineNumbers',
          'LINE_NUM_START/LINE_NUM_INCREMENT are declared but no template ever emits the [N] token; treated as line numbers disabled for this post.',
        )
      }
    }
    void lineNumStart

    // --- Motion ---
    const rapid = firstOf(assignments, 'FIRST_RAPID_RATE_MOVE')
    const linear = firstOf(assignments, 'FIRST_FEED_RATE_MOVE')
    const cwArc = firstOf(assignments, 'FIRST_CW_ARC_MOVE')
    const ccwArc = firstOf(assignments, 'FIRST_CCW_ARC_MOVE')

    const mapMotion = (source: Assignment | undefined, target: string): string | null => {
      if (!source) return null
      const command = leadingLiteral(source.value)
      if (!command) {
        findings.push({
          status: 'conflicting',
          sourceField: source.key,
          targetField: target,
          sourceLocation: { line: source.line },
          message: `"${source.value}" has no literal command word outside its [TOKEN] placeholders; could not derive ${target}. Kept the generic default.`,
          blocksStrict: true,
        })
        return null
      }
      mapped(source, target, `"${source.value}" -> ${target} = "${command}".`)
      return command
    }
    const rapidCommand = mapMotion(rapid, 'motion.rapidCommand')
    if (rapidCommand) overrides.motion!.rapidCommand = rapidCommand
    const linearCommand = mapMotion(linear, 'motion.linearCommand')
    if (linearCommand) overrides.motion!.linearCommand = linearCommand
    const cwCommand = mapMotion(cwArc, 'motion.cwArcCommand')
    if (cwCommand) overrides.motion!.cwArcCommand = cwCommand
    const ccwCommand = mapMotion(ccwArc, 'motion.ccwArcCommand')
    if (ccwCommand) overrides.motion!.ccwArcCommand = ccwCommand

    if (cwArc) {
      const tokens = extractBracketTokens(cwArc.value)
      const usesIJ = tokens.some((t) => /^[ij]$/i.test(t))
      const usesR = tokens.some((t) => /^r(adius)?$/i.test(t))
      if (usesIJ && !usesR) {
        overrides.motion!.arcFormat = 'ij'
        findings.push({ status: 'mapped', sourceField: 'FIRST_CW_ARC_MOVE', targetField: 'motion.arcFormat', message: 'Arc template emits I/J tokens; mapped to "ij".', blocksStrict: false })
      } else if (usesR && !usesIJ) {
        overrides.motion!.arcFormat = 'r'
        findings.push({ status: 'mapped', sourceField: 'FIRST_CW_ARC_MOVE', targetField: 'motion.arcFormat', message: `Arc template emits a Radius token ("${cwArc.value}"); mapped to "r".`, blocksStrict: false })
      } else {
        findings.push({
          status: 'conflicting',
          sourceField: 'FIRST_CW_ARC_MOVE',
          targetField: 'motion.arcFormat',
          message: 'Could not determine a single I/J-vs-R arc format from the arc template; kept the generic default.',
          blocksStrict: true,
        })
      }
    }

    const helical = firstOf(assignments, 'ALLOW_HELICAL_ARCS')
    if (helical) {
      findings.push({
        status: 'mapped',
        sourceField: 'ALLOW_HELICAL_ARCS',
        message: `ALLOW_HELICAL_ARCS = ${helical.value}: arcs may vary Z, using the same G-code already covered by motion.cwArcCommand/ccwArcCommand — not a rotary/4-axis feature.`,
        blocksStrict: false,
      })
    }

    // --- Program header (START) ---
    const startLines = allOf(assignments, 'START').map((a) => a.value)
    if (startLines.length > 0) {
      const { kept, dropped } = translateLines(startLines)
      if (kept.length > 0) overrides.program!.header = kept
      findings.push({
        status: 'mapped',
        sourceField: 'START',
        targetField: 'program.header',
        message: `Translated ${kept.length} of ${startLines.length} line(s) to: ${JSON.stringify(kept)}. Dropped ${dropped.length} line(s) referencing values with no static placeholder (stock size, home position, filename).`,
        blocksStrict: false,
      })

      const commentPrefixLine = kept.find((line) => line.startsWith('('))
      if (commentPrefixLine) {
        overrides.program!.commentPrefix = '('
        overrides.program!.commentSuffix = ')'
        findings.push({ status: 'mapped', sourceField: 'START (inferred)', targetField: 'program.commentPrefix / program.commentSuffix', message: 'Inferred from "(...)" comment usage throughout the file.', blocksStrict: false })
      }

      const unitsLine = startLines.find((line) => /G2[01]/.test(line))
      const unitsAssignment = firstOf(assignments, 'UNITS')
      if (unitsLine && unitsAssignment) {
        const isMetric = unitsAssignment.value.trim().toUpperCase() === 'MM'
        const code = /G21/.test(unitsLine) ? 'G21' : /G20/.test(unitsLine) ? 'G20' : null
        if (code) {
          if (isMetric && code === 'G21') {
            overrides.units!.mmCommand = 'G21'
            findings.push({ status: 'mapped', sourceField: 'START (G21)', targetField: 'units.mmCommand', message: `UNITS = "${unitsAssignment.value}" and a literal G21 in the START sequence.`, blocksStrict: false })
            omitted('UNITS', 'units.inchCommand', 'This post variant is hardcoded to metric (UNITS = "MM"); no inch/G20 command is declared. Kept the generic default.')
          } else if (!isMetric && code === 'G20') {
            overrides.units!.inchCommand = 'G20'
            findings.push({ status: 'mapped', sourceField: 'START (G20)', targetField: 'units.inchCommand', message: `UNITS = "${unitsAssignment.value}" and a literal G20 in the START sequence.`, blocksStrict: false })
            omitted('UNITS', 'units.mmCommand', 'This post variant is hardcoded to inch (UNITS = "INCH"); no metric/G21 command is declared. Kept the generic default.')
          }
        }
      } else {
        omitted('UNITS', 'units.mmCommand / units.inchCommand', 'No literal G20/G21 found in the START sequence; kept the generic default.')
      }
    }

    // --- Tool change (TOOLCHANGE key; FIRST_TOOLCHANGE is a richer once-only variant with no PureCutCNC equivalent) ---
    const toolChangeLines = allOf(assignments, 'TOOLCHANGE').map((a) => a.value)
    if (toolChangeLines.length > 0) {
      const { kept, dropped } = translateLines(toolChangeLines)
      if (kept.length > 0) {
        overrides.toolChange!.commands = kept
        const stopIndex = kept.findIndex((line) => /^M0?5\b/.test(line))
        const changeIndex = kept.findIndex((line) => /^M0?6\b|T\{toolNumber\}/.test(line))
        if (stopIndex !== -1 && changeIndex !== -1) {
          overrides.toolChange!.stopSpindleFirst = stopIndex < changeIndex
          findings.push({
            status: 'mapped',
            sourceField: 'TOOLCHANGE (order)',
            targetField: 'toolChange.stopSpindleFirst',
            message: `Spindle-stop (M5) appears ${stopIndex < changeIndex ? 'before' : 'after'} the M6 tool-select command.`,
            blocksStrict: false,
          })
        }
      }
      findings.push({
        status: 'mapped',
        sourceField: 'TOOLCHANGE',
        targetField: 'toolChange.commands',
        message: `Translated to: ${JSON.stringify(kept)}. Dropped ${dropped.length} line(s) referencing values with no static placeholder (configured home position, tool database description text): ${JSON.stringify(dropped)}.`,
        blocksStrict: false,
      })
      if (dropped.some((line) => /^[A-Za-z][0-9]|^G0? /.test(literalCommand(line)))) {
        findings.push({
          status: 'unsupported',
          sourceField: 'TOOLCHANGE',
          targetField: 'toolChange.commands',
          message: 'The dropped lines include real motion (retract to a configured home position), not just comments — the converted toolchange sequence omits that retract move.',
          blocksStrict: true,
        })
      }
    }
    omitted('FIRST_TOOLCHANGE', 'toolChange.commands', 'FIRST_TOOLCHANGE defines a richer once-per-program variant (includes USER1-4/USER5-8 macro slots and a home-position retract) with no PureCutCNC equivalent; only the steady-state TOOLCHANGE sequence was converted.')

    const userMacros = allOf(assignments, 'FIRST_TOOLCHANGE').filter((a) => /USER[1-8]U/.test(a.value))
    if (userMacros.length > 0) {
      findings.push({
        status: 'unsupported',
        sourceField: 'FIRST_TOOLCHANGE (USER1U..USER8U)',
        message: 'Source references up to 8 operator-definable macro slots (USER1U..USER8U) whose content lives in ArtCAM\'s own project settings, not in this post file. Their content is unknown and was not converted.',
        blocksStrict: false,
      })
    }

    // --- Spindle on/off (not part of the TOOLCHANGE array used for toolChange.commands above:
    // this post restarts the spindle in NEW_SEGMENT_POST_TOOLCHANGE, after coolant, not in TOOLCHANGE itself) ---
    const spindleOnLine = allOf(assignments, 'NEW_SEGMENT_POST_TOOLCHANGE').find((a) => /^M0?3\b/.test(a.value))
    const spindleOffLine = allOf(assignments, 'TOOLCHANGE').find((a) => /^M0?5\b/.test(a.value))
    if (spindleOnLine) {
      // Not leadingLiteral(): the source line is "M3 S[S]" — a trailing " S"
      // register letter for spindle *speed* sits before its own [S] token,
      // which isn't part of the M3 command word itself.
      overrides.feedSpeed!.spindleOnCW = /^M0?\d+/.exec(spindleOnLine.value)?.[0] ?? spindleOnLine.value
      mapped(spindleOnLine, 'feedSpeed.spindleOnCW')
    } else {
      omitted('NEW_SEGMENT_POST_TOOLCHANGE', 'feedSpeed.spindleOnCW', 'No M3-style spindle-start command found; kept the generic default.')
    }
    if (spindleOffLine) {
      overrides.feedSpeed!.spindleOff = leadingLiteral(spindleOffLine.value)
      mapped(spindleOffLine, 'feedSpeed.spindleOff')
    } else {
      omitted('TOOLCHANGE', 'feedSpeed.spindleOff', 'No M5-style spindle-stop command found; kept the generic default.')
    }
    omitted('(none)', 'feedSpeed.spindleOnCCW', 'No M4/counter-clockwise spindle command found anywhere in source; this post only ever runs the spindle clockwise. Kept the generic default.')

    // --- Coolant ---
    const floodLine = allOf(assignments, 'NEW_SEGMENT_POST_TOOLCHANGE').find((a) => /^M0?8\b/.test(a.value))
    const coolantOffLine = allOf(assignments, 'FIRST_TOOLCHANGE').find((a) => /^M0?9\b/.test(a.value))
    const coolant: NonNullable<AdapterResult['overrides']['coolant']> = {}
    if (floodLine) {
      coolant.floodOnCommand = literalCommand(floodLine.value)
      mapped(floodLine, 'coolant.floodOnCommand')
    }
    if (coolantOffLine) {
      coolant.coolantOffCommand = literalCommand(coolantOffLine.value)
      mapped(coolantOffLine, 'coolant.coolantOffCommand')
    }
    if (!floodLine && !coolantOffLine) {
      overrides.coolant = null
    } else {
      overrides.coolant = coolant
      omitted('(none)', 'coolant.mistOnCommand', 'No M07/mist-coolant command found in source; kept the generic default.')
    }

    // --- Program end (END) ---
    const endLines = allOf(assignments, 'END').map((a) => a.value)
    if (endLines.length > 0) {
      const { kept, dropped } = translateLines(endLines)
      if (kept.length > 0) {
        overrides.program!.footer = kept
        overrides.stop = { programEndCommand: kept.find((line) => /M30/.test(line)) ?? 'M30' }
      }
      findings.push({
        status: 'mapped',
        sourceField: 'END',
        targetField: 'program.footer',
        message: `Translated to: ${JSON.stringify(kept)}. Dropped ${dropped.length} line(s) referencing values with no static placeholder (configured home position): ${JSON.stringify(dropped)}.`,
        blocksStrict: false,
      })
    }

    omitted('(none)', 'program.operationHeader', 'Source has no distinct per-operation header record; kept generic default.')
    omitted('(none)', 'workCoordinates.selectCommand', 'Source never selects a work coordinate system explicitly; kept generic default (G54).')
    overrides.cannedCycles = null
    findings.push({
      status: 'unsupported',
      sourceField: '(none)',
      targetField: 'cannedCycles',
      message: 'Source has no canned-drill-cycle records at all; drilling is presumably output as plain rapid/feed moves by this post. Set to null (no canned cycles) rather than guessing G81/G82/G83.',
      blocksStrict: false,
    })

    return { overrides, findings, notes }
  },
}
