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
 * Vectric/Estlcam `.pp` machine output configuration files: top-level
 * `KEY = "value"` assignments, `VAR NAME = [register|flag|prefix|precision]`
 * formatting declarations, and `begin BLOCKNAME` template sections (no
 * explicit end marker — a block runs until the next `begin` or EOF) of
 * double-quoted, `[TOKEN]`-templated G-code lines.
 */

// PureCutCNC placeholders valid in header/operationHeader/footer/toolChange.commands.
const TARGET_TOKENS: Record<string, string> = {
  T: 'toolNumber',
  TOOLNAME: 'toolName',
  TOOLPATH_NAME: 'operationName',
  TP_FILENAME: 'programName',
}

function assignmentMap(assignments: Assignment[]): Map<string, Assignment> {
  const map = new Map<string, Assignment>()
  for (const assignment of assignments) map.set(assignment.key, assignment)
  return map
}

interface VarSpec {
  token: string
  flag: string
  prefix: string
  line: number
}

function parseVarDeclarations(text: string): Map<string, VarSpec> {
  const vars = new Map<string, VarSpec>()
  const lines = text.split('\n')
  const pattern = /^VAR\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\[([^\]]*)\]/
  for (let i = 0; i < lines.length; i += 1) {
    const match = pattern.exec(lines[i].trim())
    if (!match) continue
    const [, name, spec] = match
    const parts = spec.split('|')
    vars.set(name, { token: parts[0] ?? '', flag: parts[1] ?? '', prefix: parts[2] ?? '', line: i + 1 })
  }
  return vars
}

function extractBeginBlocks(text: string): Map<string, { body: string; line: number }> {
  const blocks = new Map<string, { body: string; line: number }>()
  const pattern = /^begin\s+(\S+)\s*$/gm
  const matches = [...text.matchAll(pattern)]
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]
    const start = (match.index ?? 0) + match[0].length
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length
    const line = text.slice(0, match.index ?? 0).split('\n').length
    blocks.set(match[1], { body: text.slice(start, end).trim(), line })
  }
  return blocks
}

function quotedLines(blockBody: string): string[] {
  return blockBody
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = /^"(.*)"$/.exec(line)
      return match ? match[1] : line
    })
}

/** Strips every `[TOKEN]` and returns the remaining literal text — the bare
 *  G/M-code word(s) a single-command block template wraps around its tokens. */
function literalCommand(line: string): string {
  return line.replace(/\[[A-Za-z0-9_]+\]/g, '').replace(/\s+/g, ' ').trim()
}

