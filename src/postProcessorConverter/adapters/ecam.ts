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

import { DOMParser } from 'linkedom'
import type { AdapterResult, ConversionFinding, SourceAdapter } from '../types'

/**
 * ECam `.xml` machine-definition files: a well-formed `<ToolMachine>` XML
 * document with mill/lathe settings side by side in one shared schema (most
 * fields are simply inert for whichever `MachineType` isn't in play) and a
 * handful of multi-line `Template_*` elements using `{TOKEN}` placeholders
 * (a different bracket style from the other three declarative adapters).
 * Parsed with `linkedom`'s DOMParser — the same library the SVG importer's
 * tests use to run browser-DOM code under Node — since this CLI runs under
 * `tsx`/Node, never a browser, and there is no global DOMParser to rely on.
 */

const TARGET_TOKENS: Record<string, string> = {
  PRG_NAME: 'programName',
  CREATION_DATE: 'date',
}

function extractCurlyTokens(template: string): string[] {
  const tokens: string[] = []
  const pattern = /\{([A-Za-z0-9_]+)\}/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(template)) !== null) tokens.push(match[1])
  return tokens
}

function translateCurlyTokens(template: string, tokenMap: Record<string, string>): { text: string; unmapped: string[] } {
  const unmapped: string[] = []
  const text = template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, token: string) => {
    if (token === 'EMPTY_LINE') return ''
    if (!(token in tokenMap)) {
      unmapped.push(token)
      return whole
    }
    return `{${tokenMap[token]}}`
  })
  return { text, unmapped: [...new Set(unmapped)] }
}

function textOf(root: Element, tag: string): string | null {
  const el = root.querySelector(tag)
  const text = el?.textContent?.trim()
  return text ? text : null
}

