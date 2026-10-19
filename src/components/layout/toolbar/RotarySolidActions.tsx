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
 * The one-shot Around solids beside the drawing tools (issue #1016 C2-U2).
 *
 * Two conveniences, each tied to the bar the active Around job actually turns:
 *
 * - **Polygon / hex** on a round bar — a polygon prism cut from the bar, the
 *   hex-bolt-head case being six sides at the default.
 * - **Square to round** on a square blank — the finished round target inside
 *   the real square stock.
 *
 * Those are the two shapes a solid can be cut *from*, so exactly one of the two
 * entries is offered at a time and the other stock shape is not a disabled
 * control the user has to reason about. Both call `addRotarySolid`, which lands
 * an ordinary model with its rotary rough and finish operations; neither
 * persists a parameter block.
 *
 * The entry is mounted only while the workspace is on an available, active
 * Around face — workflow availability, not merely a remembered face: a file
 * loaded from a non-rotary project can retain a bar and an Around setup, and
 * `addRotarySolid` would refuse every command there. Leaving Around (or losing
 * availability) unmounts this subtree, so the dialog closes and a half-filled
 * form cannot be resurrected by coming back — the same rule C1's Thread and
 * Flutes entries follow.
 *
 * A form is opened against one physical bar, so the whole subtree is keyed on
 * the context signature (`solidContextSignature`): a units conversion, a
 * stock shape/axis/size/origin change, a setup change or a project replacement
 * unmounts it during the same render. The numbers typed for the old bar can
 * never be paired with the new bounds.
 */

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useProjectStore } from '../../../store/projectStore'
import { activeFace, aroundUnavailableReason, activeSetup } from '../../../store/helpers/activeFace'
import { getStockBounds, type Project } from '../../../types/project'
import { isBarStock, isSquareStock } from '../../../types/barStock'
import { useI18n } from '../../../i18n/i18nContext'
import type { MessageKey } from '../../../i18n/locales/en'
import { Icon } from '../../Icon'
import { ToolbarActionButton } from './primitives'
import { RotarySolidDialog, type RotarySolidKind } from './RotarySolidDialog'

interface RotarySolidCommand {
  kind: RotarySolidKind
  command: string
  icon: string
  labelKey: MessageKey
  /** The bar shape this entry needs: the one the command cuts its solid from. */
  shape: 'round' | 'square'
}

const ROTARY_SOLID_COMMANDS: readonly RotarySolidCommand[] = [
  { kind: 'polygon', command: 'rotary-polygon', icon: 'ngon', labelKey: 'dialogs.rotarySolid.polygon.button', shape: 'round' },
  { kind: 'square-to-round', command: 'rotary-square-to-round', icon: 'roundrect', labelKey: 'dialogs.rotarySolid.squareToRound.button', shape: 'square' },
]

/**
 * Everything one request is measured against, as one string: the document
 * session (`projectKey` — incremented by new/load/open), the units, the
 * workflow type, the bar's shape/axis/size/box, the machine origin and the
 * active setup. A form's React `key` and its Create-time re-check both use it,
 * so a request can only ever be built from the context it was opened against.
 */
function solidContextSignature(project: Project, projectKey: number): string {
  const stock = project.stock
  const bounds = getStockBounds(stock)
  const setup = activeSetup(project)
  return [
    `document:${projectKey}`,
    `units:${project.meta.units}`,
    `type:${project.meta.projectType}`,
    `shape:${stock.shape ?? 'block'}`,
    `axis:${isBarStock(stock) ? stock.axis : '-'}`,
    `thickness:${stock.thickness}`,
    `box:${bounds.minX},${bounds.maxX},${bounds.minY},${bounds.maxY}`,
    `origin:${project.origin.x},${project.origin.y},${project.origin.z}`,
    `setup:${setup.id}:${setup.kind ?? 'flat'}:${setup.orientation.axis}:${setup.orientation.angleDeg}`,
  ].join('|')
}

interface RotarySolidActionsProps {
  variant?: 'toolbar' | 'rail'
  tooltipSide?: 'bottom' | 'right'
}

interface RotarySolidAroundActionsProps {
  isSquare: boolean
  contextIsCurrent: () => boolean
  variant: 'toolbar' | 'rail'
  tooltipSide: 'bottom' | 'right'
}

function RotarySolidAroundActions({
  isSquare,
  contextIsCurrent,
  variant,
  tooltipSide,
}: RotarySolidAroundActionsProps) {
  const { t } = useI18n()
  const [openKind, setOpenKind] = useState<RotarySolidKind | null>(null)

  // One entry, not two: the bar shape decides which solid can be cut from it.
  const entry = ROTARY_SOLID_COMMANDS.find((candidate) => (candidate.shape === 'square') === isSquare)
  if (!entry) return null
  const label = t(entry.labelKey)
  // Only the entry the bar currently offers may be open. The key on this whole
  // component already drops the form when the physical context changes; this
  // keeps the same guarantee if open state ever outlives a turn.
  const open = openKind === entry.kind

  const button = variant === 'rail' ? (
    <div className="tool-rail__action" key={entry.kind}>
      <button
        className={`tool-rail__btn ${open ? 'tool-rail__btn--active' : ''}`}
        type="button"
        data-command={entry.command}
        aria-label={label}
        aria-haspopup="dialog"
        onClick={() => setOpenKind(entry.kind)}
      >
        <Icon id={entry.icon} />
      </button>
      <span className="tool-rail__tooltip" role="tooltip">{label}</span>
    </div>
  ) : (
    <ToolbarActionButton
      icon={entry.icon}
      label={label}
      command={entry.command}
      active={open}
      tooltipSide={tooltipSide}
      onClick={() => setOpenKind(entry.kind)}
    />
  )

  const dialog = open && typeof document !== 'undefined'
    ? createPortal(
        <RotarySolidDialog
          kind={entry.kind}
          contextIsCurrent={contextIsCurrent}
          onClose={() => setOpenKind(null)}
        />,
        document.body,
      )
    : null

  if (variant === 'rail') {
    return <>{button}{dialog}</>
  }

  return (
    <div className="toolbar-group toolbar-group--rotary">
      {button}
      {dialog}
    </div>
  )
}

function RotarySolidActions({ variant = 'toolbar', tooltipSide = 'bottom' }: RotarySolidActionsProps) {
  const project = useProjectStore((state) => state.project)
  const projectKey = useProjectStore((state) => state.projectKey)
  // Rendering the dialog subtree only on an available Around face lets ordinary
  // unmounting clear a half-filled form, so returning never reopens it. The
  // `key` extends that to every physical input the form is measured against, so
  // a units conversion, a bar edit or a project load drops it for good instead
  // of reappearing with numbers that belong to the old context.
  if (activeFace(project) !== 'around' || aroundUnavailableReason(project) !== null) return null
  const contextKey = solidContextSignature(project, projectKey)
  const contextIsCurrent = () => {
    const live = useProjectStore.getState()
    return solidContextSignature(live.project, live.projectKey) === contextKey
  }
  return (
    <RotarySolidAroundActions
      key={contextKey}
      isSquare={isSquareStock(project.stock)}
      contextIsCurrent={contextIsCurrent}
      variant={variant}
      tooltipSide={tooltipSide}
    />
  )
}

export { RotarySolidActions }
