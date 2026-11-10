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
 * #1177 bal-a correction 1: export Frank's rotary programs and count the
 * program-shape measures the handoff asks for.
 *
 *   npx tsx scripts/issue-1177-bal-export.ts work/bolt-test-02-x-mm.camj [outDir] [--before]
 *
 * For op0195-op0198 (the Hex rough and finish, the Turn rough and finish; the
 * finish on the 1/8 in ball) it writes the posted program and reports, from the **G-code**:
 *
 * - fed blocks and A moves (a motion block that changes A);
 * - A direction flips (a sign change in consecutive A moves, shortest arc);
 * - fed blocks whose programmed time is under 10 ms. This machine's rotary post
 *   uses `G93` (inverse time), so a block's time is exactly `60 / F` seconds --
 *   no radius or feed reconstruction, and no assumption about the tip;
 * - adjacent A-rate jumps over 1.5x, where an A move's rate is `|dA| / time`;
 * - G0 Z lifts: rapid blocks that raise Z.
 *
 * The project carries no selected machine (`selectedMachineId: null`), so the
 * script selects the bundled `grbl-rotary-a` definition it is posted with. That
 * is the same 4-axis GRBL dialect the earlier rounds' `.nc` files came from.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { normalizeProject } from '../src/store/helpers/projectFormat'
import { computeOperationToolpath } from '../src/engine/toolpaths/generateOperation'
import { normalizeToolForProject } from '../src/engine/toolpaths/geometry'
import { BUNDLED_DEFINITIONS } from '../src/engine/gcode/definitions'
import { runPostProcessor } from '../src/engine/gcode/postprocessor'
import type { Project } from '../src/types/project'

const MACHINE_ID = 'grbl-rotary-a'
const OPERATIONS = ['op0195', 'op0196', 'op0197', 'op0198'] as const

interface Stats {
  readonly lines: number
  readonly fedBlocks: number
  readonly aMoves: number
  readonly aFlips: number
  readonly under10ms: number
  readonly aRateJumps: number
  readonly g0ZLifts: number
}

function loadProject(path: string): Project {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  return normalizeProject(raw as Parameters<typeof normalizeProject>[0])
}

/**
 * One G-code motion block, reduced to what the counts need. G-code is modal:
 * `F`, `X`, `Y`, `Z`, `A` persist until rewritten, and a line with no `G` word
 * continues the last motion mode.
 */
interface Block {
  readonly motion: 'G0' | 'G1' | 'G2' | 'G3' | null
  readonly fromA: number
  readonly toA: number
  readonly fromZ: number
  readonly toZ: number
  readonly seconds: number
}

function parseProgram(gcode: string): Block[] {
  const blocks: Block[] = []
  let motion: Block['motion'] = null
  let inverseTime = false
  let feed = Number.NaN
  let z = 0
  let a = 0
  for (const raw of gcode.split('\n')) {
    const line = raw.replace(/;.*$/, '').trim()
    if (line.length === 0 || line.startsWith('(')) continue
    const words = line.match(/[A-Z][-+]?\d*\.?\d+/g) ?? []
    const get = (letter: string): number | null => {
      const word = words.find((entry) => entry.startsWith(letter))
      if (word === undefined) return null
      const value = Number(word.slice(1))
      return Number.isFinite(value) ? value : null
    }
    const g = [...line.matchAll(/G(\d+(?:\.\d+)?)/g)].map((match) => `G${Math.round(Number(match[1]))}`)
    if (g.includes('G93')) inverseTime = true
    if (g.includes('G94')) inverseTime = false
    const nextMotion = g.find((entry) => entry === 'G0' || entry === 'G1' || entry === 'G2' || entry === 'G3')
    if (nextMotion !== undefined) motion = nextMotion as Block['motion']

    const fromZ = z
    const fromA = a
    const nz = get('Z')
    const na = get('A')
    const nf = get('F')
    const moves = get('X') !== null || get('Y') !== null || nz !== null || na !== null
    if (nz !== null) z = nz
    if (na !== null) a = na
    if (nf !== null) feed = nf
    if (!moves || motion === null) continue
    // G93: F is inverse time, so the block runs 1/F minutes. G94 is not used for
    // a rotary feed on this post, so its blocks carry no time here.
    const seconds = inverseTime && Number.isFinite(feed) && feed > 0 ? 60 / feed : Number.NaN
    blocks.push({ motion, fromA, toA: a, fromZ, toZ: z, seconds })
  }
  return blocks
}

