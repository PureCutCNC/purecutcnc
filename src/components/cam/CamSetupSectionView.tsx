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
import { useI18n } from '../../i18n/i18nContext'

export function CamSetupSectionView({ section, grouped, selectedOperationId, onExport, onProperties, children }: {
  section: CamSetupSection; grouped: boolean; selectedOperationId: string | null
  onExport: (ids: string[]) => void; onProperties: () => void; children: ReactNode
}) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const open = section.active || expanded || section.operations.some((operation) => operation.id === selectedOperationId)
  if (!grouped) return <>{children}</>
  return <section className={`cam-setup-group cam-setup-group--${section.face}${section.active ? ' cam-setup-group--active' : ''}`} data-setup-face={section.face} data-active={section.active}>
    <div className="cam-setup-group__header">
      <button type="button" className="cam-setup-group__toggle" aria-expanded={open} onClick={() => setExpanded(!expanded)}>
        {t(section.face === 'top' ? 'cam.setup.topOperations' : 'cam.setup.bottomOperations')} <span className="feature-count">{section.operations.length}</span>
        <span className="face-chip">{t('cam.setup.program', { number: String(section.programNumber).padStart(2, '0') })}</span>
      </button>
      <button className="tree-action-btn" type="button" aria-label={t('cam.setup.propertiesFor', { name: section.setup.name })} onClick={onProperties}>⚙</button>
      <button className="tree-action-btn" type="button" aria-label={t('cam.setup.export', { name: section.setup.name })} disabled={!section.operations.some((op) => op.enabled)} onClick={() => onExport(section.operations.filter((op) => op.enabled).map((op) => op.id))}>↓</button>
    </div>
    {open ? <div className="cam-setup-group__body">
      <div className="cam-setup-group__status">{section.flipAxis ? t('cam.setup.flipped', { axis: section.flipAxis.toUpperCase() }) : section.setup.name}
        <span className={section.registrationMissing ? 'cam-field-message' : 'properties-hint'}>{section.registrationMissing ? t('cam.setup.noRegistration') : t('cam.setup.registrationCount', { count: section.registrationCount })}</span>
      </div>
      {section.operations.length === 0 ? <div className="panel-empty">{t('cam.setup.empty')}</div> : children}
    </div> : null}
  </section>
}