export const ecamAdapter: SourceAdapter = {
  id: 'ecam',
  label: 'ECam (.xml)',
  fileExtensions: ['xml'],
  staticAnalysisOnly: false,
  convert(fileText: string, filePath: string): AdapterResult {
    const findings: ConversionFinding[] = []
    const notes: string[] = []
    const doc = new DOMParser().parseFromString(fileText, 'text/xml') as unknown as Document
    const parserError = doc.querySelector('parsererror')
    if (parserError || !doc.querySelector('ToolMachine')) {
      findings.push({
        status: 'conflicting',
        sourceField: filePath,
        message: `Could not parse "${filePath}" as ECam XML (expected a <ToolMachine> root element).`,
        blocksStrict: true,
      })
      return { overrides: {}, findings, notes }
    }

    const root = doc.documentElement as unknown as Element
    const post = root.querySelector('Post')
    const machineType = textOf(root, 'MachineType')

    const mapped = (source: string, target: string, message: string): void => {
      findings.push({ status: 'mapped', sourceField: source, targetField: target, message, blocksStrict: false })
    }
    const omitted = (source: string, target: string, message: string): void => {
      findings.push({ status: 'omitted', sourceField: source, targetField: target, message, blocksStrict: false })
    }

    if (machineType && !/mill/i.test(machineType)) {
      findings.push({
        status: 'unsupported',
        sourceField: 'MachineType',
        message: `MachineType = "${machineType}" — this file configures a lathe/turning machine, not a 3-axis mill. Lathe behavior (diameter-mode X, polar/live-tooling macros, tailstock control) is out of scope; PureCutCNC is mill-only. Fields below were still extracted where literally present, but this definition should not be used as-is.`,
        blocksStrict: true,
      })
    }

    const overrides: AdapterResult['overrides'] = {
      coordinateSystem: { xAxis: 'X', yAxis: 'Y', zAxis: 'Z' },
      motion: {},
      feedSpeed: {},
      program: {},
      workCoordinates: {},
      numberFormat: {},
      units: {},
    }

    if (!post) {
      findings.push({ status: 'conflicting', sourceField: 'ToolMachine', message: 'No <Post> element found; nothing could be converted.', blocksStrict: true })
      return { overrides, findings, notes }
    }

    const decimals = textOf(post, 'Decimal_Count_Coordinate')
    if (decimals) {
      const places = Number(decimals)
      overrides.numberFormat!.decimalPlaces = { mm: places, inch: places }
      mapped('Post/Decimal_Count_Coordinate', 'numberFormat.decimalPlaces', `Decimal_Count_Coordinate = ${decimals}, used for both mm and inch (source formats under one active Unit mode).`)
    }
    omitted('Post/ForceDecimalPoint, DecimalSeparator', 'numberFormat.trailingZeros / numberFormat.leadingZero', 'Source controls decimal-point forcing and separator character directly, which does not map onto PureCutCNC\'s trailing/leading-zero flags. Kept the generic default.')

    const unitEl = textOf(root, 'Unit')
    omitted('Unit', 'units.mmCommand / units.inchCommand', `Unit = "${unitEl}" selects the source's own formatting mode; no G20/G21 (or equivalent) literal was found anywhere in <Post>. Kept the generic default — verify the target controller's power-on unit mode.`)

    const lineIncrement = textOf(post, 'Line_Number_Increment')
    const initTemplate = textOf(post, 'Template_InitOperation_With_Toolchange') ?? ''
    const usesLineNumber = /\{LINE_N\}/.test(initTemplate)
    overrides.program!.lineNumbers = usesLineNumber
    if (lineIncrement) {
      if (usesLineNumber) {
        overrides.program!.lineNumberIncrement = Number(lineIncrement)
        mapped('Post/Line_Number_Increment', 'program.lineNumberIncrement', `Line_Number_Increment = ${lineIncrement}, and {LINE_N} is referenced in Template_InitOperation_With_Toolchange.`)
      } else {
        omitted('Post/Line_Number_Increment', 'program.lineNumbers', 'Line_Number_Start/Increment/Maximum are declared but {LINE_N} is not referenced by any template; treated as line numbers disabled.')
      }
    }

    const alwaysRepeated = [...post.querySelectorAll('CodeAlwaysRepeated > CODE')].map((el) => el.textContent?.trim())
    overrides.motion!.modalMotion = !alwaysRepeated.includes('COO_X') && !alwaysRepeated.includes('COO_Y')
    findings.push({
      status: 'mapped',
      sourceField: 'Post/CodeAlwaysRepeated',
      targetField: 'motion.modalMotion',
      message: `Coordinate codes are ${overrides.motion!.modalMotion ? 'not' : ''} listed as always-repeated, so they ${overrides.motion!.modalMotion ? 'suppress when unchanged (modal)' : 'are always repeated (non-modal)'}.`,
      blocksStrict: false,
    })

    const motionFields: Array<[string, keyof NonNullable<AdapterResult['overrides']['motion']>]> = [
      ['Move_RAPID', 'rapidCommand'],
      ['Move_WORK', 'linearCommand'],
      ['Move_ARC_CW', 'cwArcCommand'],
      ['Move_ARC_CCW', 'ccwArcCommand'],
    ]
    for (const [tag, target] of motionFields) {
      const value = textOf(post, tag)
      if (value) {
        ;(overrides.motion as Record<string, unknown>)[target] = value
        mapped(`Post/${tag}`, `motion.${target}`, `${tag} = "${value}".`)
      }
    }

    const arcTemplate = textOf(post, 'Template_ArcMovement')
    if (arcTemplate) {
      const tokens = extractCurlyTokens(arcTemplate)
      const usesIJ = tokens.some((t) => t.startsWith('ARC_I') || t.startsWith('ARC_J') || t.startsWith('ARC_K'))
      const usesR = tokens.some((t) => t.startsWith('ARC_RADIUS'))
      if (usesIJ && !usesR) {
        overrides.motion!.arcFormat = 'ij'
        mapped('Post/Template_ArcMovement', 'motion.arcFormat', `Template emits ${tokens.filter((t) => t.startsWith('ARC_')).join('/')}; mapped to "ij".`)
      } else if (usesR && !usesIJ) {
        overrides.motion!.arcFormat = 'r'
        mapped('Post/Template_ArcMovement', 'motion.arcFormat', 'Template emits ARC_RADIUS; mapped to "r".')
      } else {
        findings.push({ status: 'conflicting', sourceField: 'Post/Template_ArcMovement', targetField: 'motion.arcFormat', message: 'Could not determine a single I/J-vs-R arc format from the template; kept the generic default.', blocksStrict: true })
      }
    }

    const feedCode = textOf(post, 'Code_Feed')
    const speedCode = textOf(post, 'Code_Speed')
    if (feedCode) {
      overrides.feedSpeed!.feedCommand = feedCode
      mapped('Post/Code_Feed', 'feedSpeed.feedCommand', `Code_Feed = "${feedCode}".`)
    }
    if (speedCode) {
      overrides.feedSpeed!.rpmCommand = speedCode
      mapped('Post/Code_Speed', 'feedSpeed.rpmCommand', `Code_Speed = "${speedCode}".`)
    }
    const spindleCW = textOf(post, 'Spindle_CW')
    const spindleCCW = textOf(post, 'Spindle_CCW')
    const spindleStop = textOf(post, 'Spindle_STOP')
    if (spindleCW) {
      overrides.feedSpeed!.spindleOnCW = spindleCW
      mapped('Post/Spindle_CW', 'feedSpeed.spindleOnCW', `Spindle_CW = "${spindleCW}".`)
    }
    if (spindleCCW) {
      overrides.feedSpeed!.spindleOnCCW = spindleCCW
      mapped('Post/Spindle_CCW', 'feedSpeed.spindleOnCCW', `Spindle_CCW = "${spindleCCW}".`)
    }
    if (spindleStop) {
      overrides.feedSpeed!.spindleOff = spindleStop
      mapped('Post/Spindle_STOP', 'feedSpeed.spindleOff', `Spindle_STOP = "${spindleStop}".`)
    }

    const coolantOn = textOf(post, 'Coolant_ON')
    const coolantOff = textOf(post, 'Coolant_OFF')
    if (coolantOn || coolantOff) {
      overrides.coolant = {
        ...(coolantOn ? { floodOnCommand: coolantOn } : {}),
        ...(coolantOff ? { coolantOffCommand: coolantOff } : {}),
      }
      if (coolantOn) mapped('Post/Coolant_ON', 'coolant.floodOnCommand', `Coolant_ON = "${coolantOn}".`)
      if (coolantOff) mapped('Post/Coolant_OFF', 'coolant.coolantOffCommand', `Coolant_OFF = "${coolantOff}".`)
      omitted('(none)', 'coolant.mistOnCommand', 'Source has one coolant-on code, not separate flood/mist codes; kept the generic default for mist.')
    } else {
      overrides.coolant = null
    }

    const axisX = textOf(post, 'Axis_X')
    const axisY = textOf(post, 'Axis_Y')
    const axisZ = textOf(post, 'Axis_Z')
    const invertZ = textOf(post, 'InvertZAxis')
    if (axisX === 'X' && axisY === 'Y' && axisZ === 'Z' && invertZ === 'false') {
      mapped('Post/Axis_X,Axis_Y,Axis_Z,InvertZAxis', 'coordinateSystem', 'Confirmed identity axis mapping (no swap, no inversion).')
    } else {
      findings.push({
        status: 'unsupported',
        sourceField: 'Post/Axis_X,Axis_Y,Axis_Z,InvertZAxis,Invert_G2_G3_XZ_Plane',
        targetField: 'coordinateSystem',
        message: `Axis_X/Y/Z = "${axisX}"/"${axisY}"/"${axisZ}", InvertZAxis = "${invertZ}" — a non-identity axis mapping was indicated; the static extractor does not resolve arbitrary axis remapping, kept the identity default. Verify manually.`,
        blocksStrict: true,
      })
    }

    const origin1 = textOf(post, 'Origin1')
    if (origin1) {
      overrides.workCoordinates!.selectCommand = origin1
      mapped('Post/Origin1', 'workCoordinates.selectCommand', `Origin1 = "${origin1}".`)
    }
    const otherOrigins = ['Origin2', 'Origin3', 'Origin4', 'Origin5', 'Origin6', 'Origin7', 'Origin8'].filter((tag) => textOf(post, tag))
    if (otherOrigins.length > 0) {
      findings.push({
        status: 'unsupported',
        sourceField: `Post/${otherOrigins.join(',')}`,
        message: `Source declares ${otherOrigins.length} additional work-offset registers beyond Origin1; PureCutCNC has one fixed workCoordinates.selectCommand. Not blocking — a single work offset is sufficient for ordinary single-setup 3-axis jobs.`,
        blocksStrict: false,
      })
    }

    const initProgram = textOf(post, 'Template_InitNewProgram')
    if (initProgram) {
      const header: string[] = []
      let droppedLines = 0
      for (const rawLine of initProgram.split('\n')) {
        const { text, unmapped } = translateCurlyTokens(rawLine, TARGET_TOKENS)
        if (unmapped.length > 0) {
          droppedLines += 1
          continue
        }
        const trimmed = text.trim()
        if (trimmed.length > 0) header.push(trimmed)
      }
      if (header.length > 0) overrides.program!.header = header
      findings.push({
        status: 'mapped',
        sourceField: 'Post/Template_InitNewProgram',
        targetField: 'program.header',
        message: `Translated ${header.length} line(s) to: ${JSON.stringify(header)}. Dropped ${droppedLines} line(s) referencing values with no static PureCutCNC placeholder (e.g. {TOOL_SUMMARY}).`,
        blocksStrict: false,
      })
    }

    const endProgram = textOf(post, 'Template_EndProgram')
    if (endProgram) {
      const footer: string[] = []
      for (const rawLine of endProgram.split('\n')) {
        const { text, unmapped } = translateCurlyTokens(rawLine, TARGET_TOKENS)
        if (unmapped.length === 0 && text.trim().length > 0) footer.push(text.trim())
      }
      if (footer.length > 0) {
        overrides.program!.footer = footer
        overrides.stop = { programEndCommand: footer.find((line) => /M30/.test(line)) ?? 'M30' }
        mapped('Post/Template_EndProgram', 'program.footer', `Translated to: ${JSON.stringify(footer)}.`)
      }
    }

    const toolChangeTemplate = textOf(post, 'Template_InitOperation_With_Toolchange')
    if (toolChangeTemplate) {
      findings.push({
        status: 'unsupported',
        sourceField: 'Post/Template_InitOperation_With_Toolchange',
        targetField: 'toolChange.commands',
        message: `Template references tool-position/label/feed-mode/spindle-orientation values ({TOOL_POS}, {NEXT_TOOL_CODE}, {FEED_MODE}, {SPINDLE_ORIENTATION}, {COOLANT_CODE}) that are resolved per-operation by ECam's own engine and have no static PureCutCNC toolChange.commands placeholder beyond tool number. Not converted; kept the generic default (T{toolNumber} M6 -style) instead of fabricating a guess.`,
        blocksStrict: true,
      })
    }

    for (const lathePrefix of ['Macro_Lathe', 'Template_MacroLathe', 'Template_MacroAxialTurning', 'FaceTurning', 'ApprochDistanceRadial', 'ApprochMinimalDistanceRadial']) {
      if ([...post.children].some((el) => el.tagName.startsWith(lathePrefix))) {
        findings.push({
          status: 'unsupported',
          sourceField: `Post/${lathePrefix}*`,
          message: `Lathe-only field(s) present in the shared ECam schema${machineType && /mill/i.test(machineType) ? ` but inapplicable since MachineType = "${machineType}"` : ''}; not converted (PureCutCNC is mill-only).`,
          blocksStrict: false,
        })
        break
      }
    }

    overrides.cannedCycles = null
    findings.push({
      status: 'unsupported',
      sourceField: 'Post/Template_Macro_RightTapping,Reamering,Boring,Counterboring,...',
      targetField: 'cannedCycles',
      message: 'Source expresses drilling/tapping/boring/reaming as full G-code macro templates (feed/speed-mode switches, point lists, multiple cycle variants), not the fixed drill/peck/dwell command set PureCutCNC\'s cannedCycles model expects. Set to null rather than guessing a G81/G82/G83 mapping from the macro text.',
      blocksStrict: true,
    })

    return { overrides, findings, notes }
  },
}
