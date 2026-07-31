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
import { normalizeLineEndings } from './textFormat'

/**
 * Autodesk HSM/Inventor/Fusion 360 `.cps` post-processor files: real
 * JavaScript written against Autodesk's standardized post-processor "kernel"
 * API (`createFormat`/`createModal`/`createVariable`/`.format(N)`/etc.) — the
 * same well-known idioms across every vendor's Autodesk post. Per issue #402,
 * this source is NEVER executed, `eval`'d, `require`'d, or run as JS in any
 * way: everything below is plain text pattern matching against a handful of
 * specific, well-documented call-site idioms and a flat `properties = {...}`
 * object literal. Anything not matched by one of these narrow patterns is
 * left at the generic default and reported `omitted` rather than guessed.
 */

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length
}

interface TextMatch {
  value: string
  line: number
}

/** Matches a top-level `key = "value";` or `key = IDENTIFIER;` assignment —
 *  the only right-hand-side shapes this adapter parses, never an expression. */
function findAssignment(text: string, key: string): TextMatch | null {
  const pattern = new RegExp(`^${key}\\s*=\\s*(?:"([^"]*)"|([A-Za-z0-9_]+))\\s*;`, 'm')
  const match = pattern.exec(text)
  if (!match) return null
  return { value: match[1] ?? match[2], line: lineAt(text, match.index) }
}

/** Finds the first literal occurrence of `snippet` anywhere in the file —
 *  used for the fixed call-site idioms (`gMotionModal.format(0)`, etc.) that
 *  this DSL family writes identically regardless of vendor. */
function findCallSite(text: string, snippet: string): TextMatch | null {
  const index = text.indexOf(snippet)
  return index === -1 ? null : { value: snippet, line: lineAt(text, index) }
}

interface CpsProperty {
  value: string
  line: number
}

const PROPERTY_LINE = /^\s*(\w+):\s*(.+?),?\s*(\/\/.*)?$/

/**
 * Extracts `properties = { key: value, // comment ... };` into a flat
 * key->value map. Deliberately line-oriented — never a general JS
 * object-literal parser — since every real-world .cps properties block is
 * one simple boolean/number/string literal per line. Lines that don't fit
 * that shape (e.g. an expression value, or `key :` with a space before the
 * colon) are silently skipped rather than mis-parsed.
 */
function extractProperties(text: string): Map<string, CpsProperty> {
  const properties = new Map<string, CpsProperty>()
  const blockStart = /properties\s*=\s*\{/.exec(text)
  if (!blockStart) return properties
  const bodyStart = blockStart.index + blockStart[0].length
  const bodyEnd = text.indexOf('\n};', bodyStart)
  if (bodyEnd === -1) return properties
  const body = text.slice(bodyStart, bodyEnd)
  const bodyStartLine = lineAt(text, bodyStart)
  body.split('\n').forEach((rawLine, offset) => {
    const match = PROPERTY_LINE.exec(rawLine)
    if (!match) return
    const [, key, value] = match
    properties.set(key, { value: value.trim(), line: bodyStartLine + offset })
  })
  return properties
}

/**
 * Slices out the body of `function name(...) { ... }` by brace matching —
 * used only to narrow the search window for a handful of functions whose
 * control flow (a switch/case) determines a literal G/M-code. This is text
 * slicing, not parsing: the body is still only ever searched with further
 * regexes, never evaluated.
 */
function extractFunctionBody(text: string, functionName: string): string | null {
  const marker = new RegExp(`function\\s+${functionName}\\s*\\([^)]*\\)\\s*\\{`)
  const match = marker.exec(text)
  if (!match) return null
  const braceStart = match.index + match[0].length - 1
  let depth = 0
  for (let i = braceStart; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(braceStart + 1, i)
    }
  }
  return null
}

/** Within a switch/case function body, returns the literal M-code assigned
 *  in `caseLabel`'s block (`m = N`), scanning from `case caseLabel:` up to
 *  its own `break;` — good enough for this DSL's flat, non-nested
 *  coolant/command switches, which is all this adapter ever searches. */
function mCodeFromCase(functionBody: string, caseLabel: string): string | null {
  const casePattern = new RegExp(`case ${caseLabel}:([\\s\\S]*?)(?:break;|$)`)
  const caseMatch = casePattern.exec(functionBody)
  if (!caseMatch) return null
  const assign = /\bm\s*=\s*(\d+)/.exec(caseMatch[1])
  return assign ? `M${assign[1]}` : null
}

