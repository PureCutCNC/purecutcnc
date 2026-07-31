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
 * Cross-format agreement: every "mill" fixture across all seven adapters
 * configures the same physical controller (EdingCNC / USBCNC), just via
 * seven different CAM vendors' own post-processor authors. The G/M-code
 * *identity* the controller responds to should therefore agree across every
 * adapter's output, even though each source's formatting convention (leading
 * zeros, IJ vs. R arc specification) legitimately differs. Comparing seven
 * independent adapters against one real machine like this catches a bug a
 * single adapter's own fixture-grounded test cannot: one adapter quietly
 * misreading its own source's G/M-codes.
 *
 * Deliberately compares raw adapter `overrides`, not the merged
 * MachineDefinition: merging onto the generic baseline would make a source
 * that found *nothing* for a field silently "agree" with everyone else via
 * the shared fallback, masking exactly the kind of miss this test exists to
 * catch. A field is only compared when the adapter actually reported a value.
 *
 * Run with: npx tsx src/postProcessorConverter/crossFormatAgreement.test.ts
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { visualMillAdapter } from './adapters/visualMill'
import { vectricEstlcamAdapter } from './adapters/vectricEstlcam'
import { artcamAdapter } from './adapters/artcam'
import { ecamAdapter } from './adapters/ecam'
import { sheetcamAdapter } from './adapters/sheetcam'
import { autodeskCpsAdapter } from './adapters/autodeskCps'
import { mastercamPstAdapter } from './adapters/mastercamPst'
import type { MachineDefinitionDraft, SourceAdapter } from './types'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function loadFixture(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
}

const MILL_SOURCES: Array<{ name: string; adapter: SourceAdapter; path: string }> = [
  { name: 'visual-mill', adapter: visualMillAdapter, path: './__fixtures__/visualMill/usbcnc.spm' },
  { name: 'vectric-estlcam', adapter: vectricEstlcamAdapter, path: './__fixtures__/vectricEstlcam/estlcam-eding-vectric-v11.pp' },
  { name: 'artcam', adapter: artcamAdapter, path: './__fixtures__/artcam/edingcnc-mm.con' },
  { name: 'ecam', adapter: ecamAdapter, path: './__fixtures__/ecam/fe1510-edingcnc-fraesmaschine-mm.xml' },
  { name: 'sheetcam', adapter: sheetcamAdapter, path: './__fixtures__/sheetcam/edingcnc.scpost' },
  { name: 'autodesk-cps', adapter: autodeskCpsAdapter, path: './__fixtures__/autodeskCps/edingcnc-original-from-autodesk.cps' },
  { name: 'mastercam-pst', adapter: mastercamPstAdapter, path: './__fixtures__/mastercamPst/edingcnc-mastercam.pst' },
]

const results: Array<{ name: string; overrides: MachineDefinitionDraft }> = MILL_SOURCES.map(({ name, adapter, path }) => {
  const text = loadFixture(path)
  return { name, overrides: adapter.convert(text, path).overrides }
})

/** "G00" -> "G0", "M03" -> "M3". Different padding conventions between two
 *  post authors describing the same code is not a real disagreement. */
function normalizeCode(code: string): string {
  const match = /^([A-Za-z])0*(\d+(?:\.\d+)?)$/.exec(code)
  return match ? `${match[1].toUpperCase()}${match[2]}` : code
}

interface Entry {
  name: string
  value: string
}

function collect(getter: (overrides: MachineDefinitionDraft) => string | null | undefined): Entry[] {
  const entries: Entry[] = []
  for (const { name, overrides } of results) {
    const value = getter(overrides)
    if (value !== undefined && value !== null) entries.push({ name, value })
  }
  return entries
}

/** Every source that actually derived this field must agree after
 *  normalization. A source that left it undetermined is excluded from the
 *  comparison entirely, not counted as a pass — the point is to catch
 *  adapters that disagree, not to launder an omission into false agreement. */
function assertAgreement(label: string, getter: (overrides: MachineDefinitionDraft) => string | null | undefined): void {
  const entries = collect(getter)
  assert(
    entries.length >= 4,
    `${label}: expected most of the 7 sources to have derived this field, only got ${entries.length}: ${JSON.stringify(entries)}`,
  )
  const normalized = new Set(entries.map((e) => normalizeCode(e.value)))
  assert(
    normalized.size === 1,
    `${label}: sources disagree after normalization: ${JSON.stringify(entries)} -> ${JSON.stringify([...normalized])}`,
  )
  console.log(`  ${label}: ${[...normalized][0]}  (${entries.map((e) => e.name).join(', ')})`)
}

console.log('Cross-format agreement — every fixture below describes the same EdingCNC/USBCNC controller:')

assertAgreement('motion.rapidCommand', (o) => o.motion?.rapidCommand)
assertAgreement('motion.linearCommand', (o) => o.motion?.linearCommand)
assertAgreement('motion.cwArcCommand', (o) => o.motion?.cwArcCommand)
assertAgreement('motion.ccwArcCommand', (o) => o.motion?.ccwArcCommand)
assertAgreement('feedSpeed.spindleOnCW', (o) => o.feedSpeed?.spindleOnCW)
assertAgreement('feedSpeed.spindleOnCCW', (o) => o.feedSpeed?.spindleOnCCW)
assertAgreement('feedSpeed.spindleOff', (o) => o.feedSpeed?.spindleOff)
assertAgreement('coolant.floodOnCommand', (o) => o.coolant?.floodOnCommand)
assertAgreement('coolant.coolantOffCommand', (o) => o.coolant?.coolantOffCommand)

// arcFormat is a genuine, expected EXCEPTION to "everyone agrees": EdingCNC's
// firmware accepts both I/J and R arc specification, and the ArtCAM and
// Mastercam post authors happened to configure R while the other five chose
// I/J for this same controller. Asserting the split (not silent agreement)
// turns this from "a field I didn't bother to check" into a documented,
// intentional fact that a future regression would visibly break.
const arcFormats = collect((o) => o.motion?.arcFormat)
console.log(`  motion.arcFormat (expected to legitimately vary by post author): ${JSON.stringify(arcFormats)}`)
assert(arcFormats.length >= 4, `expected most sources to have derived an arcFormat, got ${arcFormats.length}`)
assert(arcFormats.every((e) => e.value === 'ij' || e.value === 'r'), 'every derived arcFormat should be a valid enum value')
assert(
  new Set(arcFormats.map((e) => e.value)).size === 2,
  'expected both arc formats to appear across these sources (mostly I/J, with ArtCAM and Mastercam choosing R) — if this becomes 1, check whether an adapter regressed or a fixture genuinely changed',
)
const rFormatSources = new Set(arcFormats.filter((e) => e.value === 'r').map((e) => e.name))
assert(rFormatSources.has('artcam') && rFormatSources.has('mastercam-pst'), `expected ArtCAM and Mastercam specifically to be the R-format sources, got: ${[...rFormatSources].join(', ')}`)

console.log('crossFormatAgreement.test: all assertions passed')
