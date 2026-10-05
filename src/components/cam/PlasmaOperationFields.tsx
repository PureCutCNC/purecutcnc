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

import type { Operation, Project } from '../../types/project'
import { plasmaLeadLength } from '../../engine/toolpaths/plasma'
import { camT } from './camI18n'
import { Select } from '../Select'

export function PlasmaOperationFields({ operation, project, onChange }: {
  operation: Operation; project: Project; onChange: (patch: Partial<Operation>) => void
}) {
  const number = (value: number | undefined, change: (n: number | undefined) => void, fallback?: number, allowNegative = false) => (
    <input key={String(value)} type="text" inputMode="decimal" defaultValue={value ?? ''} placeholder={fallback === undefined ? camT('cam.plasma.auto') : String(fallback)}
      onBlur={(event) => {
        const text = event.currentTarget.value.trim()
        const parsed = Number(text)
        if (text === '') change(undefined)
        else if (Number.isFinite(parsed) && (allowNegative || parsed >= 0)) change(parsed)
        else event.currentTarget.value = value === undefined ? '' : String(value)
      }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} />
  )
  const options = [{ value: 'line' as const, label: camT('cam.plasma.line') }, { value: 'arc' as const, label: camT('cam.plasma.arc') }]
  return <div className="properties-group">
    <p className="cam-field-note">{camT('cam.plasma.help')}</p>
    <label className="properties-field"><span>{camT('cam.plasma.side')}</span><Select value={operation.plasmaSide ?? 'auto'} options={[
      { value: 'auto', label: camT('cam.plasma.auto') }, { value: 'outside', label: camT('cam.plasma.outside') }, { value: 'inside', label: camT('cam.plasma.inside') },
    ]} onChange={(value) => onChange({ plasmaSide: value })} /></label>
    <label className="properties-check"><input type="checkbox" checked={operation.plasmaReverseDirection ?? false} onChange={(event) => onChange({ plasmaReverseDirection: event.target.checked })} /><span>{camT('cam.plasma.reverse')}</span></label>
    <label className="properties-field"><span>{camT('cam.plasma.leadIn')}</span><Select value={operation.plasmaLeadIn ?? 'arc'} options={options} onChange={(value) => onChange({ plasmaLeadIn: value })} /></label>
    <label className="properties-field"><span>{camT('cam.plasma.leadInLength')} ({project.meta.units})</span>{number(operation.plasmaLeadInLength, (value) => onChange({ plasmaLeadInLength: value }), plasmaLeadLength(project, operation))}</label>
    <label className="properties-field"><span>{camT('cam.plasma.leadOut')}</span><Select value={operation.plasmaLeadOut ?? 'line'} options={options} onChange={(value) => onChange({ plasmaLeadOut: value })} /></label>
    <label className="properties-field"><span>{camT('cam.plasma.leadOutLength')} ({project.meta.units})</span>{number(operation.plasmaLeadOutLength, (value) => onChange({ plasmaLeadOutLength: value }))}</label>
    <label className="properties-check"><input type="checkbox" checked={operation.plasmaStartPoint !== undefined} onChange={(event) => onChange({ plasmaStartPoint: event.target.checked ? { x: 0, y: 0 } : undefined })} /><span>{camT('cam.plasma.start')}</span></label>
    {operation.plasmaStartPoint ? <>
      <label className="properties-field"><span>{camT('cam.plasma.startX')} ({project.meta.units})</span>{number(operation.plasmaStartPoint.x, (value) => onChange({ plasmaStartPoint: { x: value ?? 0, y: operation.plasmaStartPoint?.y ?? 0 } }), undefined, true)}</label>
      <label className="properties-field"><span>{camT('cam.plasma.startY')} ({project.meta.units})</span>{number(operation.plasmaStartPoint.y, (value) => onChange({ plasmaStartPoint: { x: operation.plasmaStartPoint?.x ?? 0, y: value ?? 0 } }), undefined, true)}</label>
    </> : null}
    <p className="cam-field-note">{camT('cam.plasma.startHelp')}</p>
  </div>
}
