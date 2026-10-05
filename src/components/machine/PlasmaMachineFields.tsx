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

import { useI18n } from '../../i18n/i18nContext'
import type { MachineFormData } from './machineDefinitionForm'

interface Props {
  form: MachineFormData
  onChange: (patch: Partial<MachineFormData>) => void
}

/** Machine-kind and plasma metadata form; no command emission happens here. */
export function PlasmaMachineFields({ form, onChange }: Props) {
  const { t } = useI18n()
  function commandField(key: 'torchOnCommand' | 'torchOffCommand' | 'materialSelectCommand' | 'thcOnCommand' | 'thcOffCommand', label: string) {
    return (
      <label className="machine-editor-field">
        <span className="machine-editor-label">{label}</span>
        <input className="machine-editor-input" type="text" value={form[key]}
          onChange={(event) => onChange({ [key]: event.target.value })} />
      </label>
    )
  }
  return (
    <div className="dialog-section-group">
      <label className="machine-editor-field">
        <span className="machine-editor-label">{t('dialogs.machineEditor.machineKind')}</span>
        <select className="machine-editor-input" value={form.machineKind}
          onChange={(event) => onChange({ machineKind: event.target.value === 'plasma' ? 'plasma' : 'router' })}>
          <option value="router">{t('dialogs.machineEditor.kindRouter')}</option>
          <option value="plasma">{t('dialogs.machineEditor.kindPlasma')}</option>
        </select>
      </label>
      {form.machineKind === 'plasma' ? (
        <>
          <span className="dialog-section-title">{t('dialogs.machineEditor.plasma')}</span>
          {commandField('torchOnCommand', t('dialogs.machineEditor.torchOn'))}
          {commandField('torchOffCommand', t('dialogs.machineEditor.torchOff'))}
          {commandField('materialSelectCommand', t('dialogs.machineEditor.materialSelect'))}
          <p className="machine-editor-note">{t('dialogs.machineEditor.materialNumberHint')}</p>
          {commandField('thcOnCommand', t('dialogs.machineEditor.thcOn'))}
          {commandField('thcOffCommand', t('dialogs.machineEditor.thcOff'))}
          <label className="machine-editor-field">
            <span className="machine-editor-label">{t('dialogs.machineEditor.pierceMode')}</span>
            <select className="machine-editor-input" value={form.pierceMode}
              onChange={() => onChange({ pierceMode: 'controller' })}>
              <option value="controller">{t('dialogs.machineEditor.pierceController')}</option>
              <option value="gcode" disabled>{t('dialogs.machineEditor.pierceGcode')}</option>
            </select>
          </label>
          <p className="machine-editor-note">{t('dialogs.machineEditor.plasmaNote')}</p>
        </>
      ) : null}
    </div>
  )
}
