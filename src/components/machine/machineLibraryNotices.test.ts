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
 * What the machine manager shows about the stored library itself (#1119).
 * Run with:
 *   npx tsx src/components/machine/machineLibraryNotices.test.ts
 */

import type { MachineLoadDiagnostic } from '../../machine/diagnostics'
import { machineLibraryNotices } from './machineLibraryNotices'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const unreadable: MachineLoadDiagnostic = {
  severity: 'error',
  kind: 'machine-library-unreadable',
  message: 'The stored machine library could not be read.',
}

// --- a clean library says nothing ---------------------------------------

{
  assert(machineLibraryNotices({ writeBlocked: false, diagnostics: [] }).length === 0, 'a clean library is silent')
}

// --- a write-blocked library names the state ----------------------------

{
  const notices = machineLibraryNotices({ writeBlocked: true, diagnostics: [unreadable] })
  assert(notices.length === 2, 'the state and the reason are both shown')
  assert(
    notices[0].severity === 'error'
      && 'messageKey' in notices[0]
      && notices[0].messageKey === 'dialogs.machineManager.libraryWriteBlocked',
    'the write-blocked state is a translated banner',
  )
  assert(
    notices[1].severity === 'error'
      && notices[1].messageKey === 'dialogs.machineDiagnostics.load.libraryUnreadable'
      && notices[1].params === undefined,
    'the diagnostic supplies a catalog key for the reason, not an English sentence',
  )
  assert(
    !('message' in notices[1]),
    'the manager never receives the machine layer\'s English sentence',
  )
}

// --- a repeated failure is reported once --------------------------------

{
  const repeat = { ...unreadable, kind: 'machine-library-write-failed' as const }
  const notices = machineLibraryNotices({ writeBlocked: false, diagnostics: [repeat, repeat, repeat] })
  assert(notices.length === 1, 'the same failed write is shown once')
  assert(
    notices[0].messageKey === 'dialogs.machineDiagnostics.load.libraryWriteFailed',
    'a failed write has its own translated reason',
  )
}

// --- info diagnostics stay out of the banner ----------------------------

{
  const moved: MachineLoadDiagnostic = {
    severity: 'info',
    kind: 'machine-moved-to-library',
    message: 'Machine "Shop Router" was moved to My Machines.',
  }
  assert(
    machineLibraryNotices({ writeBlocked: false, diagnostics: [moved] }).length === 0,
    'a completed move is load-warning material, not a library problem',
  )
}

console.log('machine library notices tests passed')
