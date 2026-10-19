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

import assert from 'node:assert/strict'
import {
  countCommandPatterns,
  formatBytes,
  measureSerialization,
  summarizeProject,
} from './metrics'

const base64 = 'A'.repeat(400)
const project = {
  features: [{ id: 'a' }, { id: 'b' }],
  featureDefinitions: { a: {}, b: {}, c: {} },
  operations: [{ id: 'op' }],
  tools: [{ id: 'tool-1' }, { id: 'tool-2' }, { id: 'tool-3' }],
  annotations: [{ id: 'dim' }],
  model: {
    positions: base64,
    nested: { preview: base64 },
  },
}

const json = JSON.stringify(project)
const jsonBytes = new TextEncoder().encode(json).length
const summary = summarizeProject(project, jsonBytes)

assert.equal(summary.jsonBytes, jsonBytes)
assert.equal(summary.featureCount, 2)
assert.equal(summary.definitionCount, 3)
assert.equal(summary.operationCount, 1)
assert.equal(summary.toolCount, 3)
assert.equal(summary.annotationCount, 1)
assert.equal(summary.embeddedAssetCount, 2)
assert.equal(summary.embeddedAssetBytes, 600)
assert.equal(summary.largestStringBytes, 400)

const timing = measureSerialization(project, 1)
assert.ok(timing.snapshotBytes > 0)
assert.equal(timing.history100Bytes, timing.snapshotBytes * 100)
assert.ok(timing.parseMs >= 0)
assert.ok(timing.stringifyMs >= 0)
assert.ok(timing.cloneMs >= 0)

const inventory = countCommandPatterns(`
  export interface CommandDescriptor { id: string; label: string }
  const command = { id: 'copy', label: 'Copy', onActivate: () => undefined, shortcut: 'Ctrl+C' }
`)
// The static counter counts interface declarations too; the CLI report labels
// these as source-pattern counts, not as a runtime command total.
assert.equal(inventory.labels, 2)
assert.equal(inventory.ids, 2)
assert.equal(inventory.activations, 1)
assert.equal(inventory.shortcuts, 1)
assert.equal(inventory.commandTypes, 1)

assert.equal(formatBytes(0), '0 B')
assert.equal(formatBytes(1024), '1.0 KB')
assert.equal(formatBytes(1536), '1.5 KB')
assert.equal(formatBytes(1024 * 1024), '1.0 MB')

console.log('baselineMetrics: ok')
