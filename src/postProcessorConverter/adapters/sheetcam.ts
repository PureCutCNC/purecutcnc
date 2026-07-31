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
 * SheetCAM `.scpost` post-processor files: Lua scripts defining named
 * `On*` event callbacks (`OnRapid`, `OnMove`, `OnArc`, `OnToolChange`, ...)
 * that call a small fixed `post.*` API (`post.Text`, `post.ModalText`,
 * `post.Number`, ...). Statically pattern-matched only — the Lua engine is
 * never invoked. `findFunctionBody` is a balanced-block scanner (not a real
 * Lua parser): it counts block-opening keywords against `end` to find each
 * callback's true extent, since a naive non-greedy regex would stop at the
 * first `end` inside a nested `if`/`while`.
 */

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/**
 * Strips both whole-line `--` comments and trailing `code -- comment`
 * comments (quote-aware, so a `--` inside a `"..."` string literal is left
 * alone). Also removes SheetCAM's dead, individually-commented-out duplicate
 * `OnNewLine` near the top of the mill fixture, leaving only the real,
 * active definition later in the file for `findFunctionBody` to find.
 *
 * Trailing comments matter here beyond cosmetics: OnDrill has
 * `if (depth > drillZ) then --retract if we need to take another bite`,
 * whose comment text contains the standalone word "if" — left in place, the
 * balanced-block scanner below would count it as a real nested block opener
 * and lose track of OnDrill's true extent.
 */
function stripLuaComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      let inString = false
      for (let i = 0; i < line.length; i += 1) {
        if (line[i] === '"') inString = !inString
        else if (!inString && line[i] === '-' && line[i + 1] === '-') return line.slice(0, i)
      }
      return line
    })
    .join('\n')
}

const BLOCK_OPENERS = /\b(function|if|for|while)\b/g
const BLOCK_CLOSER = /\bend\b/g

/**
 * Finds the body of `function <name>(...) ... end`, using the LAST match of
 * the opening line (Lua semantics: a later global function definition wins;
 * after comment-stripping, a dead/commented-out earlier definition has
 * already vanished from the text, so "last" is also "only" in practice).
 * Scans forward counting nested block-openers against `end` keywords,
 * skipping the contents of `"..."` string literals so a keyword-like
 * substring inside a message string can't miscount, to find the specific
 * `end` that closes this function rather than an inner `if`/`while`.
 */
