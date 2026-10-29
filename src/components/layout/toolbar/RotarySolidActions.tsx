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
 * The entries exist while the bar workflow is available: a rotary project with
 * round or square bar stock, on **any** face. A Turn or Polygon belongs to the
 * bar, not to the face it was drawn on, so Top and Bottom offer them too
 * (issue #1112 rt2-b item 20); a block is not offered because there is no bar
 * to turn.
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
  { kind: 'polygon', command: 'rotary-polygon', icon: 'ngon', labelKey: 'dialogs.rotarySolid.polygon.button' },
]

interface RotarySolidActionsProps {
  variant?: 'drawer' | 'rail'
  tooltipSide?: 'bottom' | 'right'
}

function RotarySolidActions({ variant = 'drawer', tooltipSide = 'bottom' }: RotarySolidActionsProps) {
  const { t } = useI18n()
  const project = useProjectStore((state) => state.project)
  const start = useProjectStore((state) => state.startAddRotarySolidPlacement)
  if (aroundUnavailableReason(project) !== null) return null

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
                onClick={() => start(entry.kind)}
              >
                <Icon id={entry.icon} />
              </button>
              <span className="tool-rail__tooltip" role="tooltip">{label}</span>
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
          tooltipSide={tooltipSide}
          onClick={() => start(entry.kind)}
        />
      ))}
    </>
  )
}

export { RotarySolidActions }
