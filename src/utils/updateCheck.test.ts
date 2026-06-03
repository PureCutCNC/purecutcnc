/**
 * Tests for the user-initiated desktop update check.
 *
 * Run with: npx tsx src/utils/updateCheck.test.ts
 */

import {
  compareVersions,
  classifyManifest,
  detectPlatform,
  checkDesktopUpdate,
  manifestUrl,
  type DownloadManifest,
} from './updateCheck'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg)
}

// ---------------------------------------------------------------------------
// compareVersions
// ---------------------------------------------------------------------------

function testCompareCore() {
  assert(compareVersions('1.0.0', '1.0.0') === 0, 'equal versions')
  assert(compareVersions('1.0.1', '1.0.0') === 1, 'patch newer')
  assert(compareVersions('1.0.0', '1.0.1') === -1, 'patch older')
  assert(compareVersions('1.2.0', '1.1.9') === 1, 'minor newer beats patch')
  assert(compareVersions('2.0.0', '1.9.9') === 1, 'major newer')
  console.log('testCompareCore PASS')
}

function testComparePrefixAndShape() {
  assert(compareVersions('v1.2.3', '1.2.3') === 0, 'leading v tolerated')
  assert(compareVersions('1.2', '1.2.0') === 0, 'missing patch treated as 0')
  assert(compareVersions('', '0.0.0') === 0, 'empty treated as 0.0.0')
  assert(compareVersions('garbage', '0.0.0') === 0, 'malformed treated as 0.0.0')
  console.log('testComparePrefixAndShape PASS')
}

function testComparePrerelease() {
  // Release outranks a prerelease of the same core version.
  assert(compareVersions('1.0.0', '1.0.0-rc.1') === 1, 'release > rc')
  assert(compareVersions('1.0.0-rc.1', '1.0.0') === -1, 'rc < release')
  // Numeric prerelease identifiers compare numerically.
  assert(compareVersions('1.0.0-rc.2', '1.0.0-rc.1') === 1, 'rc.2 > rc.1')
  assert(compareVersions('1.0.0-snapshot.10', '1.0.0-snapshot.9') === 1, 'snapshot.10 > snapshot.9')
  // A stable user must not be told a -snapshot of the same core is newer.
  assert(compareVersions('1.4.0-snapshot', '1.4.0') === -1, 'snapshot < stable same core')
  assert(compareVersions('1.5.0-snapshot', '1.4.0') === 1, 'snapshot of higher core still newer')
  console.log('testComparePrerelease PASS')
}

// ---------------------------------------------------------------------------
// classifyManifest
// ---------------------------------------------------------------------------

function testClassify() {
  const upToDate = classifyManifest('1.2.0', { version: '1.2.0', releaseUrl: 'u' }, 'stable')
  assert(upToDate.kind === 'up-to-date', 'same version is up-to-date')

  const older = classifyManifest('1.3.0', { version: '1.2.0' }, 'stable')
  assert(older.kind === 'up-to-date', 'older manifest is not an update')

  const newer = classifyManifest('1.2.0', { version: '1.3.0', releaseUrl: 'rel' }, 'snapshot')
  assert(newer.kind === 'update-available', 'newer manifest is an update')
  assert(newer.kind === 'update-available' && newer.url === 'rel', 'uses releaseUrl')
  assert(newer.kind === 'update-available' && newer.latest === '1.3.0', 'reports latest')

  const assetFallback = classifyManifest(
    '1.0.0',
    { version: '2.0.0', assets: [{ name: 'a.dmg', url: 'asset-url' }] },
    'snapshot'
  )
  assert(
    assetFallback.kind === 'update-available' && assetFallback.url === 'asset-url',
    'falls back to first asset url when releaseUrl is missing'
  )

  const none = classifyManifest('1.0.0', null, 'stable')
  assert(none.kind === 'no-release' && none.channel === 'stable', 'null manifest = no-release')

  const blank = classifyManifest('1.0.0', {}, 'stable')
  assert(blank.kind === 'no-release', 'versionless manifest = no-release')
  console.log('testClassify PASS')
}

// ---------------------------------------------------------------------------
// detectPlatform
// ---------------------------------------------------------------------------

function testDetectPlatform() {
  assert(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)') === 'macos', 'mac UA')
  assert(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)') === 'windows', 'win UA')
  assert(detectPlatform('Mozilla/5.0 (X11; Linux x86_64)') === 'linux', 'linux UA')
  assert(detectPlatform('something-unknown') === null, 'unknown UA')
  console.log('testDetectPlatform PASS')
}

// ---------------------------------------------------------------------------
// checkDesktopUpdate (with injected fetch)
// ---------------------------------------------------------------------------

function fakeFetch(status: number, body: DownloadManifest | null): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response) as unknown as typeof fetch
}

async function testCheckDesktopUpdate() {
  const available = await checkDesktopUpdate('snapshot', {
    currentVersion: '1.0.0',
    platform: 'macos',
    fetchFn: fakeFetch(200, { version: '1.1.0', releaseUrl: 'rel' }),
  })
  assert(available.kind === 'update-available', 'newer manifest -> update-available')

  const current = await checkDesktopUpdate('snapshot', {
    currentVersion: '1.1.0',
    platform: 'windows',
    fetchFn: fakeFetch(200, { version: '1.1.0' }),
  })
  assert(current.kind === 'up-to-date', 'matching manifest -> up-to-date')

  const missing = await checkDesktopUpdate('stable', {
    currentVersion: '1.0.0',
    platform: 'linux',
    fetchFn: fakeFetch(404, null),
  })
  assert(missing.kind === 'no-release', '404 -> no-release')

  const errored = await checkDesktopUpdate('stable', {
    currentVersion: '1.0.0',
    platform: 'macos',
    fetchFn: fakeFetch(500, null),
  })
  assert(errored.kind === 'error', '500 -> error')

  const threw = await checkDesktopUpdate('stable', {
    currentVersion: '1.0.0',
    platform: 'macos',
    fetchFn: (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch,
  })
  assert(threw.kind === 'error', 'network throw -> error')

  const unsupported = await checkDesktopUpdate('stable', {
    currentVersion: '1.0.0',
    platform: null,
    fetchFn: fakeFetch(200, { version: '9.9.9' }),
  })
  assert(unsupported.kind === 'error', 'no platform -> error')

  assert(
    manifestUrl('snapshot', 'macos') === 'https://purecutcnc.github.io/downloads/snapshot/macos.json',
    'manifestUrl builds expected path'
  )
  console.log('testCheckDesktopUpdate PASS')
}

testCompareCore()
testComparePrefixAndShape()
testComparePrerelease()
testClassify()
testDetectPlatform()
await testCheckDesktopUpdate()

console.log('All updateCheck tests passed.')
