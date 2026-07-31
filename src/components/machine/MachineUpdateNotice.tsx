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

import { useState } from 'react'
import { getActiveMachineDefinition } from '../../engine/gcode/definitions'
import { machineSnapshotStatus } from '../../machine/registry'
import { useMachineLibrary } from '../../machine/useMachineLibrary'
import { useProjectStore } from '../../store/projectStore'
import { useI18n } from '../../i18n/i18nContext'
import { MachineDefinitionManagerDialog } from './MachineDefinitionManagerDialog'

/**
 * Non-blocking notice shown when the opened project's embedded machine
 * snapshot differs from the library definition with the same ID.
 *
 * Nothing here changes the project on its own: dismissing leaves the embedded
 * snapshot (and therefore the exported G-code) untouched, and "Update project
 * copy" is an explicit, dirtying, undoable action. Mount with
 * `key={projectKey}` so each opened project gets the notice once.
 */
export function MachineUpdateNotice() {
  const project = useProjectStore((s) => s.project)
  const setProjectMachine = useProjectStore((s) => s.setProjectMachine)
  const { library } = useMachineLibrary()
  const { t } = useI18n()

  const [dismissed, setDismissed] = useState(false)
  const [showManager, setShowManager] = useState(false)

  const embedded = getActiveMachineDefinition(project)
  const status = machineSnapshotStatus(embedded, library)

  if (showManager) {
    return (
      <MachineDefinitionManagerDialog
        focusMachineId={embedded?.id ?? null}
        onClose={() => { setShowManager(false); setDismissed(true) }}
      />
    )
  }

  if (dismissed || status.kind !== 'update-available') {
    return null
  }

  return (
    <div className="machine-update-notice" role="status">
      <strong className="machine-update-notice-title">{t('dialogs.machineUpdate.title')}</strong>
      <p className="machine-update-notice-body">
        {t('dialogs.machineUpdate.body', { name: status.library.name })}
      </p>
      <div className="machine-update-notice-actions">
        <button className="btn-primary" type="button" onClick={() => setShowManager(true)}>
          {t('dialogs.machineUpdate.review')}
        </button>
        <button className="btn-secondary" type="button" onClick={() => setDismissed(true)}>
          {t('dialogs.machineUpdate.keep')}
        </button>
        <button
          className="btn-secondary"
          type="button"
          onClick={() => { setProjectMachine(status.library); setDismissed(true) }}
        >
          {t('dialogs.machineUpdate.update')}
        </button>
      </div>
    </div>
  )
}
