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
 * Download-manifest gate tests (issue #1000).
 *
 * The gate decides whether a desktop deploy replaces the public download
 * manifest, so the cases that matter most are the ones where it must NOT say
 * "publish": an older version, and every situation it cannot judge.
 *
 * Run with: npx tsx tools/download-manifest-gate/gate.test.ts
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GateError, channelForVersion, decideManifestPublish } from './gate.ts'

const TESTER = '0.0.0-release-0.6.0-preview.1'
const scratch = mkdtempSync(join(tmpdir(), 'download-manifest-gate-test-'))

/** A pages checkout holding the given manifests, e.g. `{ 'snapshot/windows': '{"version":"1.0.0"}' }`. */
function pagesRepo(manifests: Record<string, string>): string {
  const dir = mkdtempSync(join(scratch, 'pages-'))
  mkdirSync(join(dir, 'downloads'), { recursive: true })
  for (const [name, text] of Object.entries(manifests)) {
    const [channel, platform] = name.split('/')
    mkdirSync(join(dir, 'downloads', channel), { recursive: true })
    writeFileSync(join(dir, 'downloads', channel, `${platform}.json`), text)
  }
  return dir
}

function manifest(version: string): string {
  return JSON.stringify({ platform: 'windows', version, tag: `v${version}` }, null, 2) + '\n'
}

try {
  // ── The channel rule the workflows share ────────────────────────────
  assert.equal(channelForVersion('0.6.0'), 'stable')
  assert.equal(channelForVersion('0.6.0-rc.1'), 'snapshot')
  assert.equal(channelForVersion(TESTER), 'snapshot')

  // ── Older than published: the manifest stays ───────────────────────
  const published = pagesRepo({
    'snapshot/windows': manifest('0.5.1-rc.1'),
    'snapshot/linux': manifest('0.5.1-rc.2'),
    'stable/windows': manifest('0.5.1'),
  })
  const decide = (platform: string, version: string, pagesDir = published) => decideManifestPublish({ pagesDir, platform, version })

  for (const version of [TESTER, '0.0.0-release-0.6.0-preview.2', '0.0.0-release-0.6.0-preview.10', '0.5.0-rc.9']) {
    const decision = decide('windows', version)
    assert.equal(decision.publish, false, `${version} is below the published snapshot and must not replace it`)
    assert.equal(decision.published, '0.5.1-rc.1')
    assert.equal(decision.channel, 'snapshot')
  }
  assert.equal(decide('windows', '0.5.0').publish, false, 'an older stable release dispatched by mistake keeps the stable manifest')
  assert.equal(decide('linux', '0.5.1-rc.1').publish, false, 'each platform is judged against its own manifest')

  // ── Same or newer: written as before ───────────────────────────────
  assert.equal(decide('windows', '0.5.1-rc.1').publish, true, 'the same version may be re-published')
  assert.equal(decide('windows', '0.5.1-rc.2').publish, true)
  assert.equal(decide('windows', '0.6.0-rc.1').publish, true)
  assert.equal(decide('windows', '0.6.0').publish, true, 'a newer stable release replaces the stable manifest')
  assert.equal(decide('windows', 'v0.6.0').publish, true, 'a leading v is tolerated')
  assert.equal(decide('windows', ' 0.5.1-rc.1 ').publish, true, 'the version is trimmed before it is compared')

  // Channels are independent: a prerelease is compared with the snapshot
  // manifest only, whatever stable holds.
  const rc = decide('windows', '0.5.1-rc.3')
  assert.equal(rc.channel, 'snapshot')
  assert.equal(rc.publish, true, 'a newer prerelease moves snapshot even though stable already has that core')
  assert.equal(rc.file, join(published, 'downloads', 'snapshot', 'windows.json'))

  // ── No manifest yet: the first release for that platform and channel ─
  const first = decide('macos', TESTER)
  assert.deepEqual(
    { publish: first.publish, published: first.published },
    { publish: true, published: null },
    'a platform with no manifest in the channel is written',
  )

  // ── Anything it cannot judge is an error, never "publish" ──────────
  assert.throws(() => decide('windows', TESTER, join(scratch, 'not-checked-out')), GateError, 'no pages checkout')
  assert.throws(() => decide('windows', TESTER, mkdtempSync(join(scratch, 'empty-'))), GateError, 'a checkout without downloads/')
  for (const [label, text] of [
    ['truncated JSON', '{"version": "0.5.1-rc.1"'],
    ['empty file', ''],
    ['no version', '{}'],
    ['null version', '{"version":null}'],
    ['blank version', '{"version":"  "}'],
    ['numeric version', '{"version":1}'],
    ['JSON null', 'null'],
    ['JSON array', '[]'],
  ] as const) {
    const broken = pagesRepo({ 'snapshot/windows': text })
    assert.throws(() => decide('windows', TESTER, broken), GateError, `${label} must fail, not publish`)
  }
  assert.throws(() => decide('win', '1.0.0'), GateError, 'unknown platform')
  assert.throws(() => decide('windows', ''), GateError, 'empty version')
  assert.throws(() => decide('windows', '   '), GateError, 'blank version')

  // ── The CLI the action calls ───────────────────────────────────────
  const here = dirname(fileURLToPath(import.meta.url))
  const tsxCli = createRequire(import.meta.url).resolve('tsx/cli')

  function runCli(args: string[]): { status: number | null; stdout: string; output: string } {
    const outputFile = join(scratch, `github-output-${Math.random().toString(36).slice(2)}`)
    const result = spawnSync(process.execPath, [tsxCli, join(here, 'cli.ts'), ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: outputFile },
    })
    let output = ''
    try { output = readFileSync(outputFile, 'utf8') } catch { /* nothing written */ }
    return { status: result.status, stdout: result.stdout, output }
  }

  const skipped = runCli(['windows', TESTER, published])
  assert.equal(skipped.status, 0)
  assert.equal(skipped.output, 'publish=false\n')
  assert.match(skipped.stdout, /::notice::snapshot\/windows\.json: published 0\.5\.1-rc\.1 is newer than dispatched 0\.0\.0-release-0\.6\.0-preview\.1/)

  const written = runCli(['windows', '0.6.0', published])
  assert.equal(written.status, 0)
  assert.equal(written.output, 'publish=true\n')
  assert.match(written.stdout, /::notice::stable\/windows\.json: published 0\.5\.1, dispatched 0\.6\.0/)

  const noCheckout = runCli(['windows', TESTER, join(scratch, 'not-checked-out')])
  assert.equal(noCheckout.status, 1, 'a missing pages checkout fails the step')
  assert.equal(noCheckout.output, '', 'and sets no publish output')
  assert.match(noCheckout.stdout, /::error::download manifest gate: /)

  const unreadable = runCli(['windows', TESTER, pagesRepo({ 'snapshot/windows': 'not json' })])
  assert.equal(unreadable.status, 1, 'an unreadable manifest fails the step')
  assert.equal(unreadable.output, '')

  assert.equal(runCli([]).status, 1, 'no arguments fails')

  console.log('All download-manifest-gate tests passed.')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