function deltaA(from: number, to: number): number {
  let delta = to - from
  while (delta > 180) delta -= 360
  while (delta <= -180) delta += 360
  return delta
}

function statsOf(gcode: string): Stats {
  const blocks = parseProgram(gcode)
  const fed = blocks.filter((block) => block.motion === 'G1' || block.motion === 'G2' || block.motion === 'G3')
  const aMoves = fed.filter((block) => Math.abs(block.toA - block.fromA) > 1e-9)
  let flips = 0
  let previousSign = 0
  for (const block of aMoves) {
    const sign = Math.sign(deltaA(block.fromA, block.toA))
    if (sign === 0) continue
    if (previousSign !== 0 && sign !== previousSign) flips++
    previousSign = sign
  }
  const under10ms = fed.filter((block) => Number.isFinite(block.seconds) && block.seconds < 0.01).length
  let rateJumps = 0
  for (let i = 1; i < aMoves.length; i++) {
    const left = rate(aMoves[i - 1])
    const right = rate(aMoves[i])
    if (!(left > 0) || !(right > 0)) continue
    if (Math.max(left, right) / Math.min(left, right) > 1.5) rateJumps++
  }
  const g0ZLifts = blocks.filter((block) => block.motion === 'G0'
    && block.toZ > block.fromZ + 1e-9).length
  return {
    lines: gcode.split('\n').length,
    fedBlocks: fed.length,
    aMoves: aMoves.length,
    aFlips: flips,
    under10ms,
    aRateJumps: rateJumps,
    g0ZLifts,
  }
}

function rate(block: Block): number {
  if (!Number.isFinite(block.seconds) || block.seconds <= 0) return 0
  return Math.abs(deltaA(block.fromA, block.toA)) / block.seconds
}

function main(): void {
  const [path, outArg, mode] = process.argv.slice(2)
  if (!path) throw new Error('usage: npx tsx scripts/issue-1177-bal-export.ts <project.camj> [outDir] [--before]')
  const outDir = resolve(outArg ?? 'work')
  const label = mode === '--before' ? 'before' : 'after'
  const project = loadProject(path)
  const definition = BUNDLED_DEFINITIONS.find((entry) => entry.id === MACHINE_ID)
  if (!definition) throw new Error(`bundled definition ${MACHINE_ID} is missing`)
  project.meta.selectedMachineId = definition.id
  project.meta.machineDefinitions = [definition]

  const rows: Array<{ id: string; name: string; stats: Stats; file: string }> = []
  for (const id of OPERATIONS) {
    const operation = project.operations.find((entry) => entry.id === id)
    if (!operation) {
      console.log(`${id}: absent`)
      continue
    }
    const toolRecord = project.tools.find((entry) => entry.id === operation.toolRef)
    if (!toolRecord) throw new Error(`${id} has no tool`)
    const envelope = computeOperationToolpath(project, operation)
    if (!envelope) throw new Error(`${id} produced no toolpath`)
    const tool = normalizeToolForProject(toolRecord, project)
    const posted = runPostProcessor({
      project,
      definition,
      operations: [{ operation, toolpath: envelope.result, tool }],
      options: {
        emitToolChanges: false,
        emitCoolant: false,
        programName: `${project.meta.name}-${id}-${label}`,
      },
    })
    const file = join(outDir, `${project.meta.name}-1177-${id}-${label}.nc`)
    writeFileSync(file, posted.gcode)
    const stats = statsOf(posted.gcode)
    rows.push({ id, name: operation.name, stats, file })
  }

  console.log(`\n${label}: exported program shape (G93 inverse time, so block time = 60/F s)`)
  console.log('op      name             fedBlocks  A moves  A flips  <10ms  A-rate>1.5x  G0 Z lifts')
  for (const row of rows) {
    const stats = row.stats
    console.log(`${row.id.padEnd(7)} ${row.name.padEnd(16)} ${String(stats.fedBlocks).padStart(9)} `
      + `${String(stats.aMoves).padStart(8)} ${String(stats.aFlips).padStart(8)} `
      + `${String(stats.under10ms).padStart(6)} ${String(stats.aRateJumps).padStart(11)} `
      + `${String(stats.g0ZLifts).padStart(11)}   ${row.file}`)
  }
  writeFileSync(join(outDir, `issue-1177-bal-export-${label}.json`), JSON.stringify(rows, null, 2))
}

main()
