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
 * Sequence verdict for G-code-pierced plasma programs (issue #983).
 *
 * `grbl-gvalidate` proves the words parse; it cannot prove the torch sequence
 * is safe or complete, because grbl-sim never triggers the probe pin. These
 * rules read the program we actually emit and decide whether each cut is the
 * approved one: safe Z, probe, set Z zero on the sheet, pierce-height rapid,
 * torch on (M3, never M4), dwell in seconds, drop to cut height at the plunge
 * feed, leads/contour at the cut feed, torch off, safe Z — with no rapid while
 * the torch is on and every cutting move inside a torch pair.
 *
 * Pure functions, so the rules are unit-tested without a controller
 * (`verdict.test.ts`), and reusable on any program text.
 */

/** What a line does, with modal motion and feed resolved. */
export interface ParsedLine {
  line: number
  text: string
  /** Last G0/G1/G2/G3 in effect, including modal continuation. */
  motion: 'G0' | 'G1' | 'G2' | 'G3' | null
  /** True when the line itself commands motion: a G0-G3 word or an axis word. */
  commandsMotion: boolean
  /** True when this line carries a G38.x probe. */
  probe: boolean
  /** The Z word of a G10 set-zero, or null when the line is not one. */
  setZeroZ: number | null
  /** The P word of a G4 dwell, or null when the line is not one. */
  dwell: number | null
  /** The F word in effect after this line. */
  feed: number | null
  /** True when this line carries its own F word. */
  explicitFeed: boolean
  /** 'on' for M3/M4, 'off' for M5, null otherwise. */
  torch: 'on' | 'off' | null
  /** True for an M4, which must never fire the torch. */
  torchReverse: boolean
  /** The Z word in effect after this line. */
  z: number | null
}

export type Rule = 'probe' | 'zero' | 'order' | 'dwell' | 'feed' | 'z' | 'torch' | 'rapid' | 'mode'

export interface Finding {
  rule: Rule
  line: number
  message: string
}

/** A program line with its comments removed and its G/M words gathered. */
function parseLine(text: string): { gs: number[]; ms: number[]; words: Record<string, number> } | null {
  const code = text.replace(/\([^)]*\)/g, '').replace(/;.*$/, '').trim()
  if (!code) return null
  const gs: number[] = []
  const ms: number[] = []
  const words: Record<string, number> = {}
  for (const match of code.matchAll(/([A-Z])(-?\d*\.?\d+)/gi)) {
    const letter = match[1].toUpperCase()
    const value = Number(match[2])
    if (letter === 'G') gs.push(value)
    else if (letter === 'M') ms.push(value)
    else if (!(letter in words)) words[letter] = value
  }
  return { gs, ms, words }
}

/** Resolve modal motion, feed and Z across a program, as the controller reads it. */
export function parseProgram(program: string): ParsedLine[] {
  const parsed: ParsedLine[] = []
  let motion: ParsedLine['motion'] = null
  let feed: number | null = null
  let z: number | null = null
  program.split('\n').forEach((text, index) => {
    const line = index + 1
    const code = parseLine(text)
    if (!code) return
    const { gs, ms, words } = code
    const plainG = gs.filter((value) => Number.isInteger(value) && value >= 0 && value <= 3)
    if (plainG.length > 0) motion = `G${plainG[plainG.length - 1]}` as ParsedLine['motion']
    if (words.F !== undefined) feed = words.F
    if (words.Z !== undefined) z = words.Z
    parsed.push({
      line,
      text: text.trim(),
      motion,
      commandsMotion: plainG.length > 0 || words.X !== undefined || words.Y !== undefined || words.Z !== undefined,
      probe: gs.some((value) => value === 38.2 || value === 38.3),
      setZeroZ: gs.includes(10) && words.Z !== undefined ? words.Z : null,
      dwell: gs.includes(4) ? words.P ?? null : null,
      feed,
      explicitFeed: words.F !== undefined,
      torch: ms.some((value) => value === 3 || value === 4) ? 'on' : ms.includes(5) ? 'off' : null,
      torchReverse: ms.includes(4),
      z,
    })
  })
  return parsed
}

function isFeedMove(line: ParsedLine): boolean {
  return line.commandsMotion && (line.motion === 'G1' || line.motion === 'G2' || line.motion === 'G3')
}

function lastIndex(lines: ParsedLine[], predicate: (line: ParsedLine) => boolean): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (predicate(lines[index])) return index
  }
  return -1
}

/**
 * Every reason this program is not the approved G-code pierce sequence.
 * Empty means it passed.
 */
