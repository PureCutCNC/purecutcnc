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

import { useState, type ReactNode } from 'react'
import type { CamSetupSection } from './setupSections'
import { setupCardHeader } from './setupSections'
import { projectTypeLabelKey } from '../feature-tree/projectTypeChoice'
import { useI18n } from '../../i18n/i18nContext'
import { Icon } from '../Icon'
import type { ProjectType } from '../../types/project'

export function CamSetupSectionView({ section, grouped, projectType, selectedOperationId, onExport, onProperties, children }: {
  section: CamSetupSection; grouped: boolean; projectType: ProjectType; selectedOperationId: string | null
  onExport: (ids: string[]) => void; onProperties: () => void; children: ReactNode
}) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const open = section.active || expanded || section.operations.some((operation) => operation.id === selectedOperationId)
  const header = setupCardHeader(section, t)
  // An empty setup is one slim row: there is nothing to expand or export, and
  // no status block was left to show. It still opens the properties dialog.
  if (!grouped) return <>{children}</>
  return <section className={`cam-setup-group cam-setup-group--${section.face}${section.active ? ' cam-setup-group--active' : ''}`} data-setup-face={section.face} data-active={section.active}>
    <div className="cam-setup-group__header">
      <button
        type="button"
        className="cam-setup-group__toggle"
        aria-expanded={header.empty ? undefined : open}
        aria-label={header.ariaLabel}
        title={header.ariaLabel}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="cam-setup-group__name">{header.label}</span>
        {header.empty ? <span className="cam-setup-group__empty">{t('cam.setup.empty')}</span> : (
          <>
            <span className="feature-count">{section.operations.length}</span>
            <span className="face-chip">{header.programChip}</span>
          </>
        )}
        {header.warn ? (
          <span
            className="cam-setup-group__warn"
            role="img"
            title={t('cam.setup.noRegistration')}
            aria-label={t('cam.setup.noRegistration')}
          >⚠</span>
        ) : null}
      </button>
      <button className="tree-action-btn" type="button" aria-label={t('cam.setup.propertiesFor', { name: section.setup.name })} onClick={onProperties}><Icon id="gear" /></button>
      {header.empty ? null : (
        <button className="tree-action-btn" type="button" aria-label={t('cam.setup.export', { name: section.setup.name })} disabled={!section.operations.some((op) => op.enabled)} onClick={() => onExport(section.operations.filter((op) => op.enabled).map((op) => op.id))}><Icon id="gcode-export" /></button>
      )}
    </div>
    {open && !header.empty ? <div className="cam-setup-group__body">
      {section.face === 'around' && projectType !== 'rotary' ? (
        // Kept in the project, not cut in a project with no rotary face
        // (issue #1028, rule (a)): said here rather than left as silence.
        <div className="cam-section-note cam-setup-group__note" role="note" data-testid="around-not-cut">
          {t('cam.setup.aroundKeptNotCut', { type: t(projectTypeLabelKey(projectType)) })}
        </div>
      ) : null}
      {children}
    </div> : null}
  </section>
}