export const autodeskCpsAdapter: SourceAdapter = {
  id: 'autodesk-cps',
  label: 'Autodesk HSM/Inventor (.cps)',
  fileExtensions: ['cps'],
  staticAnalysisOnly: true,
  convert(rawFileText: string): AdapterResult {
    // Autodesk .cps files are frequently Windows-authored (CRLF); every regex
    // below assumes `\n`, and an unnormalized `\r` breaks `.`/`$` matching in
    // ways that silently swallow trailing comments into captured values.
    const fileText = normalizeLineEndings(rawFileText)
    const findings: ConversionFinding[] = []
    const notes: string[] = [
      'Scanned for known Autodesk post-kernel idioms (createFormat/createModal/.format(N)/properties) via text pattern matching only; the JavaScript in this file was never evaluated, required, or run.',
      "Kernel-level geometry tolerances (tolerance, minimumChordLength, minimumCircularRadius/Sweep, allowHelicalMoves, allowedCircularPlanes) configure the Autodesk CAM engine's own toolpath generation upstream of the post, not G-code emission; PureCutCNC's MachineDefinition has no equivalent concept, so these were not reported as individual findings.",
    ]

    const mapped = (source: string, target: string | undefined, message: string, line?: number): void => {
      findings.push({
        status: 'mapped',
        sourceField: source,
        targetField: target,
        message,
        blocksStrict: false,
        ...(line !== undefined ? { sourceLocation: { line } } : {}),
      })
    }
    const omitted = (source: string, target: string | undefined, message: string): void => {
      findings.push({ status: 'omitted', sourceField: source, targetField: target, message, blocksStrict: false })
    }

    const overrides: AdapterResult['overrides'] = {
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

    // --- 1. Identity & machine-type gate ---
    const extension = findAssignment(fileText, 'extension')
    if (extension) {
      overrides.fileExtension = extension.value
      mapped('extension', 'fileExtension', `extension = "${extension.value}".`, extension.line)
    } else {
      omitted('extension', 'fileExtension', 'No top-level extension = "...", assignment found; kept the generic default.')
    }

    const description = findAssignment(fileText, 'description')
    const vendor = findAssignment(fileText, 'vendor')
    if (description || vendor) {
      omitted(
        'description, vendor',
        undefined,
        `Source declares description = "${description?.value ?? ''}" and vendor = "${vendor?.value ?? ''}"; PureCutCNC's identity fields (id/name/description/vendor) are supplied by the CLI at conversion time, not derived from adapter output, so these were read but not carried into the draft.`,
      )
    }

    const capabilities = findAssignment(fileText, 'capabilities')
    if (!capabilities) {
      findings.push({
        status: 'conflicting',
        sourceField: 'capabilities',
        message: 'No top-level "capabilities = CAPABILITY_...;" assignment found; cannot confirm this post targets a 3-axis mill, so it cannot be treated as safe.',
        blocksStrict: true,
      })
    } else if (capabilities.value !== 'CAPABILITY_MILLING') {
      findings.push({
        status: 'unsupported',
        sourceField: 'capabilities',
        message: `capabilities = ${capabilities.value} — this post targets a machine type other than 3-axis milling (e.g. turning/lathe, or a mill-turn combination). PureCutCNC is mill-only; diameter-mode axes, turret/live-tooling macros, and lathe-specific canned cycles are out of scope. Fields below were still extracted where literally present, for transparency, but this definition should not be used as-is.`,
        blocksStrict: true,
        sourceLocation: { line: capabilities.line },
      })
    } else {
      mapped('capabilities', undefined, 'capabilities = CAPABILITY_MILLING — confirms this post targets a 3-axis mill, the only PureCutCNC-supported machine type.', capabilities.line)
    }

    // --- 2. properties = { ... } ---
    const properties = extractProperties(fileText)

    const useRadius = properties.get('useRadius')
    if (useRadius) {
      const isRadius = useRadius.value === 'true'
      overrides.motion!.arcFormat = isRadius ? 'r' : 'ij'
      mapped('properties.useRadius', 'motion.arcFormat', `useRadius: ${useRadius.value} — arcs are output using ${isRadius ? 'the R word' : 'the I/J/K words'}.`, useRadius.line)
    } else {
      omitted('properties.useRadius', 'motion.arcFormat', 'No useRadius property found; kept the generic default.')
    }

    const showSequenceNumbers = properties.get('showSequenceNumbers')
    if (showSequenceNumbers) {
      overrides.program!.lineNumbers = showSequenceNumbers.value === 'true'
      mapped('properties.showSequenceNumbers', 'program.lineNumbers', `showSequenceNumbers: ${showSequenceNumbers.value} — writeBlock() only prefixes "N" + sequenceNumber when this is true.`, showSequenceNumbers.line)
    } else {
      omitted('properties.showSequenceNumbers', 'program.lineNumbers', 'No showSequenceNumbers property found; kept the generic default.')
    }

    const sequenceNumberIncrement = properties.get('sequenceNumberIncrement')
    if (sequenceNumberIncrement) {
      overrides.program!.lineNumberIncrement = Number(sequenceNumberIncrement.value)
      mapped('properties.sequenceNumberIncrement', 'program.lineNumberIncrement', `sequenceNumberIncrement: ${sequenceNumberIncrement.value}.`, sequenceNumberIncrement.line)
    } else {
      omitted('properties.sequenceNumberIncrement', 'program.lineNumberIncrement', 'No sequenceNumberIncrement property found; kept the generic default.')
    }
    omitted('properties.sequenceNumberStart', undefined, 'sequenceNumberStart has no PureCutCNC equivalent (program.lineNumbers/lineNumberIncrement model an increment, not a starting value); not converted.')

    // --- 3. Number formatting ---
    const xyzFormatMatch = /var\s+xyzFormat\s*=\s*createFormat\(\{decimals:\(unit\s*==\s*MM\s*\?\s*(\d+)\s*:\s*(\d+)\)\}\);/.exec(fileText)
    if (xyzFormatMatch) {
      const mm = Number(xyzFormatMatch[1])
      const inch = Number(xyzFormatMatch[2])
      overrides.numberFormat!.decimalPlaces = { mm, inch }
      mapped('xyzFormat = createFormat({decimals:(unit == MM ? N : M)})', 'numberFormat.decimalPlaces', `xyzFormat decimals resolve to ${mm} for MM and ${inch} for IN.`, lineAt(fileText, xyzFormatMatch.index))
    } else {
      omitted('xyzFormat', 'numberFormat.decimalPlaces', 'Could not find the expected "decimals:(unit == MM ? N : M)" ternary on xyzFormat; kept the generic default.')
    }
    omitted('xyzFormat (forceDecimal / zeropad options)', 'numberFormat.trailingZeros / numberFormat.leadingZero', "xyzFormat's createFormat() options don't declare forceDecimal or zeropad; kept the generic default for both flags.")

    if (/var\s+gFormat\s*=\s*createFormat\(\{prefix:"G",\s*decimals:0\}\);/.test(fileText)) {
      notes.push('gFormat and mFormat both declare decimals:0 with prefix G/M, so every G/M-code extracted below renders as a bare integer word (G0, M6, ...), never with a decimal point.')
    }
    omitted('gMotionModal = createModal(...)', 'motion.modalMotion', "createModal() (vs createFormat()) conventionally suppresses output when a value repeats, but that behavior lives in the Autodesk post-kernel runtime, not in this file's text, so it was not asserted; kept the generic default.")

    // --- 4. Motion codes ---
    const gPrefixMatch = /var\s+gFormat\s*=\s*createFormat\(\{prefix:"([^"]+)"/.exec(fileText)
    const gPrefix = gPrefixMatch ? gPrefixMatch[1] : 'G'

    const rapid = findCallSite(fileText, 'gMotionModal.format(0)')
    if (rapid) {
      overrides.motion!.rapidCommand = `${gPrefix}0`
      mapped('gMotionModal.format(0)', 'motion.rapidCommand', `gMotionModal.format(0) call sites found (e.g. onRapid); rendered as "${gPrefix}0" using gFormat's prefix.`, rapid.line)
    } else {
      omitted('gMotionModal.format(0)', 'motion.rapidCommand', 'No gMotionModal.format(0) call site found; kept the generic default.')
    }

    const linear = findCallSite(fileText, 'gMotionModal.format(1)')
    if (linear) {
      overrides.motion!.linearCommand = `${gPrefix}1`
      mapped('gMotionModal.format(1)', 'motion.linearCommand', `gMotionModal.format(1) call sites found (e.g. onLinear); rendered as "${gPrefix}1".`, linear.line)
    } else {
      omitted('gMotionModal.format(1)', 'motion.linearCommand', 'No gMotionModal.format(1) call site found; kept the generic default.')
    }

    const arc = findCallSite(fileText, 'gMotionModal.format(clockwise ? 2 : 3)')
    if (arc) {
      overrides.motion!.cwArcCommand = `${gPrefix}2`
      overrides.motion!.ccwArcCommand = `${gPrefix}3`
      mapped('gMotionModal.format(clockwise ? 2 : 3)', 'motion.cwArcCommand / motion.ccwArcCommand', `The clockwise-ternary idiom is used inside onCircular; rendered as "${gPrefix}2"/"${gPrefix}3".`, arc.line)
    } else {
      omitted('gMotionModal.format(clockwise ? 2 : 3)', 'motion.cwArcCommand / motion.ccwArcCommand', 'The onCircular clockwise-ternary idiom was not found; kept the generic default.')
    }

    // --- 5. Feed / spindle / tool change ---
    const feedPrefixMatch = /createVariable\(\{prefix:"([^"]+)"\}\s*,\s*feedFormat\)/.exec(fileText)
    if (feedPrefixMatch) {
      overrides.feedSpeed!.feedCommand = feedPrefixMatch[1]
      mapped('feedOutput = createVariable({prefix:"X"}, feedFormat)', 'feedSpeed.feedCommand', `feedOutput's prefix is "${feedPrefixMatch[1]}".`, lineAt(fileText, feedPrefixMatch.index))
    } else {
      omitted('feedOutput createVariable', 'feedSpeed.feedCommand', "Could not find feedOutput's createVariable prefix; kept the generic default.")
    }

    const rpmPrefixMatch = /createVariable\(\{prefix:"([^"]+)",\s*force:true\}\s*,\s*rpmFormat\)/.exec(fileText)
    if (rpmPrefixMatch) {
      overrides.feedSpeed!.rpmCommand = rpmPrefixMatch[1]
      mapped('sOutput = createVariable({prefix:"X", force:true}, rpmFormat)', 'feedSpeed.rpmCommand', `sOutput's prefix is "${rpmPrefixMatch[1]}".`, lineAt(fileText, rpmPrefixMatch.index))
    } else {
      omitted('sOutput createVariable', 'feedSpeed.rpmCommand', "Could not find sOutput's createVariable prefix; kept the generic default.")
    }

    const toolChangeMatch = /writeBlock\("T"\s*\+\s*toolFormat\.format\(tool\.number\),\s*mFormat\.format\((\d+)\)\);/.exec(fileText)
    if (toolChangeMatch) {
      const mCode = `M${toolChangeMatch[1]}`
      overrides.toolChange!.commands = [`T{toolNumber} ${mCode}`]
      mapped('writeBlock("T" + toolFormat.format(tool.number), mFormat.format(N))', 'toolChange.commands', `Tool-change idiom found; translated tool.number to {toolNumber}, giving "T{toolNumber} ${mCode}".`, lineAt(fileText, toolChangeMatch.index))
    } else {
      omitted('writeBlock("T" + toolFormat.format(tool.number), mFormat.format(N))', 'toolChange.commands', 'The standard tool-number/M6 writeBlock idiom was not found in the expected shape; kept the generic default.')
    }

    const stopSpindleMatch = /stop spindle before retract during tool change[\s\S]{0,120}?onCommand\(COMMAND_STOP_SPINDLE\)/.exec(fileText)
    if (stopSpindleMatch) {
      overrides.toolChange!.stopSpindleFirst = true
      mapped('onSection() COMMAND_STOP_SPINDLE gated on insertToolCall', 'toolChange.stopSpindleFirst', 'onSection() explicitly stops the spindle ("stop spindle before retract during tool change") before the retract/tool-change sequence.', lineAt(fileText, stopSpindleMatch.index))
    } else {
      omitted('onSection() (spindle-stop-before-toolchange)', 'toolChange.stopSpindleFirst', 'No explicit spindle-stop-before-toolchange comment/call found; kept the generic default.')
    }
    omitted(
      'properties.optionalStop',
      'toolChange.pauseAfterChange / toolChange.pauseCommand',
      "properties.optionalStop gates an M1 (COMMAND_OPTIONAL_STOP) emitted before the retract/tool-number block, not after it — a different point in the sequence than PureCutCNC's post-M6 pause convention — so it was not mapped; kept the generic default.",
    )

    const spindleMatch = /mFormat\.format\(tool\.clockwise\s*\?\s*(\d+)\s*:\s*(\d+)\)/.exec(fileText)
    if (spindleMatch) {
      overrides.feedSpeed!.spindleOnCW = `M${spindleMatch[1]}`
      overrides.feedSpeed!.spindleOnCCW = `M${spindleMatch[2]}`
      mapped('mFormat.format(tool.clockwise ? N : M)', 'feedSpeed.spindleOnCW / feedSpeed.spindleOnCCW', `Spindle-direction idiom found; CW = "M${spindleMatch[1]}", CCW = "M${spindleMatch[2]}".`, lineAt(fileText, spindleMatch.index))
    } else {
      omitted('mFormat.format(tool.clockwise ? N : M)', 'feedSpeed.spindleOnCW / feedSpeed.spindleOnCCW', 'The clockwise-ternary spindle-direction idiom was not found; kept the generic default.')
    }

    // --- 6. Coolant ---
    const setCoolantBody = extractFunctionBody(fileText, 'setCoolant')
    if (setCoolantBody) {
      const flood = mCodeFromCase(setCoolantBody, 'COOLANT_FLOOD')
      const mist = mCodeFromCase(setCoolantBody, 'COOLANT_MIST')
      const off = mCodeFromCase(setCoolantBody, 'COOLANT_OFF')
      const coolant: NonNullable<AdapterResult['overrides']['coolant']> = {}
      if (flood) {
        coolant.floodOnCommand = flood
        mapped('setCoolant() case COOLANT_FLOOD', 'coolant.floodOnCommand', `case COOLANT_FLOOD writes mFormat.format(m) with m assigned in that case -> "${flood}".`)
      }
      if (mist) {
        coolant.mistOnCommand = mist
        mapped('setCoolant() case COOLANT_MIST', 'coolant.mistOnCommand', `case COOLANT_MIST (fallthrough shared with COOLANT_THROUGH_TOOL/COOLANT_AIR) -> "${mist}".`)
      }
      if (off) {
        coolant.coolantOffCommand = off
        mapped('setCoolant() case COOLANT_OFF', 'coolant.coolantOffCommand', `case COOLANT_OFF -> "${off}".`)
      }
      if (flood || mist || off) {
        overrides.coolant = coolant
      } else {
        overrides.coolant = null
        omitted('setCoolant()', undefined, 'Found a setCoolant() function but could not extract a literal M-code for any coolant case from its switch; not guessing M8/M9, set coolant to null.')
      }
    } else {
      overrides.coolant = null
      omitted('setCoolant()', undefined, 'No setCoolant() function found in the expected shape; set coolant to null rather than guessing M8/M9.')
    }

    // --- 7. Program end ---
    const onCloseBody = extractFunctionBody(fileText, 'onClose')
    const programEndMatch = onCloseBody ? /writeBlock\(mFormat\.format\((\d+)\)\);/.exec(onCloseBody) : null
    if (programEndMatch) {
      overrides.stop!.programEndCommand = `M${programEndMatch[1]}`
      mapped('onClose() writeBlock(mFormat.format(N))', 'stop.programEndCommand', `onClose() writes mFormat.format(${programEndMatch[1]}) (source comment: "stop program, spindle stop, coolant off") -> "M${programEndMatch[1]}".`)
    } else {
      omitted('onClose()', 'stop.programEndCommand', 'Could not find a writeBlock(mFormat.format(N)) call inside onClose(); kept the generic default.')
    }
    omitted('onOpen() / onClose()', 'program.header / program.footer / program.operationHeader', "onOpen()/onClose() are procedural functions with loops and conditionals (tool-table dump, machine-config dump, work-offset warnings), not a static line template like the other adapters' declarative source formats; reconstructing header/footer text would require evaluating control flow, which this adapter deliberately never does. Kept the generic default header/footer.")

    const formatCommentBody = extractFunctionBody(fileText, 'formatComment')
    if (formatCommentBody && formatCommentBody.includes('"("') && formatCommentBody.includes('")"')) {
      overrides.program!.commentPrefix = '('
      overrides.program!.commentSuffix = ')'
      mapped('formatComment()', 'program.commentPrefix / program.commentSuffix', 'formatComment() returns "(" + text + ")".')
    } else {
      omitted('formatComment()', 'program.commentPrefix / program.commentSuffix', 'Could not find the expected "(" + text + ")" literal wrapping in formatComment(); kept the generic default.')
    }

    // --- 8. Canned cycles ---
    const drill = findCallSite(fileText, 'gCycleModal.format(81)')
    const drillDwell = findCallSite(fileText, 'gCycleModal.format(82)')
    const peck = findCallSite(fileText, 'gCycleModal.format(83)')
    const cancel = findCallSite(fileText, 'gCycleModal.format(80)')
    const retract98 = findCallSite(fileText, 'gRetractModal.format(98)')
    const retract99 = findCallSite(fileText, 'gRetractModal.format(99)')

    const cannedCycles: NonNullable<AdapterResult['overrides']['cannedCycles']> = {}
    let foundAnyCycle = false

    if (drill) {
      cannedCycles.drillCommand = 'G81'
      mapped('gCycleModal.format(81)', 'cannedCycles.drillCommand', 'gCycleModal.format(81) used for the "drilling" cycle case (no dwell).', drill.line)
      foundAnyCycle = true
    } else {
      omitted('gCycleModal.format(81)', 'cannedCycles.drillCommand', 'No gCycleModal.format(81) call site found; kept the generic default.')
    }

    if (drillDwell) {
      cannedCycles.drillWithDwellCommand = 'G82'
      mapped('gCycleModal.format(82)', 'cannedCycles.drillWithDwellCommand', 'gCycleModal.format(82) used for the "counter-boring" cycle case when a dwell (P > 0) is present.', drillDwell.line)
      foundAnyCycle = true
    } else {
      omitted('gCycleModal.format(82)', 'cannedCycles.drillWithDwellCommand', 'No gCycleModal.format(82) call site found; kept the generic default.')
    }

    if (peck) {
      cannedCycles.peckDrillCommand = 'G83'
      mapped('gCycleModal.format(83)', 'cannedCycles.peckDrillCommand', 'gCycleModal.format(83) used for the "deep-drilling" cycle case.', peck.line)
      foundAnyCycle = true

      const peckStepMatch = /gCycleModal\.format\(83\)[\s\S]{0,300}?"([A-Za-z])"\s*\+\s*xyzFormat\.format\(cycle\.incrementalDepth\)/.exec(fileText)
      if (peckStepMatch) {
        cannedCycles.peckStepWord = peckStepMatch[1]
        mapped(
          '"Q" + xyzFormat.format(cycle.incrementalDepth) alongside gCycleModal.format(83)',
          'cannedCycles.peckStepWord',
          `Found the literal "${peckStepMatch[1]}" prefix immediately alongside the peck cycle's depth-increment argument — an inline literal, not a declared createVariable register, but unambiguous.`,
          lineAt(fileText, peckStepMatch.index),
        )
      } else {
        omitted('cycle.incrementalDepth prefix', 'cannedCycles.peckStepWord', 'Could not find a literal "<letter>" + ....format(cycle.incrementalDepth) argument next to gCycleModal.format(83); kept the generic default rather than assuming "Q".')
      }
    } else {
      omitted('gCycleModal.format(83)', 'cannedCycles.peckDrillCommand', 'No gCycleModal.format(83) call site found; kept the generic default.')
    }

    cannedCycles.chipBreakDrillCommand = null
    omitted('onCyclePoint case "chip-breaking"', 'cannedCycles.chipBreakDrillCommand', 'The "chip-breaking" case always calls expandCyclePoint(x, y, z) — it synthesizes individual moves rather than emitting a canned-cycle G-code — so there is no chip-break literal to map.')

    if (cancel) {
      cannedCycles.cancelCommand = 'G80'
      mapped('gCycleModal.format(80)', 'cannedCycles.cancelCommand', 'onCycleEnd() calls gCycleModal.format(80) to cancel the active canned cycle.', cancel.line)
      foundAnyCycle = true
    } else {
      omitted('gCycleModal.format(80)', 'cannedCycles.cancelCommand', 'No gCycleModal.format(80) call site found; kept the generic default.')
    }

    if (retract98 && !retract99) {
      cannedCycles.retractMode = 'G98'
      mapped('gRetractModal.format(98)', 'cannedCycles.retractMode', 'Every canned-cycle call site pairs gCycleModal with gRetractModal.format(98); no gRetractModal.format(99) call site exists anywhere in this file.', retract98.line)
      foundAnyCycle = true
    } else if (retract98 && retract99) {
      findings.push({
        status: 'conflicting',
        sourceField: 'gRetractModal.format(98) and gRetractModal.format(99)',
        targetField: 'cannedCycles.retractMode',
        message: "Both gRetractModal.format(98) and .format(99) call sites are present; PureCutCNC's cannedCycles.retractMode is a single fixed value, so it could not be determined which retract plane a given cycle would actually use. Kept the generic default.",
        blocksStrict: false,
      })
    } else {
      omitted('gRetractModal.format(98/99)', 'cannedCycles.retractMode', 'No gRetractModal.format() call site found; kept the generic default.')
    }

    overrides.cannedCycles = foundAnyCycle ? cannedCycles : null

    // --- 9. Work coordinates ---
    const wcsWarningFound = fileText.includes('Using G54 as WCS.')
    const wcsCompositionFound = /gFormat\.format\(53\s*\+\s*workOffset\)/.test(fileText)
    if (wcsWarningFound && wcsCompositionFound) {
      overrides.workCoordinates!.selectCommand = 'G54'
      mapped(
        'onSection() work-offset handling ("Using G54 as WCS." + gFormat.format(53 + workOffset))',
        'workCoordinates.selectCommand',
        'workOffset defaults to 1 when unspecified (source comment: "Using G54 as WCS."), and gFormat.format(53 + workOffset) with workOffset=1 composes to G54.',
      )
    } else {
      omitted('onSection() work-offset handling', 'workCoordinates.selectCommand', 'Could not confidently identify the default/first work-offset code from static reading; kept the generic default.')
    }
    omitted(
      'machineConfiguration (axis mapping)',
      'coordinateSystem',
      'Per-axis mapping/inversion in this post-kernel family is configured via the separate binary machine-configuration object referenced through machineConfiguration.*, not present in the .cps text itself; kept the generic identity X/Y/Z default.',
    )

    // --- 10. Multi-axis scaffolding ---
    const has5DFunctions = /function\s+on(?:Rapid|Linear)5D\s*\(/.test(fileText)
    const hasRotaryOutputs = /createVariable\(\{prefix:"[ABC]"\}/.test(fileText)
    if (has5DFunctions || hasRotaryOutputs) {
      findings.push({
        status: 'unsupported',
        sourceField: [has5DFunctions ? 'onRapid5D/onLinear5D' : null, hasRotaryOutputs ? 'aOutput/bOutput/cOutput' : null].filter((part): part is string => part !== null).join(', '),
        message: 'This post declares 5-axis scaffolding (rotary A/B/C output variables and/or onRapid5D/onLinear5D handlers). This Autodesk post-kernel family ships that boilerplate even in 3-axis-only posts; PureCutCNC only ever emits 3-axis G-code regardless, so this is not a real gap for the ordinary 3-axis case — flagged for transparency only, unverified against an actual 5-axis job.',
        blocksStrict: false,
      })
    }

    // --- 11. Units ---
    const inchUnit = /case\s+IN:\s*writeBlock\(gUnitModal\.format\((\d+)\)\);/.exec(fileText)
    const mmUnit = /case\s+MM:\s*writeBlock\(gUnitModal\.format\((\d+)\)\);/.exec(fileText)
    if (inchUnit) {
      overrides.units!.inchCommand = `G${inchUnit[1]}`
      mapped('switch(unit) case IN: gUnitModal.format(N)', 'units.inchCommand', `case IN calls gUnitModal.format(${inchUnit[1]}) -> "G${inchUnit[1]}".`, lineAt(fileText, inchUnit.index))
    } else {
      omitted('switch(unit) case IN', 'units.inchCommand', 'Could not find the "case IN: writeBlock(gUnitModal.format(N))" idiom; kept the generic default.')
    }
    if (mmUnit) {
      overrides.units!.mmCommand = `G${mmUnit[1]}`
      mapped('switch(unit) case MM: gUnitModal.format(N)', 'units.mmCommand', `case MM calls gUnitModal.format(${mmUnit[1]}) -> "G${mmUnit[1]}".`, lineAt(fileText, mmUnit.index))
    } else {
      omitted('switch(unit) case MM', 'units.mmCommand', 'Could not find the "case MM: writeBlock(gUnitModal.format(N))" idiom; kept the generic default.')
    }

    return { overrides, findings, notes }
  },
}
