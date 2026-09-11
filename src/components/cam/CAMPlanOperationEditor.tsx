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

import type { CamPlanOperationDraft, CamPlanTool } from '../../engine/operations/camPlan'
import { offeredPocketPatterns } from '../../engine/toolpaths/pocketPatterns'
import type { DrillType, EntryStrategy, Operation, OperationKind, PocketPattern, Tool } from '../../types/project'
import { formatLength, parseLengthInput } from '../../utils/units'
import { Select } from '../Select'
import { camT } from './camI18n'
import { OPERATION_FIELDS, resolvedEntryStrategy, type OperationFieldId } from './operationFields'

function operationLabel(kind: OperationKind): string {
  switch (kind) {
    case 'pocket': return camT('cam.opLabel.pocket')
    case 'v_carve': return camT('cam.opLabel.vCarve')
    case 'v_carve_medial': return camT('cam.opLabel.vCarveMedial')
    case 'edge_route_inside': return camT('cam.opLabel.edgeRouteInside')
    case 'edge_route_outside': return camT('cam.opLabel.edgeRouteOutside')
    case 'surface_clean': return camT('cam.opLabel.surfaceClean')
    case 'rough_surface': return camT('cam.opLabel.roughSurface')
    case 'finish_surface': return camT('cam.opLabel.finishSurface')
    case 'finish_surface_cleanup': return camT('cam.opLabel.finishSurfaceCleanup')
    case 'follow_line': return camT('cam.opLabel.followLine')
    case 'drilling': return camT('cam.opLabel.drilling')
  }
}

function patternLabel(pattern: PocketPattern): string {
  switch (pattern) {
    case 'offset': return camT('cam.pocketPattern.offset')
    case 'parallel': return camT('cam.pocketPattern.parallel')
    case 'constant_scallop': return camT('cam.pocketPattern.constantScallop')
    case 'waterline': return camT('cam.pocketPattern.waterline')
    case 'seeded_offset': return camT('cam.pocketPattern.seededOffset')
    case 'trochoidal': return camT('cam.pocketPattern.trochoidal')
  }
}

function drillLabel(type: DrillType): string {
  switch (type) {
    case 'simple': return camT('cam.drillType.simple')
    case 'peck': return camT('cam.drillType.peck')
    case 'dwell': return camT('cam.drillType.dwell')
    case 'chip_breaking': return camT('cam.drillType.chipBreaking')
    case 'helical': return camT('cam.drillType.helical')
    case 'countersink': return camT('cam.drillType.countersink')
  }
}

function fieldApplies(fieldId: OperationFieldId, operation: Operation, tool: Tool | null): boolean {
  return OPERATION_FIELDS.find((field) => field.id === fieldId)?.appliesTo(operation, tool) ?? false
}

interface PlanLengthInputProps {
  value: number
  units: Tool['units']
  onCommit: (value: number) => void
}

function PlanLengthInput({ value, units, onCommit }: PlanLengthInputProps) {
  function commit(element: HTMLInputElement) {
    const parsed = parseLengthInput(element.value, units)
    if (parsed === null || parsed < 0) {
      element.value = formatLength(value, units)
      return
    }
    if (parsed !== value) onCommit(parsed)
  }
  return (
    <div className="cam-plan-length-input">
      <input
        key={value}
        type="text"
        inputMode="decimal"
        defaultValue={formatLength(value, units)}
        onBlur={(event) => commit(event.currentTarget)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') {
            event.currentTarget.value = formatLength(value, units)
            event.currentTarget.blur()
          }
        }}
      />
      <span>{units === 'inch' ? 'in' : 'mm'}</span>
    </div>
  )
}

export interface CAMPlanOperationEditorProps {
  draft: CamPlanOperationDraft
  tools: CamPlanTool[]
  units: Tool['units']
  onPatch: (patch: Partial<Operation>, invalidatesRest?: boolean) => void
  onUseRecommendedRestTool?: () => void
}

