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
 * Table-driven injection sweep for the #1057 slice H fixes.
 *
 * Codex found three ways past the slice-F template rules:
 *
 * 1. a free-text `commentPrefix` (`"G91"`) made `spindleOnCW: "G91"` validate
 *    as a comment and emit executable code, and a newline in the prefix or
 *    suffix did the same through the bar setup comments;
 * 2. `M{toolNumber}` expanded to `M1` for validation and to `M6` for the sixth
 *    tool;
 * 3. `feedCommand: "F\nF"` passed because the field was split into lines
 *    before matching.
 *
 * This sweep applies every injection pattern from that review — newline,
 * compact word, lowercase, a placeholder as a G or M number, a placeholder
 * joined to another word, and the semicolon/multi-command split — to *every*
 * template and command field the definition schema carries, and to the comment
 * marker pair in both dialects. A field the sweep cannot build a valid base
 * for fails the test, so a new field cannot arrive unexercised.
 *
 * Mutations that must fail this file (restore `templateRules.ts` from a `cp`
 * backup after each):
 * - accept a free-text comment prefix (skip `commentSyntaxViolation`) → every
 *   comment-prefix case passes and the sweep fails;
 * - allow `M` in `placeholderWordLetters` (or expand placeholders before
 *   judging their position) → the `M{toolNumber}` cases pass and the sweep
 *   fails;
 * - split a command field into lines before matching → `F\nF`, `F\nG91` and
 *   `Q\nG0` pass and the sweep fails.
 *
 * Run with: npx tsx src/engine/gcode/templateInjectionSweep.test.ts
 */

import assert from 'node:assert/strict'
import { BUNDLED_DEFINITIONS } from './definitions'
import { MACHINE_STRING_FIELDS, templateRuleViolations } from './templateRules'
import type { StringFieldClass, TemplateRule } from './templateRules'
import { MachineDefinitionSchema } from './types'
import type { MachineDefinition } from './types'

// ── Fixtures ─────────────────────────────────────────────────

function bundled(id: string): MachineDefinition {
  const found = BUNDLED_DEFINITIONS.find((definition) => definition.id === id)
  assert.ok(found, `fixture: bundled machine ${id}`)
  assert.equal(MachineDefinitionSchema.safeParse(structuredClone(found)).success, true, `${id}: the bundled definition validates`)
  return structuredClone(found)
}

/**
 * One router definition that carries every optional G-code block the field
 * table names: coolant (grblhal), canned cycles (mach3), a rotary axis and an
 * explicit machine-coordinate rapid.
 */
const ROUTER: MachineDefinition = (() => {
  const parsed = MachineDefinitionSchema.safeParse({
    ...bundled('grblhal'),
    motion: { ...bundled('grblhal').motion, machineCoordinateCommand: 'G53 G0' },
    cannedCycles: bundled('mach3').cannedCycles,
    rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  })
  assert.equal(parsed.success, true, `fixture: the router superset validates: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`)
  return parsed.success ? parsed.data : (undefined as unknown as MachineDefinition)
})()

/**
 * Plasma fields split across the two bundled plasma definitions because the
 * schema makes them mutually exclusive: controller piercing (QtPlasmaC) owns
 * the material sequence, G-code piercing (grbl-plasma) owns the touch-off
 * block.
 */
const PLASMA_MATERIAL: MachineDefinition = bundled('qtplasmac')
const PLASMA_TOUCH: MachineDefinition = bundled('grbl-plasma')

const SHOPBOT: MachineDefinition = bundled('shopbot')

function fixtureFor(path: readonly string[]): MachineDefinition {
  if (path[0] === 'plasma') {
    return path[1] === 'touchOff' ? PLASMA_TOUCH : PLASMA_MATERIAL
  }
  return ROUTER
}

