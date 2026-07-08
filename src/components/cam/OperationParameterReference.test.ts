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
 * Tests for OperationParameterReference pure data.
 *
 * Run with: npx tsx src/components/cam/OperationParameterReference.test.ts
 */

import { OPERATION_PARAM_REF_KINDS, operationParamRefLabel } from './operationParamRefData'
import type { OperationParamRefKind } from './operationParamRefData'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function testNoDuplicateKinds(): void {
  const seen = new Set<string>()
  for (const kind of OPERATION_PARAM_REF_KINDS) {
    assert(!seen.has(kind), `duplicate kind: ${kind}`)
    seen.add(kind)
  }
}

function testAllKindsHaveNonEmptyLabel(): void {
  for (const kind of OPERATION_PARAM_REF_KINDS) {
    const label = operationParamRefLabel(kind as OperationParamRefKind)
    assert(typeof label === 'string' && label.length > 0, `empty label for kind: ${kind}`)
  }
}

function testAllLabelsAreUnique(): void {
  const labels = new Set<string>()
  for (const kind of OPERATION_PARAM_REF_KINDS) {
    const label = operationParamRefLabel(kind as OperationParamRefKind)
    assert(!labels.has(label), `duplicate label for kind ${kind}: ${label}`)
    labels.add(label)
  }
}

function testLabelRecordIsExhaustive(): void {
  // TypeScript verifies exhaustiveness at compile time; this is a runtime
  // sanity check that every kind in the array has a corresponding label entry.
  assert(OPERATION_PARAM_REF_KINDS.length === 22, `expected 22 kinds, got ${OPERATION_PARAM_REF_KINDS.length}`)
}

testNoDuplicateKinds()
testAllKindsHaveNonEmptyLabel()
testAllLabelsAreUnique()
testLabelRecordIsExhaustive()

console.log('OperationParameterReference tests passed')
