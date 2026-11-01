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
 * The Turn and Polygon entries (issue #1112 slice G; canvas panel in rt2-b).
 *
 * They are not a separate toolbar group: the creation drawer's rotary group
 * holds them next to Thread and Flutes, and the tablet rail keeps a rail
 * variant. Each entry arms the canvas creation panel through the store — the
 * same page-level panel the other canned shapes use — so the drawer closing
 * cannot unmount an open form, and no modal is involved.
 *
 * The entries work while the bar workflow is available: a rotary project with
 * round or square bar stock, on **any** face. A Turn or Polygon belongs to the
 * bar, not to the face it was drawn on, so Top and Bottom offer them too
 * (issue #1112 rt2-b item 20). A block has no bar to turn, and the entries stay
 * listed there, disabled with the reason, rather than vanishing (issue #1112
 * rt3-d item 31).
 */

import { useProjectStore } from '../../../store/projectStore'
import { aroundUnavailableReason } from '../../../store/helpers/activeFace'
import { useI18n } from '../../../i18n/i18nContext'
import type { MessageKey } from '../../../i18n/locales/en'
import { Icon } from '../../Icon'
import { ToolbarActionButton } from './primitives'
import type { RotarySolidCannedKind } from '../../../store/types'

interface RotarySolidCommand {
  kind: RotarySolidCannedKind
  command: string
  icon: string
  labelKey: MessageKey
}

const ROTARY_SOLID_COMMANDS: readonly RotarySolidCommand[] = [
  { kind: 'turn', command: 'rotary-turn', icon: 'turn', labelKey: 'dialogs.rotarySolid.turn.button' },
  // Polygon (the Hex model) has its own icon since rt3-d item 32: a hexagonal
  // bar section on the centreline, not the regular-polygon outline it used to
  // borrow ('ngon').
  { kind: 'polygon', command: 'rotary-polygon', icon: 'hex', labelKey: 'dialogs.rotarySolid.polygon.button' },
]

interface RotarySolidActionsProps {
  variant?: 'drawer' | 'rail'
  tooltipSide?: 'bottom' | 'right'
}

function RotarySolidActions({ variant = 'drawer', tooltipSide = 'bottom' }: RotarySolidActionsProps) {
  const { t } = useI18n()
  const project = useProjectStore((state) => state.project)
  const start = useProjectStore((state) => state.startAddRotarySolidPlacement)
  // Turn and Polygon turn the bar, so a block project — milling or plasma —
  // cannot create them. The entries keep their place and say why instead of
  // disappearing (issue #1112 rt3-d item 31).
  const blockedReason = aroundUnavailableReason(project) === null
    ? undefined
    : t('sketch.creation.rotaryBarUnavailable')

  if (variant === 'rail') {
    return (
      <>
        {ROTARY_SOLID_COMMANDS.map((entry) => {
          const label = t(entry.labelKey)
          return (
            <div className="tool-rail__action" key={entry.kind}>
              <button
                className="tool-rail__btn"
                type="button"
                data-command={entry.command}
                aria-label={label}
                disabled={blockedReason !== undefined}
                title={blockedReason}
                onClick={() => start(entry.kind)}
              >
                <Icon id={entry.icon} />
              </button>
              <span className="tool-rail__tooltip" role="tooltip">
                {blockedReason ? `${label} — ${blockedReason}` : label}
              </span>
            </div>
          )
        })}
      </>
    )
  }

  // The drawer stacks its shape rows; the rotary group adds one row of buttons
  // behind a separator owned by `CreationActions`, so Turn and Polygon sit in
  // the same group as Thread and Flutes.
  return (
    <>
      {ROTARY_SOLID_COMMANDS.map((entry) => (
        <ToolbarActionButton
          key={entry.kind}
          icon={entry.icon}
          label={t(entry.labelKey)}
          command={entry.command}
          disabled={blockedReason !== undefined}
          disabledReason={blockedReason}
          tooltipSide={tooltipSide}
          onClick={() => start(entry.kind)}
        />
      ))}
    </>
  )
}

export { RotarySolidActions }
