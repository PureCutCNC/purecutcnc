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
 * The confirmation every project-type change goes through (issue #1028).
 *
 * It lists what changes — the operations the new type does not cut, the Around
 * features that become hidden, the stock conversion, the machine change — and
 * says, once, that nothing is deleted. A change that shows no line is applied
 * without a dialog by the caller, so this is only ever opened when there is
 * something to say.
 */

import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../../i18n/i18nContext'
import { dialogsEn } from '../../i18n/locales/en/dialogs'
import type { MessageParams } from '../../i18n/catalog'
import { useRestoreCanvasFocus } from '../../utils/useRestoreCanvasFocus'
import {
  projectTypeChangeLines,
  projectTypeLabelKey,
  type ProjectTypeChangeLine,
} from './projectTypeChoice'
import type { ProjectTypeChangeSummary } from '../../store/helpers/projectType'

interface ProjectTypeChangeDialogProps {
  summary: ProjectTypeChangeSummary
  onConfirm: () => void
  onCancel: () => void
}

export function ProjectTypeChangeDialog({ summary, onConfirm, onCancel }: ProjectTypeChangeDialogProps) {
  useRestoreCanvasFocus()
  const { t } = useI18n()

  function td(key: keyof typeof dialogsEn, params?: MessageParams): string {
    return t(key, params)
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  const lines = projectTypeChangeLines(summary)

  function lineText(line: ProjectTypeChangeLine): string {
    switch (line.kind) {
      case 'inactiveOperations':
        return td(
          line.count === 1 ? 'dialogs.projectType.inactiveOperations.one' : 'dialogs.projectType.inactiveOperations.other',
          { count: line.count },
        )
      case 'hiddenAroundFeatures':
        return td(
          line.count === 1 ? 'dialogs.projectType.hiddenAroundFeatures.one' : 'dialogs.projectType.hiddenAroundFeatures.other',
          { count: line.count },
        )
      case 'stockConversion':
        return td(line.conversion === 'toRound' ? 'dialogs.projectType.toRound' : 'dialogs.projectType.toBlock')
      case 'machineChange':
        return td('dialogs.projectType.machineChange', { name: line.name })
    }
  }

  return createPortal(
    <div className="dialog-backdrop" onClick={onCancel}>
      <div
        className="dialog dialog--project-type"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-type-title"
        aria-describedby="project-type-intro"
      >
        <div className="dialog-header">
          <h2 className="dialog-title" id="project-type-title">{td('dialogs.projectType.title')}</h2>
          <button className="dialog-close" onClick={onCancel} aria-label={td('dialogs.common.close')} type="button">
            ✕
          </button>
        </div>

        <div className="dialog-body project-type-change">
          <p id="project-type-intro" className="project-type-change__intro">
            {td('dialogs.projectType.intro', { to: t(projectTypeLabelKey(summary.to)) })}
          </p>
          <ul className="project-type-change__list" data-testid="project-type-change-lines">
            {lines.map((line) => (
              <li key={line.kind}>{lineText(line)}</li>
            ))}
          </ul>
        </div>

        <div className="dialog-footer">
          <button className="btn-secondary" type="button" onClick={onCancel}>
            {td('dialogs.common.cancel')}
          </button>
          <button className="btn-primary" type="button" onClick={onConfirm} data-testid="project-type-confirm" autoFocus>
            {td('dialogs.projectType.confirm')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