/** Read a dotted path, or undefined when an intermediate is absent. */
function readPath(root: unknown, path: readonly string[]): unknown {
  let value = root
  for (const key of path) {
    if (value === null || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

/** A clone with one dotted path replaced. */
function withPath(definition: MachineDefinition, path: readonly string[], value: unknown): unknown {
  const clone = structuredClone(definition) as Record<string, unknown>
  let target = clone
  for (const key of path.slice(0, -1)) {
    target = target[key] as Record<string, unknown>
  }
  target[path[path.length - 1]] = value
  return clone
}

/** A clone with both comment marker fields replaced. */
function withCommentPair(
  definition: MachineDefinition,
  prefix: string,
  suffix: string,
): MachineDefinition {
  const clone = structuredClone(definition)
  clone.program.commentPrefix = prefix
  clone.program.commentSuffix = suffix
  return clone
}

/** The first present string at a spec's path, or undefined. */
function baseValue(fixture: MachineDefinition, path: readonly string[], array: boolean | undefined): string | undefined {
  const value = readPath(fixture, path)
  return array ? (Array.isArray(value) ? value.find((entry): entry is string => typeof entry === 'string') : undefined) : (typeof value === 'string' ? value : undefined)
}

interface SweepField {
  path: string[]
  array: boolean
  fieldClass: StringFieldClass
  fixture: MachineDefinition
  base: string
}

/** Every template and command field the schema carries, with a valid base. */
const SWEEP_FIELDS: SweepField[] = MACHINE_STRING_FIELDS
  .filter((spec) => spec.class.kind === 'template' || spec.class.kind === 'command')
  .map((spec) => {
    const fixture = fixtureFor(spec.path)
    const base = baseValue(fixture, spec.path, spec.array)
    assert.ok(
      base !== undefined && base.length > 0,
      `fixture: ${spec.path.join('.')} has a valid base value in the sweep definitions`,
    )
    return { path: [...spec.path], array: spec.array === true, fieldClass: spec.class, fixture, base }
  })

// ── Refusal helpers ──────────────────────────────────────────

interface Issue {
  path: Array<string | number>
  message: string
}

function issuesOf(definition: unknown): Issue[] | null {
  const result = MachineDefinitionSchema.safeParse(definition)
  if (result.success) return null
  return result.error.issues as Issue[]
}

function pathName(path: ReadonlyArray<string | number>): string {
  let name = ''
  for (const part of path) {
    if (typeof part === 'number') name += `[${part}]`
    else name += name.length > 0 ? `.${part}` : part
  }
  return name
}

/** The field's own path, or its first array element, is named by an issue. */
function assertRefusedAt(label: string, definition: unknown, path: readonly string[]): Issue {
  const issues = issuesOf(definition)
  assert.ok(issues !== null, `${label}: the definition is refused`)
  const issue = issues.find((entry) => (
    path.every((part, index) => entry.path[index] === part)
  ))
  assert.ok(issue, `${label}: an issue names ${path.join('.')}: ${JSON.stringify(issues)}`)
  return issue
}

function assertAccepted(label: string, definition: unknown): void {
  const result = MachineDefinitionSchema.safeParse(definition)
  assert.equal(
    result.success,
    true,
    `${label}: accepted${result.success ? '' : `: ${JSON.stringify(result.error.issues)}`}`,
  )
}

/** Put one field's value in the definition, array or scalar as the schema says. */
function setField(field: SweepField, value: string): unknown {
  return withPath(field.fixture, field.path, field.array ? [value] : value)
}

// ── 1. Every field × every injection pattern ─────────────────

console.log('Testing the injection sweep over every template and command field...')

const INJECTIONS: ReadonlyArray<{ name: string, value(base: string): string, kind: 'code' | 'placeholder' }> = [
  // A second motion/mode line smuggled in after a newline.
  { name: 'newline', kind: 'code', value: (base) => `${base}\nG0 Z-2` },
  // The same word with no space between the letter and its value.
  { name: 'compact word', kind: 'code', value: (base) => `${base}\nG0Z-2` },
  // G-code words are case-insensitive.
  { name: 'lowercase', kind: 'code', value: (base) => `${base}\ng0 z-2` },
  // A placeholder as the number of a G word.
  { name: 'G placeholder', kind: 'placeholder', value: (base) => `${base}\nG{toolNumber}` },
  // A placeholder as the number of an M word: M1 validates, M6 is a change.
  { name: 'M placeholder', kind: 'placeholder', value: (base) => `${base}\nM{toolNumber}` },
  // A placeholder joined to another word.
  { name: 'joined placeholder', kind: 'placeholder', value: (base) => `${base}\nT{toolNumber}5` },
]

/** A restricted class: every injection must be refused. */
function isRestricted(rule: TemplateRule): boolean {
  return rule.kind !== 'anything' && rule.kind !== 'tool-change' && rule.kind !== 'command'
}

let injectedCases = 0

for (const field of SWEEP_FIELDS) {
  const label = field.path.join('.')
  // The base itself is legal; otherwise the sweep would pass for the wrong
  // reason.
  assertAccepted(`${label}: base`, setField(field, field.base))

  const rule = field.fieldClass.kind === 'template' ? field.fieldClass.rule : null
  assert.ok(field.fieldClass.kind === 'command' || rule !== null, `fixture: ${label} is a template or command field`)

  for (const injection of INJECTIONS) {
    injectedCases += 1
    const text = injection.value(field.base)
    const definition = setField(field, text)

    if (field.fieldClass.kind === 'command') {
      // A single-command field is one line and one command: every injection is
      // extra content, refused before the pattern is matched.
      assertRefusedAt(`${label}: ${injection.name}`, definition, field.path)
      continue
    }

    if (rule !== null && isRestricted(rule)) {
      // No motion/mode/axis word and no placeholder-as-word in a restricted
      // template.
      assertRefusedAt(`${label}: ${injection.name}`, definition, field.path)
      continue
    }

    // The footer, the program end and the tool-change block deliberately
    // accept motion and mode words. They must still refuse a placeholder that
    // could spell a G/M word or join one.
    if (injection.kind === 'placeholder') {
      assertRefusedAt(`${label}: ${injection.name}`, definition, field.path)
    } else {
      assertAccepted(`${label}: ${injection.name}`, definition)
    }
  }
}

console.log(`  ${SWEEP_FIELDS.length} fields × ${INJECTIONS.length} injections = ${injectedCases} cases`)

// ── 2. The positions that are deliberately allowed ───────────

console.log('Testing the placeholder positions that are safe...')

{
  // T{toolNumber} and H{toolNumber} are a tool-change's own words.
  assertAccepted(
    'tool change: M6 T{toolNumber} and G43 H{toolNumber}',
    withPath(ROUTER, ['toolChange', 'commands'], ['M6 T{toolNumber}', 'G43 H{toolNumber}']),
  )
  // T is a parameter word anywhere it is substituted; H is a tool-length
  // offset, so only the tool-change block (which the emitter restarts after)
  // may state it.
  assertAccepted(
    'operation header: T{toolNumber}',
    withPath(ROUTER, ['program', 'operationHeader'], ['T{toolNumber}']),
  )
  assertAccepted(
    'operation header: S{rpm}',
    withPath(ROUTER, ['program', 'operationHeader'], ['M3 S{rpm}']),
  )
  assertAccepted(
    'operation header: F{feed}',
    withPath(ROUTER, ['program', 'operationHeader'], ['F{feed}']),
  )
  assertRefusedAt(
    'program header: H{toolNumber}',
    withPath(ROUTER, ['program', 'header'], ['G43 H{toolNumber}']),
    ['program', 'header'],
  )
  assertRefusedAt(
    'program footer: H{toolNumber}',
    withPath(ROUTER, ['program', 'footer'], ['G43 H{toolNumber}']),
    ['program', 'footer'],
  )
  assertAccepted(
    'inverse-time on is still inert',
    withPath(ROUTER, ['rotary', 'inverseTimeFeed', 'on'], 'G93'),
  )
  // P is the material number's fixed letter.
  assertAccepted(
    'material select: P{materialNumber}',
    withPath(PLASMA_MATERIAL, ['plasma', 'materialSelectCommand'], 'M190 P{materialNumber}'),
  )
  // The units and work-coordinate placeholders expand to whole commands.
  assertAccepted(
    'header: {unitsCommand} {wcsCommand}',
    withPath(ROUTER, ['program', 'header'], ['G90 {unitsCommand} {wcsCommand}']),
  )
  assertRefusedAt(
    'header: T{unitsCommand} joins a command to a letter',
    withPath(ROUTER, ['program', 'header'], ['T{unitsCommand}']),
    ['program', 'header'],
  )
}

// ── 2b. QtPlasmaC's documented forms and their close variants ─

console.log('Testing the documented QtPlasmaC torch, material and selector forms...')

interface PlasmaFormCase {
  label: string
  path: string[]
  value: string
}

/**
 * QtPlasmaC's documented forms, each cited in `templateRules.ts`:
 * - the `$` selector is a spindle number, non-negative or -1 for all tools
 *   (Multi-Tool and Mandatory Codes sections of the QtPlasmaC manual);
 * - `M190 Pn`, the `M66 P3 L3 Qn` wait, and the controller-owned feed
 *   expression (Automatic Material Handling section);
 * - LinuxCNC's `M62`-`M67` integer parameter words (M-code reference).
 */
const ACCEPTED_PLASMA_FORMS: PlasmaFormCase[] = [
  { label: 'torch on: M3 $0 S1', path: ['plasma', 'torchOnCommand'], value: 'M3 $0 S1' },
  { label: 'torch on: M3 S1 (backwards-compatible)', path: ['plasma', 'torchOnCommand'], value: 'M3 S1' },
  { label: 'torch on: M4 $1 S1', path: ['plasma', 'torchOnCommand'], value: 'M4 $1 S1' },
  { label: 'torch off: M5 $0', path: ['plasma', 'torchOffCommand'], value: 'M5 $0' },
  { label: 'torch off: M5 $1 (scribe)', path: ['plasma', 'torchOffCommand'], value: 'M5 $1' },
  { label: 'torch off: M5 $2 (spotting)', path: ['plasma', 'torchOffCommand'], value: 'M5 $2' },
  { label: 'torch off: M5 $-1 (all tools)', path: ['plasma', 'torchOffCommand'], value: 'M5 $-1' },
  { label: 'torch off: M5 (backwards-compatible)', path: ['plasma', 'torchOffCommand'], value: 'M5' },
  { label: 'material select: M190 P{materialNumber}', path: ['plasma', 'materialSelectCommand'], value: 'M190 P{materialNumber}' },
  { label: 'material select: M190 P3', path: ['plasma', 'materialSelectCommand'], value: 'M190 P3' },
  { label: 'material select: M190 P-1 (default material)', path: ['plasma', 'materialSelectCommand'], value: 'M190 P-1' },
  { label: 'material wait: M66 P3 L3 Q2', path: ['plasma', 'materialWaitCommand'], value: 'M66 P3 L3 Q2' },
  { label: 'material feed: the controller feed expression', path: ['plasma', 'materialFeedCommand'], value: 'F#<_hal[plasmac.cut-feed-rate]>' },
  { label: 'material feed: expression with a trailing comment', path: ['plasma', 'materialFeedCommand'], value: 'F#<_hal[plasmac.cut-feed-rate]> (loaded)' },
  { label: 'material feed: expression with a trailing semicolon comment', path: ['plasma', 'materialFeedCommand'], value: 'F#<_hal[plasmac.cut-feed-rate]> ; loaded' },
  { label: 'THC on: M63 P2', path: ['plasma', 'thcOnCommand'], value: 'M63 P2' },
  { label: 'THC off: M62 P2', path: ['plasma', 'thcOffCommand'], value: 'M62 P2' },
]

const REFUSED_PLASMA_FORMS: PlasmaFormCase[] = [
  { label: 'torch off: $-2 is not a spindle number', path: ['plasma', 'torchOffCommand'], value: 'M5 $-2' },
  { label: 'torch off: a bare $ is not a selector', path: ['plasma', 'torchOffCommand'], value: 'M5 $' },
  { label: 'torch off: a decimal selector', path: ['plasma', 'torchOffCommand'], value: 'M5 $0.5' },
  { label: 'torch off: a signed selector other than -1', path: ['plasma', 'torchOffCommand'], value: 'M5 $+1' },
  { label: 'torch off: an axis word after the selector', path: ['plasma', 'torchOffCommand'], value: 'M5 $0 X0' },
  { label: 'material feed: a different HAL pin', path: ['plasma', 'materialFeedCommand'], value: 'F#<_hal[other]>' },
  { label: 'material feed: a bare parameter number', path: ['plasma', 'materialFeedCommand'], value: 'F#1' },
  { label: 'material feed: an S expression instead of F', path: ['plasma', 'materialFeedCommand'], value: 'S#<_hal[plasmac.cut-feed-rate]>' },
  { label: 'material feed: an extra motion word', path: ['plasma', 'materialFeedCommand'], value: 'F#<_hal[plasmac.cut-feed-rate]> X0' },
  { label: 'material feed: an extra feed word', path: ['plasma', 'materialFeedCommand'], value: 'F#<_hal[plasmac.cut-feed-rate]> F1000' },
  { label: 'material feed: a material select is not a feed', path: ['plasma', 'materialFeedCommand'], value: 'M190 P3' },
  { label: 'material wait: a motion word', path: ['plasma', 'materialWaitCommand'], value: 'M66 P3 G0' },
  { label: 'material wait: an axis word', path: ['plasma', 'materialWaitCommand'], value: 'M66 P3 L3 Q2 X0' },
  { label: 'material wait: a T word M66 does not define', path: ['plasma', 'materialWaitCommand'], value: 'M66 P3 L3 Q2 T1' },
  { label: 'material wait: a decimal L word', path: ['plasma', 'materialWaitCommand'], value: 'M66 P3 L3.5 Q2' },
  { label: 'material select: an L word M190 does not define', path: ['plasma', 'materialSelectCommand'], value: 'M190 L3' },
  { label: 'material select: an axis word', path: ['plasma', 'materialSelectCommand'], value: 'M190 P3 X0' },
]

for (const form of ACCEPTED_PLASMA_FORMS) {
  assertAccepted(form.label, withPath(PLASMA_MATERIAL, form.path, form.value))
}
for (const form of REFUSED_PLASMA_FORMS) {
  assertRefusedAt(form.label, withPath(PLASMA_MATERIAL, form.path, form.value), form.path)
}
console.log(`  ${ACCEPTED_PLASMA_FORMS.length} accepted and ${REFUSED_PLASMA_FORMS.length} refused QtPlasmaC forms`)

// ── 3. Comment syntax: the exact per-dialect allowlist ───────

console.log('Testing the comment marker is one of the dialect\'s exact forms...')

interface CommentCase {
  label: string
  definition: unknown
  path: readonly string[]
}

const COMMENT_CASES: CommentCase[] = []

// Free text and newlines in the prefix.
for (const prefix of ['G91', 'G91\n', '', ' ', ' ;', "'", '(%']) {
  COMMENT_CASES.push({
    label: `gcode commentPrefix ${JSON.stringify(prefix)}`,
    definition: withPath(ROUTER, ['program', 'commentPrefix'], prefix),
    path: ['program', 'commentPrefix'],
  })
}
// A valid prefix with a wrong suffix, including `(` paired with `;`'s empty
// suffix.
COMMENT_CASES.push({
  label: 'gcode commentPrefix ( with an empty suffix',
  definition: withCommentPair(ROUTER, '(', ''),
  path: ['program', 'commentSuffix'],
})
for (const suffix of ['G91', ')\nM8', ';', '(', ' )']) {
  COMMENT_CASES.push({
    label: `gcode commentSuffix ${JSON.stringify(suffix)}`,
    definition: withPath(ROUTER, ['program', 'commentSuffix'], suffix),
    path: ['program', 'commentSuffix'],
  })
}
// ShopBot's apostrophe is the only opensbp form.
for (const prefix of ['(', ';', 'G91', "''", "'\n"]) {
  COMMENT_CASES.push({
    label: `opensbp commentPrefix ${JSON.stringify(prefix)}`,
    definition: withPath(SHOPBOT, ['program', 'commentPrefix'], prefix),
    path: ['program', 'commentPrefix'],
  })
}
COMMENT_CASES.push({
  label: 'opensbp commentSuffix is not empty',
  definition: withPath(SHOPBOT, ['program', 'commentSuffix'], 'M8'),
  path: ['program', 'commentSuffix'],
})

for (const commentCase of COMMENT_CASES) {
  const issue = assertRefusedAt(commentCase.label, commentCase.definition, commentCase.path)
  assert.ok(
    commentCase.path[1] === 'commentPrefix' ? issue.message.includes('comment form') : issue.message.includes('does not close'),
    `${commentCase.label}: the refusal explains the allowed form: ${issue.message}`,
  )
}

// The allowlisted pairs are accepted by both dialects.
for (const [prefix, suffix] of [['(', ')'], [';', '']] as const) {
  assertAccepted(
    `gcode comment form ${JSON.stringify(prefix)}`,
    withCommentPair(ROUTER, prefix, suffix),
  )
}
assertAccepted("opensbp comment form '", withCommentPair(SHOPBOT, "'", ''))

// Validation uses the dialect's comment forms, never the definition's field:
// with either G-code marker declared, both real G-code comment forms hide
// nothing, while the same words as code are still refused.
{
  const semicolon = withCommentPair(ROUTER, ';', '')
  assertAccepted(
    'a parenthesised comment is still a G-code comment when the field says ;',
    withPath(semicolon, ['feedSpeed', 'spindleOnCW'], '( M5 )'),
  )
  const paren = withCommentPair(ROUTER, '(', ')')
  assertAccepted(
    'a semicolon comment is still a G-code comment when the field says (',
    withPath(paren, ['feedSpeed', 'spindleOnCW'], '; M5'),
  )
  // The old bypass, directly: a free-text marker must not turn code into a
  // comment for the validator. `templateRuleViolations` reads the dialect, so
  // the G91 is still a G91.
  const evil = {
    ...structuredClone(ROUTER),
    program: { ...structuredClone(ROUTER.program), commentPrefix: 'G91' },
    feedSpeed: { ...structuredClone(ROUTER.feedSpeed), spindleOnCW: 'G91' },
  }
  const violations = templateRuleViolations(evil)
  assert.ok(
    violations.some((entry) => pathName(entry.path) === 'program.commentPrefix'),
    `the free-text marker is refused: ${JSON.stringify(violations)}`,
  )
  assert.ok(
    violations.some((entry) => pathName(entry.path) === 'feedSpeed.spindleOnCW' && entry.message.includes('"G91"')),
    `the validator still reads G91 as code, not as the user's comment: ${JSON.stringify(violations)}`,
  )
}

// ── 4. Single-command fields are one line ────────────────────

console.log('Testing single-command fields reject lines and semicolons...')

{
  const feed = SWEEP_FIELDS.find((field) => field.path.join('.') === 'feedSpeed.feedCommand')
  assert.ok(feed, 'fixture: the feed command is in the sweep')
  for (const text of ['F\nF', 'F\nG91', 'F;F', 'F;G91', 'F\r\nF', 'F F', 'F\tF']) {
    assertRefusedAt(`feedCommand ${JSON.stringify(text)}`, setField(feed, text), feed.path)
  }
  assertAccepted('feedCommand F', setField(feed, 'F'))
}

// ── 5. ShopBot's apostrophe command marker and template comments ──

console.log('Testing the ShopBot command marker and template comments...')

{
  assertAccepted("shopbot rapid: ' G0", withPath(SHOPBOT, ['motion', 'rapidCommand'], "' G0"))
  assertRefusedAt(
    "shopbot rapid with an axis: ' G0 X0",
    withPath(SHOPBOT, ['motion', 'rapidCommand'], "' G0 X0"),
    ['motion', 'rapidCommand'],
  )
  assertAccepted(
    'shopbot header comment template',
    withPath(SHOPBOT, ['program', 'header'], ["' {programName}"]),
  )
  // `;` is not a ShopBot comment, so a semicolon line is code and fails the
  // header class.
  assertRefusedAt(
    'shopbot header: a semicolon is not a comment',
    withPath(SHOPBOT, ['program', 'header'], ['; G91']),
    ['program', 'header'],
  )
}

console.log(`gcode template injection sweep passed (${injectedCases + COMMENT_CASES.length} injected cases)`)
