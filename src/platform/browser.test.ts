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
 * Tests for browser project-file persistence.
 *
 * Run with: npx tsx src/platform/browser.test.ts
 */

import { browserPlatform } from './browser'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

let touchDevice = false
const downloadedNames: string[] = []

const testGlobal = globalThis as typeof globalThis & {
  document: Document
  window: Window & typeof globalThis
}

testGlobal.window = {
  matchMedia: () => ({ matches: touchDevice }),
} as unknown as Window & typeof globalThis
testGlobal.document = {
  createElement: () => ({
    href: '',
    download: '',
    click(this: HTMLAnchorElement): void {
      downloadedNames.push(this.download)
    },
  }),
} as unknown as Document

async function saveProject(touch: boolean, suggestedName: string): Promise<string | null> {
  touchDevice = touch
  downloadedNames.length = 0
  const savedName = await browserPlatform.saveProjectFile(suggestedName, '{}')
  assert(downloadedNames.length === 1, 'fallback download runs once')
  assert(downloadedNames[0] === savedName, 'returned filename matches downloaded filename')
  return savedName
}

async function testProjectSaveExtensionFollowsInputMode(): Promise<void> {
  assert(await saveProject(false, 'desktop-project') === 'desktop-project.camj',
    'desktop fallback without File System Access API saves .camj')
  assert(await saveProject(false, 'already.camj.json') === 'already.camj',
    'desktop normalizes a previous mobile filename to .camj')
  assert(await saveProject(true, 'tablet-project') === 'tablet-project.camj.json',
    'touch browser saves .camj.json for iOS picker compatibility')
  console.log('testProjectSaveExtensionFollowsInputMode PASS')
}

await testProjectSaveExtensionFollowsInputMode()
