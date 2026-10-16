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
 * Around face. Leaving Around unmounts this subtree, so the dialog closes and a
 * half-filled form cannot be resurrected by coming back — the same rule C1's
 * Thread and Flutes entries follow.
 */

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useProjectStore } from '../../../store/projectStore'
import { activeFace } from '../../../store/helpers/activeFace'
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

interface RotarySolidActionsProps {
  variant?: 'toolbar' | 'rail'
  tooltipSide?: 'bottom' | 'right'
}

function RotarySolidAroundActions({
  variant,
  tooltipSide,
}: {
  variant: 'toolbar' | 'rail'
  tooltipSide: 'bottom' | 'right'
}) {
  const { t } = useI18n()
  const isSquare = useProjectStore((state) => isSquareStock(state.project.stock))
  const [openKind, setOpenKind] = useState<RotarySolidKind | null>(null)

  // One entry, not two: the bar shape decides which solid can be cut from it.
  const entry = ROTARY_SOLID_COMMANDS.find((candidate) => (candidate.shape === 'square') === isSquare)
  if (!entry) return null
  const label = t(entry.labelKey)
  // A form opened for the entry the bar no longer offers (the stock was turned
  // round↔square while it was open) closes here rather than lingering: the open
  // kind must still be the offered one, so a stale form can never post the
  // wrong kind to the store.
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
        <RotarySolidDialog kind={entry.kind} onClose={() => setOpenKind(null)} />,
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
  const face = useProjectStore((state) => activeFace(state.project))
  const isBar = useProjectStore((state) => isBarStock(state.project.stock))
  const isSquare = useProjectStore((state) => isSquareStock(state.project.stock))
  // Rendering the dialog subtree only on an available Around face lets ordinary
  // unmounting clear a half-filled form, so returning never reopens it. The
  // `key` extends that to a bar turn: round↔square remounts the group, so a form
  // opened for the other shape is dropped for good instead of reappearing when
  // the bar is turned back.
  if (face !== 'around' || !isBar) return null
  return (
    <RotarySolidAroundActions
      key={isSquare ? 'square' : 'round'}
      variant={variant}
      tooltipSide={tooltipSide}
    />
  )
}

export { RotarySolidActions }
