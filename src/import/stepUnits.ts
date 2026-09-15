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
 * Declared length units of a STEP file (issue #784).
 *
 * Open CASCADE converts geometry into whichever unit it is asked for, so the
 * declaration decides what the tessellated numbers mean. It is read from the
 * text rather than the runtime so the dialog can show it as soon as a file is
 * chosen, before any WASM loads.
 *
 * A unit counts only when a `GLOBAL_UNIT_ASSIGNED_CONTEXT` assigns it. Files
 * routinely define length units they do not assign — an inch is declared as a
 * conversion of a millimetre entity — and counting every `LENGTH_UNIT` would
 * report every inch file as mixed.
 */

import type { Units } from '../utils/units'
import type { StepOutputUnit } from './stepProtocol'

export interface StepUnitInspection {
  /** Distinct assigned length units as display symbols (`mm`, `in`, `m`, …), in file order. */
  declaredUnits: string[]
  /** Unit to request from Open CASCADE; the tessellated numbers are in this unit. */
  outputUnit: StepOutputUnit
  /** Source-units default: the declared mm or inch, mm after a conversion, null when undeclared. */
  defaultSourceUnits: Units | null
  /** Open CASCADE converts the declared unit(s) to millimetres, which the dialog must say. */
  convertedToMm: boolean
}

const SI_METRE_PREFIX_SYMBOLS: Readonly<Record<string, string>> = {
  $: 'm',
  '.MILLI.': 'mm',
  '.CENTI.': 'cm',
  '.DECI.': 'dm',
  '.KILO.': 'km',
  '.MICRO.': 'µm',
  '.NANO.': 'nm',
}

const CONVERSION_UNIT_SYMBOLS: Readonly<Record<string, string>> = {
  INCH: 'in',
  FOOT: 'ft',
  MIL: 'mil',
  YARD: 'yd',
  MILE: 'mi',
  MILLIMETRE: 'mm',
  MILLIMETER: 'mm',
  CENTIMETRE: 'cm',
  CENTIMETER: 'cm',
  METRE: 'm',
  METER: 'm',
}

const QUOTE = 0x27
const SEMICOLON = 0x3b
const SLASH = 0x2f
const STAR = 0x2a

/**
 * Visit each DATA-section statement whose raw text contains `needle`, splitting
 * on `;` outside quoted strings and comments. Statements without the needle are
 * never sliced, so a large B-rep costs one character pass.
 */
function forEachStatementContaining(text: string, needle: string, visit: (statement: string) => void): void {
  const dataStart = text.indexOf('DATA;')
  let position = dataStart >= 0 ? dataStart + 'DATA;'.length : 0
  let statementStart = position
  let nextNeedle = text.indexOf(needle, position)
  let inString = false

  while (nextNeedle >= 0 && position < text.length) {
    const code = text.charCodeAt(position)
    if (inString) {
      // A doubled quote closes and immediately reopens, which is exactly the escape.
      if (code === QUOTE) inString = false
    } else if (code === QUOTE) {
      inString = true
    } else if (code === SLASH && text.charCodeAt(position + 1) === STAR) {
      const end = text.indexOf('*/', position + 2)
      position = end < 0 ? text.length : end + 2
      continue
    } else if (code === SEMICOLON) {
      if (nextNeedle >= statementStart && nextNeedle < position) {
        visit(text.slice(statementStart, position))
      }
      statementStart = position + 1
      if (nextNeedle < statementStart) nextNeedle = text.indexOf(needle, statementStart)
    }
    position += 1
  }
}

/** Blank quoted strings and drop comments, so keywords inside names cannot match. */
function codeOnly(statement: string): string {
  let out = ''
  let position = 0
  while (position < statement.length) {
    const char = statement[position]
    if (char === "'") {
      let end = position + 1
      while (end < statement.length) {
        if (statement[end] === "'") {
          if (statement[end + 1] === "'") {
            end += 2
            continue
          }
          break
        }
        end += 1
      }
      out += "''"
      position = end + 1
    } else if (char === '/' && statement[position + 1] === '*') {
      const end = statement.indexOf('*/', position + 2)
      out += ' '
      position = end < 0 ? statement.length : end + 2
    } else {
      out += char
      position += 1
    }
  }
  return out
}

function lengthUnitSymbol(definition: string): string | null {
  const code = codeOnly(definition)
  if (!/\bLENGTH_UNIT\s*\(/.test(code)) return null

  const si = /\bSI_UNIT\s*\(\s*(\$|\.[A-Z]+\.)\s*,\s*\.METRE\.\s*\)/.exec(code)
  if (si) return SI_METRE_PREFIX_SYMBOLS[si[1]] ?? `${si[1].replaceAll('.', '').toLowerCase()} metre`

  // The unit name is a string, so it is read from the original text.
  const conversion = /\bCONVERSION_BASED_UNIT\s*\(\s*'((?:[^']|'')*)'/.exec(definition)
  if (conversion) {
    const name = conversion[1].replaceAll("''", "'").trim()
    return CONVERSION_UNIT_SYMBOLS[name.toUpperCase()] ?? name.toLowerCase()
  }
  return null
}

/** Length units assigned by the file's representation contexts, as display symbols. */
export function detectStepLengthUnits(text: string): string[] {
  const definitions = new Map<string, string>()
  const assigned: string[] = []

  forEachStatementContaining(text, 'UNIT', (statement) => {
    const code = codeOnly(statement)
    const id = /^\s*(#\d+)\s*=/.exec(code)?.[1]
    if (id) definitions.set(id, statement)
    for (const match of code.matchAll(/\bGLOBAL_UNIT_ASSIGNED_CONTEXT\s*\(\s*\(([^)]*)\)\s*\)/g)) {
      for (const reference of match[1].split(',')) assigned.push(reference.trim())
    }
  })

  const symbols: string[] = []
  for (const reference of assigned) {
    const definition = definitions.get(reference)
    const symbol = definition ? lengthUnitSymbol(definition) : null
    if (symbol && !symbols.includes(symbol)) symbols.push(symbol)
  }
  return symbols
}

export function inspectStepUnits(text: string): StepUnitInspection {
  const declaredUnits = detectStepLengthUnits(text)
  if (declaredUnits.length === 0) {
    // Nothing is assigned, so the numbers mean nothing yet: the user must say.
    return { declaredUnits, outputUnit: 'mm', defaultSourceUnits: null, convertedToMm: false }
  }
  if (declaredUnits.length === 1 && declaredUnits[0] === 'in') {
    return { declaredUnits, outputUnit: 'inch', defaultSourceUnits: 'inch', convertedToMm: false }
  }
  if (declaredUnits.length === 1 && declaredUnits[0] === 'mm') {
    return { declaredUnits, outputUnit: 'mm', defaultSourceUnits: 'mm', convertedToMm: false }
  }
  return { declaredUnits, outputUnit: 'mm', defaultSourceUnits: 'mm', convertedToMm: true }
}

export function inspectStepFileUnits(buffer: ArrayBuffer): StepUnitInspection {
  // Part 21 text is 7-bit with escapes for anything else. `latin1` maps every
  // byte to one code unit, so a stray high byte can neither throw nor shift offsets.
  return inspectStepUnits(new TextDecoder('latin1').decode(buffer))
}
