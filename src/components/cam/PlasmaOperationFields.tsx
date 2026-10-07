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

import { useProjectStore } from '../../store/projectStore'
import { usePlasmaStartPointPick } from './plasmaStartPointPick'
import type { Operation, Project } from '../../types/project'
import { plasmaLeadLength } from '../../engine/toolpaths/plasma'
import { camT } from './camI18n'
import { Select } from '../Select'
import { plasmaStartContours } from '../canvas/plasmaStartPoint'

export function PlasmaOperationFields({ operation, project, onChange }: {
  operation: Operation; project: Project; onChange: (patch: Partial<Operation>) => void
}) {
  const request = usePlasmaStartPointPick((state) => state.request)
  const picking = request?.operationId === operation.id
  const number = (value: number | undefined, change: (n: number | undefined) => void, fallback?: number) => (
    <input key={String(value)} type="text" inputMode="decimal" defaultValue={value ?? ''} placeholder={fallback === undefined ? camT('cam.plasma.auto') : String(fallback)}
      onBlur={(event) => {
        const text = event.currentTarget.value.trim()
        const parsed = Number(text)
        if (text === '') change(undefined)
        else if (Number.isFinite(parsed) && parsed >= 0) change(parsed)
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
    <div className="properties-field"><span>{camT('cam.plasma.start')}</span>
      <button type="button" style={{ minHeight: 44 }} aria-pressed={picking} onClick={() => picking
        ? usePlasmaStartPointPick.getState().cancel()
        : usePlasmaStartPointPick.getState().begin(operation.id, useProjectStore.getState().projectKey)}>{camT(picking ? 'cam.plasma.cancelPick' : 'cam.plasma.pickStart')}</button>
    </div>
    {plasmaStartContours(project, operation).filter((target) => operation.plasmaStartPoints?.[target.id]).map((target) => (
      <div key={target.id} role="group" aria-label={target.name} className="properties-field">
        <span>{target.name}</span><button type="button" style={{ minHeight: 44 }} onClick={() => {
          const points = { ...operation.plasmaStartPoints }; delete points[target.id]
          onChange({ plasmaStartPoints: Object.keys(points).length ? points : undefined })
        }}>{camT('cam.plasma.autoStart')}</button>
      </div>
    ))}
    <button type="button" style={{ minHeight: 44 }} disabled={!operation.plasmaStartPoint && !Object.keys(operation.plasmaStartPoints ?? {}).length} onClick={() => { usePlasmaStartPointPick.getState().cancel(); onChange({ plasmaStartPoint: undefined, plasmaStartPoints: undefined }) }}>{camT('cam.plasma.resetStarts')}</button>
    <p className="cam-field-note">{camT('cam.plasma.startHelp')}</p>
  </div>
}