export const vectricEstlcamAdapter: SourceAdapter = {
  id: 'vectric-estlcam',
  label: 'Vectric / Estlcam (.pp)',
  fileExtensions: ['pp'],
  staticAnalysisOnly: false,
  convert(fileText: string): AdapterResult {
    const findings: ConversionFinding[] = []
    const normalized = normalizeLineEndings(fileText)
    const stripped = stripLineComments(normalized, '+')
    const assignments = assignmentMap(parseAssignments(stripped))
    const vars = parseVarDeclarations(stripped)
    const blocks = extractBeginBlocks(stripped)

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
      numberFormat: {},
    }

    const fileExtension = assignments.get('FILE_EXTENSION')
    if (fileExtension) {
      overrides.fileExtension = fileExtension.value
      mapped(fileExtension, 'fileExtension')
    }

    const lineIncrement = assignments.get('LINE_NUMBER_INCREMENT')
    const anyBlockUsesLineNumber = [...blocks.values()].some((block) => extractBracketTokens(block.body).includes('N'))
    overrides.program!.lineNumbers = anyBlockUsesLineNumber
    if (lineIncrement) {
      if (anyBlockUsesLineNumber) {
        overrides.program!.lineNumberIncrement = Number(lineIncrement.value)
        mapped(lineIncrement, 'program.lineNumberIncrement')
      } else {
        omitted(
          'LINE_NUMBER_INCREMENT',
          'program.lineNumbers',
          'LINE_NUMBER_START/INCREMENT are declared but no move/header/footer block ever emits the [N] token; treated as line numbers disabled for this specific post configuration.',
        )
      }
    }

    const units = assignments.get('UNITS')
    if (units) {
      findings.push({
        status: 'omitted',
        sourceField: 'UNITS',
        targetField: 'units.mmCommand / units.inchCommand',
        sourceLocation: { line: units.line },
        message: `UNITS = "${units.value}" selects which fixed-precision variant of this post to use; it is a post-generator/formatting mode, not an emitted G-code command. No G20/G21 (or equivalent) literal was found in any block, so units.mmCommand/inchCommand kept the generic default — verify the target controller's power-on unit mode.`,
        blocksStrict: false,
      })
    }

    // --- VAR-derived formatting: motion/feed modal flags ---
    const xVar = vars.get('X_POSITION')
    const feedVar = vars.get('FEED_RATE')
    const spindleVar = vars.get('SPINDLE_SPEED')
    if (xVar) {
      overrides.motion!.modalMotion = xVar.flag === 'C'
      findings.push({
        status: 'mapped',
        sourceField: 'VAR X_POSITION',
        targetField: 'motion.modalMotion',
        sourceLocation: { line: xVar.line },
        message: `X_POSITION format flag "${xVar.flag}" ('C' = conditional/modal, 'A' = always output) mapped to motion.modalMotion.`,
        blocksStrict: false,
      })
    }
    if (feedVar) {
      overrides.feedSpeed!.feedCommand = feedVar.prefix
      overrides.feedSpeed!.modalFeedSpeed = feedVar.flag === 'C'
      findings.push({
        status: 'mapped',
        sourceField: 'VAR FEED_RATE',
        targetField: 'feedSpeed.feedCommand / feedSpeed.modalFeedSpeed',
        sourceLocation: { line: feedVar.line },
        message: `Register prefix "${feedVar.prefix}" and modal flag "${feedVar.flag}" mapped.`,
        blocksStrict: false,
      })
      if (spindleVar && spindleVar.flag !== feedVar.flag) {
        findings.push({
          status: 'conflicting',
          sourceField: 'VAR SPINDLE_SPEED',
          targetField: 'feedSpeed.modalFeedSpeed',
          sourceLocation: { line: spindleVar.line },
          message: `SPINDLE_SPEED's modal flag "${spindleVar.flag}" disagrees with FEED_RATE's "${feedVar.flag}"; PureCutCNC has one modal flag covering both, so the feed rate's flag was kept.`,
          blocksStrict: false,
        })
      }
    }
    if (spindleVar) {
      overrides.feedSpeed!.rpmCommand = spindleVar.prefix
      findings.push({
        status: 'mapped',
        sourceField: 'VAR SPINDLE_SPEED',
        targetField: 'feedSpeed.rpmCommand',
        sourceLocation: { line: spindleVar.line },
        message: `Register prefix "${spindleVar.prefix}" mapped to feedSpeed.rpmCommand.`,
        blocksStrict: false,
      })
    }

    // --- Motion blocks ---
    const rapid = blocks.get('RAPID_MOVE')
    const feed = blocks.get('FEED_MOVE') ?? blocks.get('FIRST_FEED_MOVE')
    const cwArc = blocks.get('CW_ARC_MOVE') ?? blocks.get('FIRST_CW_ARC_MOVE')
    const ccwArc = blocks.get('CCW_ARC_MOVE') ?? blocks.get('FIRST_CCW_ARC_MOVE')

    const mapBlockCommand = (block: { body: string; line: number } | undefined, blockName: string, target: string): string | null => {
      if (!block) return null
      const lines = quotedLines(block.body)
      if (lines.length === 0) return null
      const command = leadingLiteral(lines[0])
      if (!command) {
        findings.push({
          status: 'conflicting',
          sourceField: `begin ${blockName}`,
          targetField: target,
          sourceLocation: { line: block.line },
          message: `"${lines[0]}" has no literal command word outside its [TOKEN] placeholders; could not derive ${target}. Kept the generic default.`,
          blocksStrict: true,
        })
        return null
      }
      findings.push({
        status: 'mapped',
        sourceField: `begin ${blockName}`,
        targetField: target,
        sourceLocation: { line: block.line },
        message: `"${lines[0]}" -> ${target} = "${command}".`,
        blocksStrict: false,
      })
      return command
    }

    const rapidCommand = mapBlockCommand(rapid, 'RAPID_MOVE', 'motion.rapidCommand')
    if (rapidCommand) overrides.motion!.rapidCommand = rapidCommand
    const feedCommand = mapBlockCommand(feed, 'FEED_MOVE', 'motion.linearCommand')
    if (feedCommand) overrides.motion!.linearCommand = feedCommand
    const cwCommand = mapBlockCommand(cwArc, 'CW_ARC_MOVE', 'motion.cwArcCommand')
    if (cwCommand) overrides.motion!.cwArcCommand = cwCommand
    const ccwCommand = mapBlockCommand(ccwArc, 'CCW_ARC_MOVE', 'motion.ccwArcCommand')
    if (ccwCommand) overrides.motion!.ccwArcCommand = ccwCommand

    if (cwArc) {
      const tokens = extractBracketTokens(quotedLines(cwArc.body)[0] ?? '')
      const usesIJ = tokens.includes('I') || tokens.includes('J')
      const usesR = tokens.includes('R')
      if (usesIJ && !usesR) {
        overrides.motion!.arcFormat = 'ij'
        findings.push({ status: 'mapped', sourceField: 'begin CW_ARC_MOVE', targetField: 'motion.arcFormat', message: 'Arc template emits I/J tokens; mapped to "ij".', blocksStrict: false })
      } else if (usesR && !usesIJ) {
        overrides.motion!.arcFormat = 'r'
        findings.push({ status: 'mapped', sourceField: 'begin CW_ARC_MOVE', targetField: 'motion.arcFormat', message: 'Arc template emits an R token; mapped to "r".', blocksStrict: false })
      } else {
        findings.push({
          status: 'conflicting',
          sourceField: 'begin CW_ARC_MOVE',
          targetField: 'motion.arcFormat',
          message: 'Could not determine a single I/J-vs-R arc format from the arc template; kept the generic default.',
          blocksStrict: true,
        })
      }
    }

    for (const helicalName of ['CW_HELICAL_ARC_MOVE', 'CCW_HELICAL_ARC_MOVE', 'CW_HELICAL_ARC_PLUNGE_MOVE', 'CCW_HELICAL_ARC_PLUNGE_MOVE']) {
      if (blocks.has(helicalName)) {
        findings.push({
          status: 'mapped',
          sourceField: `begin ${helicalName}`,
          message: 'Z-varying (helical) arc block; uses the same G-code as the plain arc block, already covered by motion.cwArcCommand/ccwArcCommand — not a rotary/4-axis feature.',
          blocksStrict: false,
        })
      }
    }

    // --- Spindle on/off: not declared as VAR/KEY entries, only found inside blocks ---
    const allBlockLines = [...blocks.values()].flatMap((block) => quotedLines(block.body))
    const spindleCW = allBlockLines.find((line) => /^M0?3\b/.test(literalCommand(line)))
    const spindleCCW = allBlockLines.find((line) => /^M0?4\b/.test(literalCommand(line)))
    const spindleOff = allBlockLines.find((line) => /^M0?5\b/.test(literalCommand(line)))
    if (spindleCW) {
      overrides.feedSpeed!.spindleOnCW = literalCommand(spindleCW)
      findings.push({ status: 'mapped', sourceField: `"${spindleCW}"`, targetField: 'feedSpeed.spindleOnCW', message: 'Found in a header/toolchange/segment block.', blocksStrict: false })
    }
    if (spindleOff) {
      overrides.feedSpeed!.spindleOff = literalCommand(spindleOff)
      findings.push({ status: 'mapped', sourceField: `"${spindleOff}"`, targetField: 'feedSpeed.spindleOff', message: 'Found in a header/toolchange/segment block.', blocksStrict: false })
    }
    if (spindleCCW) {
      overrides.feedSpeed!.spindleOnCCW = literalCommand(spindleCCW)
      findings.push({ status: 'mapped', sourceField: `"${spindleCCW}"`, targetField: 'feedSpeed.spindleOnCCW', message: 'Found in a header/toolchange/segment block.', blocksStrict: false })
    } else {
      omitted('M04', 'feedSpeed.spindleOnCCW', 'No counter-clockwise spindle command (M04) appears anywhere in source; this post only ever runs the spindle clockwise. Kept the generic default.')
    }

    // --- Header / toolchange split ---
    // Vectric bakes "first tool ready" (spindle stop, retract, prompt, tool
    // change, spindle start) directly into the HEADER block rather than
    // treating it as a distinct toolchange event the way PureCutCNC's
    // postprocessor does (it calls toolChange.commands before every
    // operation, including the first). Everything from the first M03/M05/T
    // command onward is therefore treated as toolchange content; everything
    // before it is the true program preamble.
    const headerBlock = blocks.get('HEADER')
    if (headerBlock) {
      const lines = quotedLines(headerBlock.body)
      // literalCommand() already strips bracket tokens, so only alternatives
      // with no brackets of their own can match here — every observed source
      // opens its toolchange sequence with a spindle stop/start (M03/M05).
      const firstCommandIndex = lines.findIndex((line) => /^M0?[35]\b/.test(literalCommand(line)))
      const preambleLines = firstCommandIndex === -1 ? lines : lines.slice(0, firstCommandIndex)
      const header: string[] = []
      let droppedComments = 0
      for (const line of preambleLines) {
        const { text, unmapped } = translateTokens(line, TARGET_TOKENS)
        if (unmapped.length > 0) {
          droppedComments += 1
          continue
        }
        if (text.trim().length > 0) header.push(text.trim())
      }
      if (header.length > 0) overrides.program!.header = header
      findings.push({
        status: 'mapped',
        sourceField: 'begin HEADER (preamble portion)',
        targetField: 'program.header',
        message: `Translated ${header.length} line(s); dropped ${droppedComments} comment line(s) referencing values with no static PureCutCNC placeholder (stock size, home position, etc.).`,
        blocksStrict: false,
      })
      findings.push({
        status: 'conflicting',
        sourceField: 'begin HEADER',
        targetField: 'program.header',
        message: 'Source header never emits an explicit G90 (absolute) / plane-select / units-mode command — this post relies on the controller\'s power-on defaults. The generic preamble PureCutCNC normally emits was NOT added, to stay faithful to the source; verify the target controller\'s defaults before relying on this converted definition.',
        blocksStrict: true,
      })

      if (firstCommandIndex !== -1) {
        const toolChangeSourceLines = lines.slice(firstCommandIndex)
        const commands: string[] = []
        const unsupportedLines: string[] = []
        let droppedToolchangeComments = 0
        for (const line of toolChangeSourceLines) {
          const { text, unmapped } = translateTokens(line, TARGET_TOKENS)
          const isComment = /^[( ]/.test(text.trim()) && !/^[A-Za-z][0-9]/.test(literalCommand(line))
          if (unmapped.length > 0) {
            if (isComment) {
              droppedToolchangeComments += 1
            } else {
              unsupportedLines.push(line)
            }
            continue
          }
          if (text.trim().length > 0) commands.push(text.trim())
        }
        if (commands.length > 0) {
          overrides.toolChange = { commands }
          findings.push({
            status: 'mapped',
            sourceField: 'begin HEADER (toolchange portion)',
            targetField: 'toolChange.commands',
            message: `Translated to: ${JSON.stringify(commands)}. Dropped ${droppedToolchangeComments} informational comment line(s).`,
            blocksStrict: false,
          })
        }
        if (unsupportedLines.length > 0) {
          findings.push({
            status: 'unsupported',
            sourceField: 'begin HEADER (toolchange portion)',
            targetField: 'toolChange.commands',
            message: `${unsupportedLines.length} toolchange line(s) reference values with no PureCutCNC template placeholder (configured Z-home height, live feed/spindle values, an operator prompt message) and were dropped rather than emitted with leftover source syntax: ${JSON.stringify(unsupportedLines)}.`,
            blocksStrict: true,
          })
        }
      }
    }

    // --- Footer ---
    const footerBlock = blocks.get('FOOTER')
    if (footerBlock) {
      const lines = quotedLines(footerBlock.body)
      const footer: string[] = []
      for (const line of lines) {
        const { text, unmapped } = translateTokens(line, TARGET_TOKENS)
        if (unmapped.length === 0 && text.trim().length > 0) footer.push(text.trim())
      }
      if (footer.length > 0) {
        overrides.program!.footer = footer
        overrides.stop = { programEndCommand: footer.find((line) => /M30/.test(line)) ?? 'M30' }
        findings.push({
          status: 'mapped',
          sourceField: 'begin FOOTER',
          targetField: 'program.footer',
          message: `Translated to: ${JSON.stringify(footer)}.`,
          blocksStrict: false,
        })
      }
    }

    omitted('begin HEADER/TOOLCHANGE', 'coolant', 'No M07/M08/M09-style coolant command found in any block; this post has no in-program coolant control. Kept the generic default.')
    omitted('(none)', 'cannedCycles', 'Source has no CYCLES-style drilling section; drilling is presumably output as plain rapid/feed moves. Kept the generic default.')

    return {
      overrides,
      findings,
      notes: [
        'Vectric/Estlcam .pp files are declarative VAR/block definitions with no expression language; the whole file was parsed, nothing was executed.',
        'The DWELL_MOVE and NEW_SEGMENT blocks were read only to corroborate spindle on/off commands, not converted directly — PureCutCNC has no per-segment/dwell template field.',
      ],
    }
  },
}
