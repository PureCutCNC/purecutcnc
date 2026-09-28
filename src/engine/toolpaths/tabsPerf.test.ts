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
 * CPU-ratio guard for the tab pass's box reject (issue #916).
 *
 * Tabs are project-wide, so on a nested sheet every cut move of an edge route
 * met every tab on the sheet, and each meeting was a full segment-polygon clip.
 * A move now tests the tab's box first and clips only when the boxes touch.
 *
 * Subject: cut moves at a Z the tabs stand across, with every tab far away in
 * XY — the box rejects every pair. Reference: the same moves above every tab
 * top, which the Z test in `splitCutMoveAcrossTabsFrom` rejects before any clip
 * or box is looked at, so the box reject cannot help it. Both halves expand the
 * same tabs and walk the same moves, so only the reject moves the ratio.
 *
 * Run with: npx tsx src/engine/toolpaths/tabsPerf.test.ts
 */

import { defaultTool, newProject, type Operation, type Project, type Tab } from '../../types/project'
import { cpuRatio } from '../../test/cpuRatio'
import { applyTabsToEdgeRoute } from './tabs'
import type { ToolpathMove, ToolpathResult } from './types'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error('Assertion failed: ' + message)
}

const TAB_TOP = 3
const MOVE_COUNT = 3_000
const TAB_COUNT = 300

function project(): Project {
  const base = newProject()
  // A nest's worth of tabs, all far from the moves below.
  const tabs: Tab[] = Array.from({ length: TAB_COUNT }, (_, index) => ({
    id: `t${index}`,
    name: `t${index}`,
    x: 1_000 + (index % 20) * 20,
    y: 1_000 + Math.floor(index / 20) * 20,
    w: 8,
    h: 8,
    z_top: TAB_TOP,
    z_bottom: 0,
    visible: true,
  }))
  return {
    ...base,
    meta: { ...base.meta, units: 'mm' },
    tools: [{ ...defaultTool('mm', 1), id: 't1', diameter: 6, units: 'mm' }],
    tabs,
  }
}

const operation = {
  id: 'op1',
  name: 'Edge',
  kind: 'edge_route_outside',
  pass: 'rough',
  toolRef: 't1',
  stockToLeaveRadial: 0,
} as Operation

function cutAt(z: number): ToolpathResult {
  const moves: ToolpathMove[] = Array.from({ length: MOVE_COUNT }, (_, index) => ({
    kind: 'cut',
    from: { x: index * 0.1, y: 0, z },
    to: { x: (index + 1) * 0.1, y: 0, z },
  }))
  return { operationId: operation.id, moves, warnings: [], bounds: null }
}

const tabbed = project()
const subject = cutAt(1)
const reference = cutAt(TAB_TOP + 2)

// Warm both paths, and confirm neither fixture is touched by a tab at all.
assert(applyTabsToEdgeRoute(tabbed, operation, subject) === subject, 'subject moves must miss every tab')
assert(applyTabsToEdgeRoute(tabbed, operation, reference) === reference, 'reference moves must miss every tab')

const { ratio, subjectMs, referenceMs } = cpuRatio(
  { run: () => { applyTabsToEdgeRoute(tabbed, operation, subject) } },
  { run: () => { applyTabsToEdgeRoute(tabbed, operation, reference) } },
)
assert(referenceMs > 0, 'reference must do measurable work or the ratio is meaningless')

console.log(`tab pass box reject: subject ${subjectMs.toFixed(1)} ms, reference ${referenceMs.toFixed(1)} ms, ratio ${ratio.toFixed(2)}`)

// Measured on an Intel MacBookPro15,1, three runs each, with another
// single-threaded job sharing the machine:
//   with the box reject:           ratio 1.17-1.18 (subject 47 ms, reference 40-41 ms)
//   box reject removed (mutation): ratio 22.86-24.01 (subject 993-996 ms, reference 42-43 ms),
//                                  reference column unchanged
// Threshold at the geometric mid-point of the worst pair, sqrt(1.18 x 22.86) = 5.2:
// about 4.4x headroom either side.
assert(
  ratio < 5.2,
  `moves far from every tab must not be clipped against each one (ratio ${ratio.toFixed(2)})`,
)

console.log('tabsPerf: ok')
