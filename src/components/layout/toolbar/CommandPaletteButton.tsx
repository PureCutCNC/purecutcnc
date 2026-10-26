/**
 * Copyright 2026 Maik Rolf
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

import { useI18n } from '../../../i18n/i18nContext'
import { COMMAND_PALETTE_OPEN_EVENT } from '../../commandPalette/events'
import { ToolbarActionButton } from './primitives'

/**
 * Pointer/touch entry point for the command palette. The host owns the open
 * state; this button only raises the shared event.
 */
export function CommandPaletteButton() {
  const { t } = useI18n()

  return (
    <ToolbarActionButton
      icon="search"
      label={t('shell.commandPalette.title')}
      onClick={() => {
        window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT))
      }}
    />
  )
}