export function CAMPlanOperationEditor({ draft, tools, units, onPatch, onUseRecommendedRestTool }: CAMPlanOperationEditorProps) {
  const operation = draft.operation
  const selectedTool = tools.find((candidate) => candidate.id === operation.toolRef)?.tool ?? null
  const isVCarve = operation.kind === 'v_carve' || operation.kind === 'v_carve_medial'
  const error = draft.hardError ?? draft.staleReason
  const canUseRecommendedRestTool = Boolean(
    draft.rest
    && draft.hardError
    && draft.toolOptions.some((toolRef) => toolRef !== operation.toolRef),
  )
  // The plan can introduce a bundled tool when applied, so a user never has
  // to preload a tool merely to choose it here. Match the ordinary operation
  // editor by reserving the V-carve list for V-bits.
  const toolOptions = tools.filter((candidate) =>
    candidate.id === operation.toolRef || !isVCarve || candidate.tool.type === 'v_bit',
  )

  return (
    <div className="cam-plan-editor">
      <div className="cam-plan-editor__heading">
        <div>
          <span className="cam-plan-eyebrow">{operationLabel(operation.kind)} · {camT(`cam.pass.${operation.pass}`)}</span>
          <h3>{operation.name}</h3>
        </div>
        <span className="cam-plan-status-chip">{draft.targetLabel}</span>
      </div>

      <div className="cam-plan-explanation">
        <strong>{camT('cam.plan.whyOperation')}</strong>
        <p>{draft.rationale}</p>
      </div>

      <section className="cam-plan-editor__section">
        <h4>{camT('cam.operation.group.tool')}</h4>
        <label className="cam-plan-field">
          <span>{camT('cam.operation.tool')}</span>
          <Select
            value={operation.toolRef ?? ''}
            options={[
              { value: '', label: camT('cam.operation.noTool') },
              ...toolOptions.map((candidate) => ({
                value: candidate.id,
                label: `${candidate.tool.name} · ${formatLength(candidate.tool.diameter, units)} ${units === 'inch' ? 'in' : 'mm'}`,
              })),
            ]}
            onChange={(toolRef) => onPatch({ toolRef: toolRef || null }, true)}
          />
        </label>
        <p className="cam-plan-field-note">{draft.toolReason}</p>
      </section>

      <section className="cam-plan-editor__section">
        <h4>{camT('cam.plan.mainParameters')}</h4>
        {fieldApplies('stockToLeaveRadial', operation, selectedTool) ? (
          <label className="cam-plan-field">
            <span>{camT('cam.operation.stockToLeaveRadial')}</span>
            <PlanLengthInput value={operation.stockToLeaveRadial} units={units} onCommit={(value) => onPatch({ stockToLeaveRadial: value }, true)} />
          </label>
        ) : null}
        {fieldApplies('stockToLeaveAxial', operation, selectedTool) ? (
          <label className="cam-plan-field">
            <span>{camT('cam.operation.stockToLeaveAxial')}</span>
            <PlanLengthInput value={operation.stockToLeaveAxial} units={units} onCommit={(value) => onPatch({ stockToLeaveAxial: value }, true)} />
          </label>
        ) : null}
        {fieldApplies('pattern', operation, selectedTool) ? (
          <label className="cam-plan-field">
            <span>{camT('cam.operation.pattern')}</span>
            <Select
              value={operation.pocketPattern}
              options={offeredPocketPatterns(operation.kind).map((pattern) => ({ value: pattern, label: patternLabel(pattern) }))}
              onChange={(pattern) => onPatch({ pocketPattern: pattern as PocketPattern }, true)}
            />
          </label>
        ) : null}
        {fieldApplies('edgeStrategy', operation, selectedTool) ? (
          <label className="cam-plan-field">
            <span>{camT('cam.operation.edgeStrategy')}</span>
            <Select
              value={operation.edgeStrategy ?? 'contour'}
              options={[
                { value: 'contour', label: camT('cam.operation.edgeStrategyContour') },
                { value: 'trochoidal', label: camT('cam.operation.edgeStrategyTrochoidal') },
              ]}
              onChange={(edgeStrategy) => onPatch({ edgeStrategy: edgeStrategy as Operation['edgeStrategy'] }, true)}
            />
          </label>
        ) : null}
        {fieldApplies('entryStrategy', operation, selectedTool) ? (
          <label className="cam-plan-field">
            <span>{camT('cam.operation.entryStrategy')}</span>
            <Select
              value={resolvedEntryStrategy(operation)}
              options={([
                ['plunge', camT('cam.operation.entryPlunge')],
                ['helix', camT('cam.operation.entryHelix')],
                ['ramp', camT('cam.operation.entryRamp')],
              ] satisfies Array<[EntryStrategy, string]>).map(([value, label]) => ({ value, label }))}
              onChange={(entryStrategy) => onPatch({ entryStrategy: entryStrategy as EntryStrategy }, true)}
            />
          </label>
        ) : null}
        {fieldApplies('xyLeadStrategy', operation, selectedTool) ? (
          <label className="cam-plan-field">
            <span>{camT('cam.operation.xyLeadStrategy')}</span>
            <Select
              value={operation.xyLeadStrategy ?? 'none'}
              options={[
                { value: 'none', label: camT('cam.operation.xyLeadNone') },
                { value: 'arc', label: camT('cam.operation.xyLeadArc') },
              ]}
              onChange={(xyLeadStrategy) => onPatch({ xyLeadStrategy: xyLeadStrategy as Operation['xyLeadStrategy'] })}
            />
          </label>
        ) : null}
        {fieldApplies('drillType', operation, selectedTool) ? (
          <label className="cam-plan-field">
            <span>{camT('cam.operation.drillType')}</span>
            <Select
              value={operation.drillType ?? 'simple'}
              options={(['simple', 'peck', 'dwell', 'chip_breaking', 'helical'] as DrillType[]).map((value) => ({ value, label: drillLabel(value) }))}
              onChange={(drillType) => onPatch({ drillType: drillType as DrillType }, true)}
            />
          </label>
        ) : null}
        {fieldApplies('finishWalls', operation, selectedTool) ? (
          <label className="cam-plan-check"><input type="checkbox" checked={operation.finishWalls} onChange={(event) => onPatch({ finishWalls: event.currentTarget.checked })} /> {camT('cam.operation.finishWalls')}</label>
        ) : null}
        {fieldApplies('finishFloor', operation, selectedTool) ? (
          <label className="cam-plan-check"><input type="checkbox" checked={operation.finishFloor} onChange={(event) => onPatch({ finishFloor: event.currentTarget.checked })} /> {camT('cam.operation.finishFloor')}</label>
        ) : null}
      </section>

      {error ? (
        <div className="cam-plan-alert" role="alert">
          <span>{error}</span>
          {canUseRecommendedRestTool && onUseRecommendedRestTool ? (
            <button type="button" onClick={onUseRecommendedRestTool}>{camT('cam.plan.useRecommendedRestTool')}</button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
