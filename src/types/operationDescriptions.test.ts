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
 * Parity between `operationDescriptions` and the `cam.opDesc.*` catalog.
 *
 * The add-operation panel renders one bullet per `keyPoints` entry but reads the
 * text from the catalog by index. A description with more key points than the
 * catalog has keys renders trailing blank bullets in every language, and one
 * with fewer silently hides a translated string. Neither is a type error, so it
 * is checked here.
 *
 * It also holds the English text to the strategies each operation offers
 * (issue #795): the full description and the key points must both name every
 * pattern `offeredPocketPatterns` returns, and for drilling every `DrillType`.
 * Those lists went stale once already, silently, when seeded circles,
 * trochoidal, constant scallop, helical and countersink shipped.
 *
 * Run with: npx tsx src/types/operationDescriptions.test.ts
 */

import { OPERATION_DESCRIPTION_SEGMENT, operationDescriptions } from './operationDescriptions'
import type { DrillType, OperationKind, PocketPattern } from './project'
import { camEn } from '../i18n/locales/en/cam'
import { offeredPocketPatterns } from '../engine/toolpaths/pocketPatterns'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const catalog = camEn as Record<string, string>
const kinds = Object.keys(operationDescriptions) as OperationKind[]

type CamKey = keyof typeof camEn

// The dropdown labels. Full records, so a new pattern or drill type does not
// compile until it has a label here, and the naming test below then fails until
// the descriptions mention it.
const PATTERN_LABEL_KEYS: Record<PocketPattern, CamKey> = {
  offset: 'cam.pocketPattern.offset',
  seeded_offset: 'cam.pocketPattern.seededOffset',
  parallel: 'cam.pocketPattern.parallel',
  trochoidal: 'cam.pocketPattern.trochoidal',
  waterline: 'cam.pocketPattern.waterline',
  constant_scallop: 'cam.pocketPattern.constantScallop',
}

const DRILL_TYPE_LABEL_KEYS: Record<DrillType, CamKey> = {
  simple: 'cam.drillType.simple',
  peck: 'cam.drillType.peck',
  dwell: 'cam.drillType.dwell',
  chip_breaking: 'cam.drillType.chipBreaking',
  helical: 'cam.drillType.helical',
  countersink: 'cam.drillType.countersink',
}

function offeredOptionLabels(kind: OperationKind): string[] {
  const keys = kind === 'drilling'
    ? Object.values(DRILL_TYPE_LABEL_KEYS)
    : offeredPocketPatterns(kind).map((pattern) => PATTERN_LABEL_KEYS[pattern])
  return keys.map((key) => camEn[key])
}

function testEveryKindHasASegment(): void {
  for (const kind of kinds) {
    assert(
      typeof OPERATION_DESCRIPTION_SEGMENT[kind] === 'string',
      `${kind} has no catalog segment`,
    )
  }
}

function testTitleAndDescriptionKeysExist(): void {
  for (const kind of kinds) {
    const segment = OPERATION_DESCRIPTION_SEGMENT[kind]
    for (const slot of ['title', 'fullDescription']) {
      assert(
        catalog[`cam.opDesc.${segment}.${slot}`] !== undefined,
        `missing cam.opDesc.${segment}.${slot}`,
      )
    }
  }
}

function testKeyPointCountsMatchTheCatalog(): void {
  for (const kind of kinds) {
    const segment = OPERATION_DESCRIPTION_SEGMENT[kind]
    const expected = operationDescriptions[kind].keyPoints.length

    for (let index = 0; index < expected; index += 1) {
      assert(
        catalog[`cam.opDesc.${segment}.keyPoint.${index}`] !== undefined,
        `${kind} renders ${expected} key points but cam.opDesc.${segment}.keyPoint.${index} `
          + 'is missing — that bullet renders blank in every language',
      )
    }

    assert(
      catalog[`cam.opDesc.${segment}.keyPoint.${expected}`] === undefined,
      `cam.opDesc.${segment}.keyPoint.${expected} exists but ${kind} only renders `
        + `${expected} key points — that translation is never shown`,
    )
  }
}

function testDescriptionsNameEveryOfferedOption(): void {
  for (const kind of kinds) {
    const segment = OPERATION_DESCRIPTION_SEGMENT[kind]
    const description = catalog[`cam.opDesc.${segment}.fullDescription`].toLowerCase()
    const keyPoints = operationDescriptions[kind].keyPoints.map(
      (_, index) => catalog[`cam.opDesc.${segment}.keyPoint.${index}`].toLowerCase(),
    )

    for (const label of offeredOptionLabels(kind)) {
      const needle = label.toLowerCase()
      assert(
        description.includes(needle),
        `cam.opDesc.${segment}.fullDescription does not name the "${label}" option ${kind} offers`,
      )
      assert(
        keyPoints.some((point) => point.includes(needle)),
        `no cam.opDesc.${segment}.keyPoint.* names the "${label}" option ${kind} offers`,
      )
    }
  }
}

testEveryKindHasASegment()
testTitleAndDescriptionKeysExist()
testKeyPointCountsMatchTheCatalog()
testDescriptionsNameEveryOfferedOption()

console.log('operationDescriptions parity tests passed')
