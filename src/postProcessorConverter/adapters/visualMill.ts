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
import { normalizeLineEndings, parseAssignments, stripLineComments, type Assignment } from './textFormat'

/**
 * Visual Mill `.spm` post-processor macro files: `SECTION_Key = value`
 * assignments plus named `SECTION_NameStart` / `SECTION_NameEnd` template
 * blocks whose body lines use `[BRACKET_TOKEN]` placeholders. Declarative
 * throughout — no expression language to avoid executing.
 */

function assignmentMap(assignments: Assignment[]): Map<string, Assignment> {
  const map = new Map<string, Assignment>()
  for (const assignment of assignments) {
    map.set(assignment.key, assignment)
  }
  return map
}

function extractBlock(text: string, blockName: string): string | null {
  const pattern = new RegExp(`${blockName}Start\\n([\\s\\S]*?)\\n${blockName}End`)
  const match = pattern.exec(text)
  return match ? match[1] : null
}

/** Strips the source's own line-numbering/delimiter tokens: PureCutCNC's
 *  `program.lineNumbers`/`lineNumberIncrement` add sequence numbers to every
 *  emitted line generically, and `[DELIMITER]` is just a field separator. */
function stripStructuralTokens(line: string): string {
  return line
    .replace(/\[SEQ_PRECHAR\]/g, '')
    .replace(/\[SEQNUM\]/g, '')
    .replace(/\[DELIMITER\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function translateToolNumber(line: string): string {
  return line.replace(/\[TOOL_NUM\]/g, '{toolNumber}')
}

export const visualMillAdapter: SourceAdapter = {
  id: 'visual-mill',
  label: 'Visual Mill (.spm)',
  fileExtensions: ['spm'],
  staticAnalysisOnly: false,
  convert(fileText: string): AdapterResult {
    const findings: ConversionFinding[] = []
    const stripped = stripLineComments(normalizeLineEndings(fileText), '//')
    const assignments = parseAssignments(stripped)
    const byKey = assignmentMap(assignments)

    const get = (key: string): Assignment | undefined => byKey.get(key)
    const mapped = (source: Assignment | undefined, target: string, note?: string): void => {
      if (!source) return
      findings.push({
        status: 'mapped',
        sourceField: source.key,
        targetField: target,
        sourceLocation: { line: source.line },
        message: note ?? `${source.key} = "${source.value}" mapped to ${target}.`,
        blocksStrict: false,
      })
    }
    const omitted = (target: string, message: string): void => {
      findings.push({ status: 'omitted', sourceField: target, targetField: target, message, blocksStrict: false })
    }

    const overrides: AdapterResult['overrides'] = {
      coordinateSystem: { xAxis: 'X', yAxis: 'Y', zAxis: 'Z' },
      motion: {},
      feedSpeed: {},
      toolChange: {},
      cannedCycles: {},
      coolant: {},
      program: {},
      units: {},
      numberFormat: {},
      workCoordinates: {},
      stop: {},
    }

    // --- General / number formatting ---
    const extension = get('GENERAL_Extension')
    if (extension) {
      overrides.fileExtension = extension.value
      mapped(extension, 'fileExtension')
    }

    const leadingZeros = get('GENERAL_ShowLeadingZeros')
    if (leadingZeros) {
      overrides.numberFormat!.leadingZero = leadingZeros.value !== '0'
      mapped(leadingZeros, 'numberFormat.leadingZero')
    }

    const decimals = get('MOTION_NumOfDecimalPlaces')
    if (decimals) {
      const places = Number(decimals.value)
      overrides.numberFormat!.decimalPlaces = { mm: places, inch: places }
      mapped(
        decimals,
        'numberFormat.decimalPlaces',
        `MOTION_NumOfDecimalPlaces = ${decimals.value} applies to every unit mode in the source (Visual Mill formats under one active GENERAL_Units mode); used for both mm and inch.`,
      )
    }

    const trailingZeros = get('MOTION_ShowMotionTrailingZeros')
    if (trailingZeros) {
      overrides.numberFormat!.trailingZeros = trailingZeros.value !== '0'
      mapped(trailingZeros, 'numberFormat.trailingZeros')
    } else {
      omitted('numberFormat.trailingZeros', 'MOTION_ShowMotionTrailingZeros not present in source; kept generic default.')
    }

    const generalModal = get('GENERAL_ModalGCode')
    const circleModal = get('CIRCLE_Modal')
    if (generalModal) {
      overrides.motion!.modalMotion = generalModal.value === '1'
      mapped(generalModal, 'motion.modalMotion')
    }
    if (circleModal && generalModal && (circleModal.value === '1') !== (generalModal.value === '1')) {
      findings.push({
        status: 'conflicting',
        sourceField: 'CIRCLE_Modal',
        targetField: 'motion.modalMotion',
        sourceLocation: { line: circleModal.line },
        message: `CIRCLE_Modal (${circleModal.value}) disagrees with GENERAL_ModalGCode (${generalModal.value}); PureCutCNC has one modal-motion flag covering both linear and arc moves, so GENERAL_ModalGCode's value was kept and the arc-specific setting was dropped.`,
        blocksStrict: false,
      })
    }

    const modalFeed = get('GENERAL_ModalFeedrate')
    const modalSpindle = get('GENERAL_ModalSpindle')
    if (modalFeed) {
      overrides.feedSpeed!.modalFeedSpeed = modalFeed.value === '1'
      mapped(modalFeed, 'feedSpeed.modalFeedSpeed')
      if (modalSpindle && modalSpindle.value !== modalFeed.value) {
        findings.push({
          status: 'conflicting',
          sourceField: 'GENERAL_ModalSpindle',
          targetField: 'feedSpeed.modalFeedSpeed',
          sourceLocation: { line: modalSpindle.line },
          message: `GENERAL_ModalSpindle (${modalSpindle.value}) disagrees with GENERAL_ModalFeedrate (${modalFeed.value}); PureCutCNC has one modal flag covering both, so the feedrate setting was kept.`,
          blocksStrict: false,
        })
      }
    }

    const commentStart = get('GENERAL_CommentStartChar')
    const commentEnd = get('GENERAL_CommentEndChar')
    if (commentStart) {
      overrides.program!.commentPrefix = commentStart.value
      mapped(commentStart, 'program.commentPrefix')
    }
    if (commentEnd) {
      overrides.program!.commentSuffix = commentEnd.value
      mapped(commentEnd, 'program.commentSuffix')
    }

    const useSequence = get('GENERAL_UseSequencNo')
    if (useSequence) {
      overrides.program!.lineNumbers = useSequence.value === '1'
      mapped(useSequence, 'program.lineNumbers')
    }
    const increment = get('GENERAL_Increment')
    if (increment) {
      overrides.program!.lineNumberIncrement = Number(increment.value)
      mapped(increment, 'program.lineNumberIncrement')
    }

    // --- Units ---
    const inchCode = get('GENERAL_InchCode')
    const metricCode = get('GENERAL_MetricCode')
    if (metricCode) {
      overrides.units!.mmCommand = metricCode.value
      mapped(metricCode, 'units.mmCommand')
    }
    if (inchCode) {
      overrides.units!.inchCommand = inchCode.value
      mapped(inchCode, 'units.inchCommand')
    }

    // --- Motion ---
    const rapid = get('MOTION_RapidMotionCode')
    const linear = get('MOTION_LinearMotionCode')
    if (rapid) {
      overrides.motion!.rapidCommand = rapid.value
      mapped(rapid, 'motion.rapidCommand')
    }
    if (linear) {
      overrides.motion!.linearCommand = linear.value
      mapped(linear, 'motion.linearCommand')
    }

    const cwArc = get('CIRCLE_ClockwiseArcCode')
    const ccwArc = get('CIRCLE_CClockwiseArcCode')
    if (cwArc) {
      overrides.motion!.cwArcCommand = cwArc.value
      mapped(cwArc, 'motion.cwArcCommand')
    }
    if (ccwArc) {
      overrides.motion!.ccwArcCommand = ccwArc.value
      mapped(ccwArc, 'motion.ccwArcCommand')
    }

    const xyArcBlock = extractBlock(stripped, 'CIRCLE_BlockXY')
    if (xyArcBlock) {
      const usesIJ = /\[NEXT_I\]|\[NEXT_J\]/.test(xyArcBlock)
      const usesR = /\[NEXT_R\]/.test(xyArcBlock)
      if (usesIJ && !usesR) {
        overrides.motion!.arcFormat = 'ij'
        findings.push({
          status: 'mapped',
          sourceField: 'CIRCLE_BlockXYStart..End',
          targetField: 'motion.arcFormat',
          message: 'XY arc template emits [NEXT_I][NEXT_J]; mapped to the "ij" arc format.',
          blocksStrict: false,
        })
      } else if (usesR && !usesIJ) {
        overrides.motion!.arcFormat = 'r'
        findings.push({
          status: 'mapped',
          sourceField: 'CIRCLE_BlockXYStart..End',
          targetField: 'motion.arcFormat',
          message: 'XY arc template emits [NEXT_R]; mapped to the "r" arc format.',
          blocksStrict: false,
        })
      } else {
        findings.push({
          status: 'conflicting',
          sourceField: 'CIRCLE_BlockXYStart..End',
          targetField: 'motion.arcFormat',
          message: 'Could not determine a single I/J-vs-R arc format from the XY arc template; kept the generic default. Review CIRCLE_BlockXYStart..End manually.',
          blocksStrict: true,
        })
      }
    }

    const zxArcBlock = extractBlock(stripped, 'CIRCLE_BlockZX')
    const yzArcBlock = extractBlock(stripped, 'CIRCLE_BlockYZ')
    if ((zxArcBlock && zxArcBlock.trim().length > 0) || (yzArcBlock && yzArcBlock.trim().length > 0)) {
      findings.push({
        status: 'unsupported',
        sourceField: 'CIRCLE_BlockZX/BlockYZ',
        message: 'Source defines arc output for the ZX/YZ planes in addition to XY. PureCutCNC only emits XY-plane arcs; non-XY arcs are out of scope.',
        blocksStrict: false,
      })
    }

    const helixSpiral = extractBlock(stripped, 'HELIXSPIRAL_BlockXYHelix')
    if (helixSpiral && helixSpiral.trim().length > 0) {
      findings.push({
        status: 'unsupported',
        sourceField: 'HELIXSPIRAL_*',
        message: 'Source defines dedicated helix/spiral move blocks with no PureCutCNC equivalent; ordinary Z-varying G2/G3 arcs are still represented via motion.cwArcCommand/ccwArcCommand.',
        blocksStrict: false,
      })
    }

    const fourAxis = get('GENERALMOTION_Aaxis')
    if (fourAxis && /\[ROTATION_AXIS\]/.test(stripped)) {
      findings.push({
        status: 'unsupported',
        sourceField: 'GENERALMOTION_* (4-axis rotation block)',
        message: '4-axis rotary motion block present in source. PureCutCNC is 3-axis only; rotary output is out of scope and was not converted.',
        blocksStrict: false,
      })
    }

    // --- Feed / spindle ---
    const feedCode = get('FEEDRATE_Code')
    const spindleCode = get('SPINDLE_Code')
    if (feedCode) {
      overrides.feedSpeed!.feedCommand = feedCode.value
      mapped(feedCode, 'feedSpeed.feedCommand')
    }
    if (spindleCode) {
      overrides.feedSpeed!.rpmCommand = spindleCode.value
      mapped(spindleCode, 'feedSpeed.rpmCommand')
    }
    const spindleCW = get('SPINDLE_ClockwiseRotationCode')
    const spindleCCW = get('SPINDLE_CClockwiseRotationCode')
    const spindleOff = get('SPINDLE_OffCode')
    if (spindleCW) {
      overrides.feedSpeed!.spindleOnCW = spindleCW.value
      mapped(spindleCW, 'feedSpeed.spindleOnCW')
    }
    if (spindleCCW) {
      overrides.feedSpeed!.spindleOnCCW = spindleCCW.value
      mapped(spindleCCW, 'feedSpeed.spindleOnCCW')
    }
    if (spindleOff) {
      overrides.feedSpeed!.spindleOff = spindleOff.value
      mapped(spindleOff, 'feedSpeed.spindleOff')
    }

    findings.push({
      status: 'conflicting',
      sourceField: 'MOTION_LinearBlock / FEEDRATE_Block / SPINDLE_Block',
      targetField: 'feedSpeed.inlineWithMotion',
      message: 'Source defines feed/spindle output as separate block templates from the linear-motion block, suggesting they are not written inline with X/Y/Z on the same line. Kept the generic default (inline) since this cannot be confirmed without running the macro engine; verify sample output.',
      blocksStrict: false,
    })

    // --- Tool change ---
    const toolChangeBlock = extractBlock(stripped, 'TOOLCHANGE_FirstMacro')
    if (toolChangeBlock) {
      const lines = toolChangeBlock
        .split('\n')
        .map((line) => translateToolNumber(stripStructuralTokens(line)))
        .filter((line) => line.length > 0)
      if (lines.length > 0) {
        overrides.toolChange!.commands = lines
        findings.push({
          status: 'mapped',
          sourceField: 'TOOLCHANGE_FirstMacroStart..End',
          targetField: 'toolChange.commands',
          message: `Translated to: ${JSON.stringify(lines)}.`,
          blocksStrict: false,
        })
      }
    }
    omitted('toolChange.stopSpindleFirst', 'No explicit spindle-stop-before-toolchange signal in source; kept generic default.')
    omitted('toolChange.pauseAfterChange', 'No pause/M0 in the toolchange block; kept generic default.')
    omitted('toolChange.pauseCommand', 'No pause/M0 in the toolchange block; kept generic default.')

    // --- Canned cycles ---
    const drill = get('CYCLES_DrillNoDwell')
    const drillDwell = get('CYCLES_DrillDwell')
    const peck = get('CYCLES_Deep')
    const chipBreak = get('CYCLES_BreakChip')
    const peckStepWord = get('CYCLES_IncRegister')
    const cycleOff = get('CYCLES_CycleOff')
    const cannedCycles: NonNullable<AdapterResult['overrides']['cannedCycles']> = {}
    if (drill) {
      cannedCycles.drillCommand = drill.value || null
      mapped(drill, 'cannedCycles.drillCommand')
    }
    if (drillDwell) {
      cannedCycles.drillWithDwellCommand = drillDwell.value || null
      mapped(drillDwell, 'cannedCycles.drillWithDwellCommand')
    }
    if (peck) {
      cannedCycles.peckDrillCommand = peck.value || null
      mapped(peck, 'cannedCycles.peckDrillCommand')
    }
    if (chipBreak) {
      cannedCycles.chipBreakDrillCommand = chipBreak.value || null
      if (chipBreak.value) {
        mapped(chipBreak, 'cannedCycles.chipBreakDrillCommand')
      } else {
        omitted('cannedCycles.chipBreakDrillCommand', 'CYCLES_BreakChip is blank in source (no chip-break cycle configured).')
      }
    }
    if (peckStepWord) {
      cannedCycles.peckStepWord = peckStepWord.value
      mapped(peckStepWord, 'cannedCycles.peckStepWord')
    }
    if (cycleOff) {
      cannedCycles.cancelCommand = cycleOff.value
      mapped(cycleOff, 'cannedCycles.cancelCommand')
    }
    omitted('cannedCycles.retractMode', 'No explicit G98/G99 retract-plane constant found in source cycle templates; kept generic default.')
    overrides.cannedCycles = cannedCycles

    // --- Coolant ---
    const flood = get('MISCELLANEOUS_CoolantFlood')
    const mist = get('MISCELLANEOUS_CoolantMist')
    const coolantOff = get('MISCELLANEOUS_CoolantOff')
    const coolant: NonNullable<AdapterResult['overrides']['coolant']> = {}
    if (flood) {
      coolant.floodOnCommand = flood.value
      mapped(flood, 'coolant.floodOnCommand')
    }
    if (mist) {
      coolant.mistOnCommand = mist.value
      mapped(mist, 'coolant.mistOnCommand')
    }
    if (coolantOff) {
      coolant.coolantOffCommand = coolantOff.value
      mapped(coolantOff, 'coolant.coolantOffCommand')
    }
    overrides.coolant = coolant

    // --- Program header / footer ---
    const startChar = get('GENERAL_StartReadingChar')
    const stopChar = get('GENERAL_StopReadingChar')
    const absCode = get('GENERAL_AbsCode')
    const startupBlock = extractBlock(stripped, 'STARTUP_ProgramCode')
    if (startupBlock) {
      const header: string[] = []
      if (startChar?.value) header.push(startChar.value)
      for (const rawLine of startupBlock.split('\n')) {
        let line = stripStructuralTokens(rawLine)
        line = line.replace(/\[START_CHAR\]/g, '')
        line = line.replace(/\[OUTPUT_UNITS_CODE\]/g, '{unitsCommand}')
        line = line.replace(/\[OUTPUT_MODE_CODE\]/g, absCode?.value ?? '')
        line = line.trim()
        if (line.length > 0) header.push(line)
      }
      if (header.length > 0) {
        overrides.program!.header = header
        findings.push({
          status: 'mapped',
          sourceField: 'STARTUP_ProgramCodeStart..End',
          targetField: 'program.header',
          message: `Translated to: ${JSON.stringify(header)}. [OUTPUT_MODE_CODE] resolved via GENERAL_Mode=${get('GENERAL_Mode')?.value ?? '?'} against GENERAL_AbsCode/GENERAL_IncCode.`,
          blocksStrict: false,
        })
      }
    }

    const endBlock = extractBlock(stripped, 'END_ProgramCode')
    if (endBlock) {
      const footer: string[] = []
      for (const rawLine of endBlock.split('\n')) {
        let line = stripStructuralTokens(rawLine)
        line = line.replace(/\[STOP_CHAR\]/g, stopChar?.value ?? '')
        line = line.trim()
        if (line.length > 0) footer.push(line)
      }
      if (footer.length > 0) {
        overrides.program!.footer = footer
        overrides.stop!.programEndCommand = footer.find((line) => /M30/.test(line)) ?? 'M30'
        findings.push({
          status: 'mapped',
          sourceField: 'END_ProgramCodeStart..End',
          targetField: 'program.footer',
          message: `Translated to: ${JSON.stringify(footer)}.`,
          blocksStrict: false,
        })
      }
    }

    omitted('program.operationHeader', 'Source has no distinct per-operation header block; kept generic default.')
    omitted('workCoordinates.selectCommand', 'Source never selects a work coordinate system explicitly; kept generic default (G54).')

    return {
      overrides,
      findings,
      notes: [
        'Visual Mill .spm files are declarative section/block definitions with no expression language; the whole file was parsed, nothing was executed.',
      ],
    }
  },
}
