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
 * The Thread and Flutes entries beside the drawing tools (issue #1016 C1
 * slice B). They exist only while the workspace is on an available, active
 * Around face — a flat, milling or plasma view never offers them — and each
 * opens its dialog. `variant` picks the desktop toolbar or the tablet rail
 * button so both assemblies share one command.
 */

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useProjectStore } from '../../../store/projectStore'
import { activeFace } from '../../../store/helpers/activeFace'
import { useI18n } from '../../../i18n/i18nContext'
import type { MessageKey } from '../../../i18n/locales/en'
import { Icon } from '../../Icon'
import { ToolbarActionButton } from './primitives'
import { RotaryPatternDialog, type RotaryPatternKind } from './RotaryPatternDialog'

interface RotaryCommand {
  kind: RotaryPatternKind
  command: string
  icon: string
  labelKey: MessageKey
}

const ROTARY_COMMANDS: readonly RotaryCommand[] = [
  { kind: 'thread', command: 'rotary-thread', icon: 'surface', labelKey: 'dialogs.rotary.thread.button' },
  { kind: 'flutes', command: 'rotary-flutes', icon: 'tool-endmill', labelKey: 'dialogs.rotary.flutes.button' },
]

interface RotaryPatternActionsProps {
  variant?: 'toolbar' | 'rail'
  tooltipSide?: 'bottom' | 'right'
}

/**
 * The entries and the dialog they open. It is mounted only while the workspace
 * is on Around, so leaving Around unmounts this whole subtree: the dialog
 * closes, its request state dies with it, and an in-flight Create is stopped by
 * the dialog's own unmount guard. Coming back mounts a fresh, closed one, so a
 * stale request can never be resurrected.
 */
function RotaryAroundActions({
  variant,
  tooltipSide,
}: {
  variant: 'toolbar' | 'rail'
  tooltipSide: 'bottom' | 'right'
}) {
  const { t } = useI18n()
  const [openKind, setOpenKind] = useState<RotaryPatternKind | null>(null)

  const buttons = ROTARY_COMMANDS.map((entry) => {
    const label = t(entry.labelKey)
    const active = openKind === entry.kind
    if (variant === 'rail') {
      return (
        <div className="tool-rail__action" key={entry.kind}>
          <button
            className={`tool-rail__btn ${active ? 'tool-rail__btn--active' : ''}`}
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
      )
    }
    return (
      <ToolbarActionButton
        key={entry.kind}
        icon={entry.icon}
        label={label}
        command={entry.command}
        active={active}
        tooltipSide={tooltipSide}
        onClick={() => setOpenKind(entry.kind)}
      />
    )
  })

  const dialog = openKind !== null && typeof document !== 'undefined'
    ? createPortal(
        <RotaryPatternDialog kind={openKind} onClose={() => setOpenKind(null)} />,
        document.body,
      )
    : null

  if (variant === 'rail') {
    return <>{buttons}{dialog}</>
  }

  return (
    <div className="toolbar-group toolbar-group--rotary">
      {buttons}
      {dialog}
    </div>
  )
}

function RotaryPatternActions({ variant = 'toolbar', tooltipSide = 'bottom' }: RotaryPatternActionsProps) {
  const face = useProjectStore((state) => activeFace(state.project))
  // Rendering the dialog subtree only on Around lets ordinary unmounting clear
  // the pending request, so returning to Around never reopens the old dialog.
  if (face !== 'around') return null
  return <RotaryAroundActions variant={variant} tooltipSide={tooltipSide} />
}

export { RotaryPatternActions }
