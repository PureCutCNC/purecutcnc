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
 * Semver-ish version comparison with no imports, so both the desktop update
 * check ([`updateCheck.ts`](updateCheck.ts)) and the deploy-side download
 * manifest gate (`tools/download-manifest-gate`, issue #1000) can use the same
 * rule for "newer" — the gate runs on plain Node in CI and must not pull in the
 * app's React hooks.
 */

interface ParsedVersion {
  nums: [number, number, number]
  pre: string[]
}

function parseVersion(input: string): ParsedVersion {
  const cleaned = String(input).trim().replace(/^v/i, '')
  const dash = cleaned.indexOf('-')
  const core = dash < 0 ? cleaned : cleaned.slice(0, dash)
  const preStr = dash < 0 ? '' : cleaned.slice(dash + 1)

  const parts = core.split('.')
  const nums: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    const n = Number.parseInt(parts[i] ?? '0', 10)
    nums[i] = Number.isFinite(n) ? n : 0
  }
  const pre = preStr.length > 0 ? preStr.split('.') : []
  return { nums, pre }
}

/**
 * Compare two semver-ish strings. Returns 1 if `a` is newer than `b`, -1 if
 * older, 0 if equal. Tolerates a leading `v` and malformed input (missing parts
 * are treated as 0). Prerelease precedence follows semver: a version without a
 * prerelease tag outranks the same core version with one
 * (`1.0.0` > `1.0.0-rc.1`), and numeric identifiers compare numerically.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)

  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1
  }

  // Equal core. Absence of a prerelease tag ranks higher than presence.
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0
  if (pa.pre.length === 0) return 1
  if (pb.pre.length === 0) return -1

  const len = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1 // shorter prerelease list ranks lower
    if (y === undefined) return 1
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d < 0 ? -1 : 1
    } else if (xNum) {
      return -1 // numeric identifiers rank lower than alphanumeric
    } else if (yNum) {
      return 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}
