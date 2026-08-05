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
 * Run with: npx tsx src/types/operationDescriptions.test.ts
 */

import { OPERATION_DESCRIPTION_SEGMENT, operationDescriptions } from './operationDescriptions'
import type { OperationKind } from './project'
import { camEn } from '../i18n/locales/en/cam'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const catalog = camEn as Record<string, string>
const kinds = Object.keys(operationDescriptions) as OperationKind[]

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

testEveryKindHasASegment()
testTitleAndDescriptionKeysExist()
testKeyPointCountsMatchTheCatalog()

console.log('operationDescriptions parity tests passed')
