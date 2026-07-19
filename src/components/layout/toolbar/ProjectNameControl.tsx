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

import { useI18n } from '../../../i18n/i18nContext'

function ProjectNameControl({
  projectName,
  dirty,
  editingName,
  nameVal,
  setNameVal,
  setEditingName,
  setProjectName,
}: {
  projectName: string
  dirty: boolean
  editingName: boolean
  nameVal: string
  setNameVal: (value: string) => void
  setEditingName: (value: boolean) => void
  setProjectName: (value: string) => void
}) {
  const { t } = useI18n()
  return (
    <div className="toolbar-project-block">
      <span className="toolbar-project-label">{t('shell.topBar.projectLabel')}</span>
      {editingName ? (
        <input
          className="toolbar-name-input"
          value={nameVal}
          onChange={(event) => setNameVal(event.target.value)}
          onBlur={() => {
            setProjectName(nameVal.trim() || 'Untitled')
            setEditingName(false)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              setProjectName(nameVal.trim() || 'Untitled')
              setEditingName(false)
            }
            if (event.key === 'Escape') {
              setNameVal(projectName)
              setEditingName(false)
            }
          }}
          autoFocus
        />
      ) : (
        <button
          className="toolbar-project-name"
          onClick={() => {
            setNameVal(projectName)
            setEditingName(true)
          }}
          title={t('shell.topBar.renameProject')}
          type="button"
        >
          {projectName}
        </button>
      )}
      <span
        className={`toolbar-save-state ${dirty ? 'toolbar-save-state--dirty' : 'toolbar-save-state--saved'}`}
        aria-live="polite"
        title={dirty ? t('shell.topBar.unsavedTitle') : t('shell.topBar.savedTitle')}
      >
        {dirty ? t('shell.topBar.unsaved') : t('shell.topBar.saved')}
      </span>
    </div>
  )
}

export { ProjectNameControl }
