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

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { useI18n } from '../../i18n/i18nContext'
import type { MessageKey } from '../../i18n/locales/en'
import {
  createCommandRegistry,
  filterCommands,
  type CommandGroup,
  type CommandSpec,
} from '../../commands/commandRegistry'
import { useAppCommands } from '../../commands/useAppCommands'
import { useRestoreCanvasFocus } from '../../utils/useRestoreCanvasFocus'
import './commandPalette.css'

const GROUP_LABEL_KEYS: Record<CommandGroup, MessageKey> = {
  file: 'shell.commandPalette.group.file',
  sketch: 'shell.commandPalette.group.sketch',
  create: 'shell.commandPalette.group.create',
  view: 'shell.commandPalette.group.view',
}

function optionId(id: string): string {
  return `command-palette-option-${id}`
}

export interface CommandPaletteProps {
  onNewProject: () => void
  onImportGeometry?: () => void
  onExportModel: () => void
  onPrintDesign?: () => void
  onRequestText?: () => void
  onZoomToModel: () => void
  onClose: () => void
}

export function CommandPalette({
  onNewProject,
  onImportGeometry,
  onExportModel,
  onPrintDesign,
  onRequestText,
  onZoomToModel,
  onClose,
}: CommandPaletteProps) {
  const { t } = useI18n()
  useRestoreCanvasFocus()

  const commands = useAppCommands({
    onNewProject,
    onImportGeometry,
    onExportModel,
    onPrintDesign,
    onRequestText,
    onZoomToModel,
  })
  const registry = createCommandRegistry(commands)
  const available = commands.filter((command) => command.enabled)

  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const filtered = filterCommands(available, query)
  const selectedIndex = filtered.length === 0 ? 0 : Math.min(activeIndex, filtered.length - 1)
  const activeCommand = filtered[selectedIndex] ?? null
  const activeOptionId = activeCommand ? optionId(activeCommand.id) : undefined

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }

    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [onClose])

  useEffect(() => {
    if (!activeOptionId) return
    document.getElementById(activeOptionId)?.scrollIntoView({ block: 'nearest' })
  }, [activeOptionId])

  async function execute(command: CommandSpec) {
    onClose()
    const result = await registry.run(command.id)
    if (!result.ok && result.reason === 'error') {
      console.error(`Command palette: ${command.id} failed`, result.error)
    }
  }

  function handleQueryChange(value: string) {
    setQuery(value)
    setActiveIndex(0)
  }

  function handleInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => filtered.length === 0 ? 0 : (index + 1) % filtered.length)
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => filtered.length === 0 ? 0 : (index - 1 + filtered.length) % filtered.length)
      return
    }

    if (event.key === 'Enter' && activeCommand) {
      event.preventDefault()
      void execute(activeCommand)
    }
  }

  return (
    <div className="command-palette-backdrop" onMouseDown={onClose}>
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label={t('shell.commandPalette.title')}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="command-palette-search">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => handleQueryChange(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder={t('shell.commandPalette.placeholder')}
            aria-label={t('shell.commandPalette.placeholder')}
            aria-controls="command-palette-list"
            aria-activedescendant={activeOptionId}
            autoComplete="off"
            spellCheck={false}
          />
          <kbd>Esc</kbd>
        </div>

        {filtered.length === 0 ? (
          <div className="command-palette-empty">{t('shell.commandPalette.noResults')}</div>
        ) : (
          <ul
            id="command-palette-list"
            className="command-palette-list"
            role="listbox"
            aria-label={t('shell.commandPalette.title')}
          >
            {filtered.map((command, index) => {
              const selected = index === selectedIndex
              return (
                <li
                  key={command.id}
                  id={optionId(command.id)}
                  role="option"
                  aria-selected={selected}
                >
                  <button
                    type="button"
                    tabIndex={-1}
                    className={`command-palette-option${selected ? ' is-active' : ''}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => { void execute(command) }}
                  >
                    <span className="command-palette-label">{command.label}</span>
                    <span className="command-palette-meta">
                      {t(GROUP_LABEL_KEYS[command.group])}
                      {command.shortcut ? <kbd>{command.shortcut}</kbd> : null}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        <div className="command-palette-footer">{t('shell.commandPalette.hint')}</div>
      </div>
    </div>
  )
}