function findFunctionBody(text: string, name: string): string | null {
  const opener = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)`, 'g')
  let match: RegExpExecArray | null
  let last: RegExpExecArray | null = null
  while ((match = opener.exec(text)) !== null) last = match
  if (!last) return null

  let pos = last.index + last[0].length
  let depth = 1
  while (pos < text.length && depth > 0) {
    if (text[pos] === '"') {
      const closeQuote = text.indexOf('"', pos + 1)
      pos = closeQuote === -1 ? text.length : closeQuote + 1
      continue
    }
    BLOCK_OPENERS.lastIndex = pos
    BLOCK_CLOSER.lastIndex = pos
    const openerMatch = BLOCK_OPENERS.exec(text)
    const closerMatch = BLOCK_CLOSER.exec(text)
    const nextOpener = openerMatch && openerMatch.index === pos ? openerMatch : null
    const nextCloser = closerMatch && closerMatch.index === pos ? closerMatch : null
    if (nextCloser) {
      depth -= 1
      if (depth === 0) return text.slice(last.index + last[0].length, pos)
      pos += 3 // 'end'
    } else if (nextOpener) {
      depth += 1
      pos += nextOpener[0].length
    } else {
      pos += 1
    }
  }
  return null
}

/** Extracts the trimmed content of the first quoted string argument to a
 *  `post.Text`/`post.ModalText` call whose string contains `contains`. */
function findQuotedCommand(body: string, contains: string): string | null {
  const pattern = /post\.(?:Modal)?Text\s*\(\s*"([^"]*)"/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(body)) !== null) {
    if (match[1].includes(contains)) {
      const word = /\b([GM]\d+)\b/.exec(match[1])
      if (word) return word[1]
    }
  }
  return null
}

export const sheetcamAdapter: SourceAdapter = {
  id: 'sheetcam',
  label: 'SheetCAM (.scpost)',
  fileExtensions: ['scpost'],
  staticAnalysisOnly: true,
  convert(fileText: string): AdapterResult {
    const findings: ConversionFinding[] = []
    const text = stripLuaComments(normalizeLineEndings(fileText))

    const mapped = (source: string, target: string, message: string): void => {
      findings.push({ status: 'mapped', sourceField: source, targetField: target, message, blocksStrict: false })
    }
    const omitted = (source: string, target: string, message: string): void => {
      findings.push({ status: 'omitted', sourceField: source, targetField: target, message, blocksStrict: false })
    }

    const overrides: AdapterResult['overrides'] = {
      coordinateSystem: { xAxis: 'X', yAxis: 'Y', zAxis: 'Z' },
      motion: {},
      feedSpeed: {},
      program: {},
      units: {},
      toolChange: {},
    }

    const onInit = findFunctionBody(text, 'OnInit')
    if (onInit) {
      const commentChars = /post\.SetCommentChars\s*\(\s*"([^"]*)"\s*,\s*"([^"]*)"/.exec(onInit)
      if (commentChars) {
        const [, primary] = commentChars
        overrides.program!.commentPrefix = primary[0] ?? '('
        overrides.program!.commentSuffix = primary[1] ?? ')'
        mapped(
          'OnInit: post.SetCommentChars(...)',
          'program.commentPrefix / program.commentSuffix',
          `post.SetCommentChars("${commentChars[1]}", "${commentChars[2]}") — the first pair mapped to program.commentPrefix/commentSuffix; the second pair ("${commentChars[2]}") is a system-text escape delimiter with no PureCutCNC equivalent.`,
        )
      }
      const mmCode = /post\.Text\s*\([^)]*"[^"]*(G21)[^"]*"/.exec(onInit)
      const inchCode = /post\.Text\s*\([^)]*"[^"]*(G20)[^"]*"/.exec(onInit)
      if (mmCode) {
        overrides.units!.mmCommand = mmCode[1]
        mapped('OnInit: metric-mode post.Text', 'units.mmCommand', `Recognized the "if(scale == metric) then post.Text(" G21 ...") else ..." idiom.`)
      }
      if (inchCode) {
        overrides.units!.inchCommand = inchCode[1]
        mapped('OnInit: inch-mode post.Text', 'units.inchCommand', `Recognized the "... else post.Text(" G20 ...") end" idiom.`)
      }
      if (/bigArcs\s*=|minArcSize\s*=/.test(onInit)) {
        findings.push({
          status: 'unsupported',
          sourceField: 'OnInit: bigArcs / minArcSize',
          message: 'Source configures its own arc-fitting behavior (stitching/minimum-size thresholds). PureCutCNC has its own independent arc-fitting engine (see planning/G-code_Export_Design.md); this source setting has no PureCutCNC field and is not a real gap.',
          blocksStrict: false,
        })
      }
    } else {
      omitted('OnInit', 'program.commentPrefix / program.commentSuffix / units.mmCommand / units.inchCommand', 'No OnInit callback found in source; kept the generic defaults.')
    }

    const onRapid = findFunctionBody(text, 'OnRapid')
    const rapidCommand = onRapid ? findQuotedCommand(onRapid, 'G0') : null
    if (rapidCommand) {
      overrides.motion!.rapidCommand = rapidCommand
      mapped('OnRapid: post.ModalText(...)', 'motion.rapidCommand', `Found "${rapidCommand}" in a post.ModalText call.`)
    } else {
      omitted('OnRapid', 'motion.rapidCommand', 'No literal rapid G-code found in OnRapid; kept the generic default.')
    }

    const onMove = findFunctionBody(text, 'OnMove')
    const linearCommand = onMove ? findQuotedCommand(onMove, 'G0') : null
    if (linearCommand) {
      overrides.motion!.linearCommand = linearCommand
      mapped('OnMove: post.ModalText(...)', 'motion.linearCommand', `Found "${linearCommand}" in a post.ModalText call.`)
    } else {
      omitted('OnMove', 'motion.linearCommand', 'No literal linear G-code found in OnMove; kept the generic default.')
    }

    const onArc = findFunctionBody(text, 'OnArc')
    if (onArc) {
      const codes = [...onArc.matchAll(/post\.ModalText\s*\(\s*"[^"]*\b(G\d+)\b/g)].map((m) => m[1])
      const cw = codes.find((c) => c === 'G02' || c === 'G2')
      const ccw = codes.find((c) => c === 'G03' || c === 'G3')
      if (cw) {
        overrides.motion!.cwArcCommand = cw
        mapped('OnArc: post.ModalText(...)', 'motion.cwArcCommand', `Found "${cw}" (clockwise by standard G-code convention) in a post.ModalText call.`)
      }
      if (ccw) {
        overrides.motion!.ccwArcCommand = ccw
        mapped('OnArc: post.ModalText(...)', 'motion.ccwArcCommand', `Found "${ccw}" (counter-clockwise by standard G-code convention) in a post.ModalText call.`)
      }
      const hasI = /post\.(?:Non)?(?:Modal)?(?:Number|Text)\s*\(\s*"\s*I"/.test(onArc)
      const hasJ = /post\.(?:Non)?(?:Modal)?(?:Number|Text)\s*\(\s*"\s*J"/.test(onArc)
      const hasR = /post\.(?:Non)?(?:Modal)?(?:Number|Text)\s*\(\s*"\s*R"/.test(onArc)
      if ((hasI || hasJ) && !hasR) {
        overrides.motion!.arcFormat = 'ij'
        mapped('OnArc: post.Text(" I")/post.Text(" J")', 'motion.arcFormat', 'Found explicit "I"/"J" output calls; mapped to "ij".')
      } else if (hasR && !hasI && !hasJ) {
        overrides.motion!.arcFormat = 'r'
        mapped('OnArc: post.Text(" R")', 'motion.arcFormat', 'Found an explicit "R" output call; mapped to "r".')
      } else {
        findings.push({ status: 'conflicting', sourceField: 'OnArc', targetField: 'motion.arcFormat', message: 'Could not determine a single I/J-vs-R arc format from OnArc; kept the generic default.', blocksStrict: true })
      }
    } else {
      omitted('OnArc', 'motion.cwArcCommand / motion.ccwArcCommand / motion.arcFormat', 'No OnArc callback found in source; kept the generic defaults.')
    }

    const onSpindleCW = findFunctionBody(text, 'OnSpindleCW')
    const onSpindleCCW = findFunctionBody(text, 'OnSpindleCCW')
    const onSpindleOff = findFunctionBody(text, 'OnSpindleOff')
    const cw = onSpindleCW ? /post\.Text\s*\(\s*"\s*(M\d+)/.exec(onSpindleCW) : null
    const ccw = onSpindleCCW ? /post\.Text\s*\(\s*"\s*(M\d+)/.exec(onSpindleCCW) : null
    const off = onSpindleOff ? /post\.Text\s*\(\s*"\s*(M\d+)/.exec(onSpindleOff) : null
    if (cw) {
      overrides.feedSpeed!.spindleOnCW = cw[1]
      mapped('OnSpindleCW: post.Text(...)', 'feedSpeed.spindleOnCW', `Found "${cw[1]}".`)
    }
    if (ccw) {
      overrides.feedSpeed!.spindleOnCCW = ccw[1]
      mapped('OnSpindleCCW: post.Text(...)', 'feedSpeed.spindleOnCCW', `Found "${ccw[1]}".`)
    }
    if (off) {
      overrides.feedSpeed!.spindleOff = off[1]
      mapped('OnSpindleOff: post.Text(...)', 'feedSpeed.spindleOff', `Found "${off[1]}".`)
    }

    const onToolChange = findFunctionBody(text, 'OnToolChange')
    if (onToolChange) {
      const m6 = /post\.Text\s*\(\s*"\s*(M\d+)\s*T"/.exec(onToolChange)
      const lengthComp = /post\.Text\s*\(\s*"\s*(G\d+)\s*H"/.exec(onToolChange)
      const commands: string[] = []
      if (m6 && /post\.Number\s*\(\s*tool\s*,/.test(onToolChange)) {
        commands.push(`${m6[1]} T{toolNumber}`)
      }
      if (lengthComp) {
        commands.push(`${lengthComp[1]} H{toolNumber}`)
      }
      if (commands.length > 0) {
        overrides.toolChange!.commands = commands
        mapped(
          'OnToolChange: post.Text(...) / post.Number(tool, ...)',
          'toolChange.commands',
          `Recognized the "M6 T" + post.Number(tool,...) and "G43 H" + post.Number(tool,...) idiom; the Lua "tool" variable (per-move tool number) mapped to {toolNumber}. Translated to: ${JSON.stringify(commands)}.`,
        )
      } else {
        omitted('OnToolChange', 'toolChange.commands', 'Could not recognize a tool-number-driven M6/G43 idiom in OnToolChange; kept the generic default.')
      }
    } else {
      omitted('OnToolChange', 'toolChange.commands', 'No OnToolChange callback found in source; kept the generic default.')
    }

    const onFloodOn = findFunctionBody(text, 'OnFloodOn')
    const onMistOn = findFunctionBody(text, 'OnMistOn')
    const onCoolantOff = findFunctionBody(text, 'OnCoolantOff')
    const flood = onFloodOn ? /post\.Text\s*\(\s*"\s*(M\d+)/.exec(onFloodOn) : null
    const mist = onMistOn ? /post\.Text\s*\(\s*"\s*(M\d+)/.exec(onMistOn) : null
    const coolOff = onCoolantOff ? /post\.Text\s*\(\s*"\s*(M\d+)/.exec(onCoolantOff) : null
    if (flood || mist || coolOff) {
      overrides.coolant = {
        ...(flood ? { floodOnCommand: flood[1] } : {}),
        ...(mist ? { mistOnCommand: mist[1] } : {}),
        ...(coolOff ? { coolantOffCommand: coolOff[1] } : {}),
      }
      if (flood) mapped('OnFloodOn: post.Text(...)', 'coolant.floodOnCommand', `Found "${flood[1]}".`)
      if (mist) mapped('OnMistOn: post.Text(...)', 'coolant.mistOnCommand', `Found "${mist[1]}".`)
      if (coolOff) mapped('OnCoolantOff: post.Text(...)', 'coolant.coolantOffCommand', `Found "${coolOff[1]}".`)
    } else {
      overrides.coolant = null
    }

    const onFinish = findFunctionBody(text, 'OnFinish')
    const programEnd = onFinish ? /\b(M30)\b/.exec(onFinish) : null
    if (programEnd) {
      overrides.stop = { programEndCommand: programEnd[1] }
      mapped('OnFinish: post.Text(...)', 'stop.programEndCommand', `Found "${programEnd[1]}". The source also unconditionally emits "M05" in the same call — informational, PureCutCNC's own postprocessor already tracks spindle-off state.`)
    } else {
      omitted('OnFinish', 'stop.programEndCommand', 'No literal M30 found in OnFinish; kept the generic default.')
    }

    const onDrill = findFunctionBody(text, 'OnDrill')
    if (onDrill && /\bwhile\b/.test(onDrill)) {
      overrides.cannedCycles = null
      findings.push({
        status: 'unsupported',
        sourceField: 'OnDrill',
        targetField: 'cannedCycles',
        message: 'OnDrill implements a manual peck-drilling loop (real Lua control flow: a "while" loop simulating pecks via rapid/feed moves) rather than emitting a fixed canned-cycle G-code. Set to null rather than reverse-engineering the loop into G81/G82/G83 — the static extractor does not evaluate control flow. Only drilling operations are affected; motion/arc/spindle/coolant were extracted independently and are unaffected.',
        blocksStrict: false,
      })
    } else {
      omitted('OnDrill', 'cannedCycles', 'No OnDrill callback found, or it does not implement custom cycle logic; kept the generic default.')
    }

    const onNewLine = findFunctionBody(text, 'OnNewLine')
    if (onNewLine) {
      const increment = /lineNumber\s*=\s*lineNumber\s*\+\s*(\d+)/.exec(onNewLine)
      overrides.program!.lineNumbers = true
      if (increment) {
        overrides.program!.lineNumberIncrement = Number(increment[1])
        mapped('OnNewLine', 'program.lineNumbers / program.lineNumberIncrement', `OnNewLine emits "N" + the line number and increments it by ${increment[1]} per line.`)
      } else {
        mapped('OnNewLine', 'program.lineNumbers', 'OnNewLine is present and emits a line-number prefix; increment amount could not be confirmed, kept the generic default increment.')
      }
    } else {
      overrides.program!.lineNumbers = false
      omitted('OnNewLine', 'program.lineNumbers', 'No active OnNewLine callback found in source; treated as line numbers disabled.')
    }

    const onPenDown = findFunctionBody(text, 'OnPenDown')
    const onPenUp = findFunctionBody(text, 'OnPenUp')
    if (onPenDown || onPenUp) {
      findings.push({
        status: 'unsupported',
        sourceField: 'OnPenDown / OnPenUp',
        message: 'Source defines plasma torch-fire and torch-height-control callbacks. PureCutCNC has no plasma/THC concept at all; this behavior was not converted and using this definition for a mill job would silently lose torch control.',
        blocksStrict: true,
      })
    }

    omitted('(none)', 'workCoordinates.selectCommand', 'No explicit work-coordinate-selection command found in source; kept the generic default (G54).')
    omitted('(none)', 'numberFormat.trailingZeros', 'Coordinate output uses fixed-width format strings (e.g. "0.0000") with no PureCutCNC-style trailing-zero-suppression flag; kept the generic default.')

    const coordFormat = onMove ? /post\.ModalNumber\s*\(\s*"\s*X"\s*,[^,]*,\s*"([0#.]+)"/.exec(onMove) : null
    if (coordFormat) {
      const decimalDigits = (coordFormat[1].split('.')[1] ?? '').length
      overrides.numberFormat = { decimalPlaces: { mm: decimalDigits, inch: decimalDigits }, leadingZero: true, trailingZeros: true }
      mapped('OnMove: post.ModalNumber(" X", ..., "...")', 'numberFormat.decimalPlaces', `X-coordinate format string "${coordFormat[1]}" has ${decimalDigits} decimal digit(s); used for both mm and inch (source formats under one active "scale" mode). leadingZero/trailingZeros both true: the fixed-width format always shows a leading 0 and pads to full width.`)
    } else {
      omitted('(none)', 'numberFormat.decimalPlaces', 'Could not find a coordinate output format string in OnMove; kept the generic default.')
    }

    return {
      overrides,
      findings,
      notes: [
        'SheetCAM .scpost files are Lua scripts; only recognized On* callbacks and post.* call idioms were pattern-matched via a balanced-block text scanner (tracking function/if/for/while against end). The Lua engine was never invoked, required, or evaluated.',
      ],
    }
  },
}