export function judge(program: string): Finding[] {
  const lines = parseProgram(program)
  const findings: Finding[] = []
  const seen = new Set<string>()
  const add = (rule: Rule, line: number, message: string): void => {
    const key = `${rule}:${line}`
    if (seen.has(key)) return
    seen.add(key)
    findings.push({ rule, line, message })
  }

  let torchOn = false
  let cycleStart = -1
  let firedTorch = false
  /** Lines since the last torch-off, before the next torch-on. */
  let prepare: ParsedLine[] = []
  /** Lines between the last torch-on and now. */
  let cycle: ParsedLine[] = []
  let modalFeed: number | null = null

  const judgeCycle = (torchLine: number): void => {
    const dwellAt = cycle.findIndex((line) => line.dwell !== null && line.dwell > 0)
    const firstFeedAt = cycle.findIndex(isFeedMove)
    if (dwellAt < 0) add('dwell', torchLine, 'torch-on with no G4 dwell before the cut')
    else if (firstFeedAt >= 0 && dwellAt > firstFeedAt) add('dwell', cycle[dwellAt].line, 'the dwell comes after the first feed move')
    // The drop to cut height is the first feed move: it must be a Z drop and
    // it must carry the plunge feed itself. A modal feed inherited from the
    // probe's F word would be the probe feed, not the plunge feed.
    if (firstFeedAt >= 0) {
      const drop = cycle[firstFeedAt]
      if (drop.z === null) add('order', drop.line, 'the first feed move after the torch-on is not the drop to cut height')
      if (!drop.explicitFeed) add('feed', drop.line, 'the drop to cut height carries no plunge feed of its own')
    }
  }

  for (const line of lines) {
    if (line.torchReverse) add('mode', line.line, 'M4 must never fire a plasma torch')
    if (line.torch === 'on') {
      firedTorch = true
      // Read the approved order off the prepare window. Both a missing probe
      // and a missing zero are reported once; the order is checked only when
      // both are present, so a mutation trips exactly the rule it breaks.
      const probeAt = lastIndex(prepare, (candidate) => candidate.probe)
      const zeroAt = lastIndex(prepare, (candidate) => candidate.setZeroZ !== null)
      if (probeAt < 0) add('probe', line.line, 'torch-on with no G38 probe since the last torch-off')
      if (zeroAt < 0) add('zero', line.line, 'torch-on with no set-zero since the probe')
      if (probeAt >= 0 && zeroAt >= 0) {
        if (probeAt > zeroAt) add('order', line.line, 'the set-zero must come after the probe')
        const pierceAt = lastIndex(prepare, (candidate) => candidate.commandsMotion && candidate.motion === 'G0' && candidate.z !== null)
        if (pierceAt < 0 || pierceAt < zeroAt || pierceAt !== prepare.length - 1) {
          add('order', line.line, 'a G0 to pierce height must immediately precede the torch-on')
        }
        if (prepare[zeroAt].setZeroZ !== null && prepare[zeroAt].setZeroZ! > 0) {
          add('z', prepare[zeroAt].line, 'the set-zero Z must not be positive: the switch offset is applied negatively')
        }
      }
      torchOn = true
      cycleStart = line.line
      prepare = []
      cycle = []
    } else if (line.torch === 'off') {
      if (torchOn) judgeCycle(cycleStart)
      torchOn = false
      prepare = []
      cycle = []
    } else if (torchOn) {
      cycle.push(line)
      if (line.commandsMotion && line.motion === 'G0') add('rapid', line.line, 'G0 while the torch is on')
      if (line.feed !== null) modalFeed = line.feed
      if (isFeedMove(line) && (line.feed ?? modalFeed ?? 0) <= 0) add('feed', line.line, 'a cut move with no positive feed')
    } else {
      if (line.feed !== null) modalFeed = line.feed
      if (isFeedMove(line)) add('torch', line.line, 'a cutting move with the torch off')
      else prepare.push(line)
    }
  }

  if (!firedTorch) add('torch', lines.length > 0 ? lines[0].line : 1, 'the program never fires the torch')
  return findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule))
}

export type Expectation = 'pass' | { fails: Rule[] }

/**
 * Compare a verdict with what a case expects. Null means it matches.
 *
 * A case that must fail has to fail for exactly its own rules — all of them and
 * no others. A negative fixture rejected for something unrelated would look
 * green while the rule it exists to exercise had stopped working.
 */
export function mismatch(expect: Expectation, findings: Finding[]): string | null {
  const rules = [...new Set(findings.map((finding) => finding.rule))].sort()
  if (expect === 'pass') {
    return rules.length === 0 ? null : `expected to pass, got ${rules.join(', ')}`
  }
  const wanted = [...expect.fails].sort()
  if (rules.length === 0) return `expected to be rejected (${wanted.join(', ')}) but it passed`
  if (rules.join() === wanted.join()) return null
  return `expected to be rejected for exactly "${wanted.join(', ')}", but was rejected for: ${rules.join(', ')}`
}
