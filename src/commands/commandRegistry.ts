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

/**
 * Framework-free command registry. The UI adapters decide which commands exist;
 * this module only owns identity, metadata, search, and guarded execution so a
 * palette, a script, or a future MCP bridge can share the same contract.
 */

export type CommandGroup = 'file' | 'sketch' | 'create' | 'view'

/**
 * What running the command may do. `read` is safe to repeat and does not touch
 * project state; `edit` changes the current document or an application
 * preference; `destructive` can discard or replace document state.
 */
export type CommandEffect = 'read' | 'edit' | 'destructive'

export interface CommandSpec {
  /** Stable, namespaced identifier, e.g. `file.undo` or `create.rect`. */
  id: string
  /** Already-localized label shown to the user. */
  label: string
  group: CommandGroup
  /** Extra search terms that are not part of the visible label. */
  keywords?: readonly string[]
  /** Display-only shortcut hint; execution stays with the owning UI. */
  shortcut?: string
  effect: CommandEffect
  enabled: boolean
  active?: boolean
  run: () => void | Promise<void>
}

/** Serializable projection of a command, safe to return over a bridge. */
export interface CommandInfo {
  id: string
  label: string
  group: CommandGroup
  keywords: string[]
  shortcut: string | null
  effect: CommandEffect
  enabled: boolean
  active: boolean
}

export type CommandRunFailure = 'not-found' | 'disabled' | 'error'

export interface CommandRunResult {
  ok: boolean
  reason?: CommandRunFailure
  error?: unknown
}

export interface CommandRegistry {
  get(id: string): CommandSpec | undefined
  list(): CommandInfo[]
  search(query: string): CommandSpec[]
  run(id: string): Promise<CommandRunResult>
}

/**
 * Case-insensitive, token-AND search across id, label, group and keywords.
 * An empty query returns every command in registration order.
 */
export function filterCommands(
  commands: readonly CommandSpec[],
  query: string,
): CommandSpec[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return [...commands]

  return commands.filter((command) => {
    const haystack = [
      command.id,
      command.label,
      command.group,
      ...(command.keywords ?? []),
    ].join(' ').toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
}

export function toCommandInfo(command: CommandSpec): CommandInfo {
  return {
    id: command.id,
    label: command.label,
    group: command.group,
    keywords: [...(command.keywords ?? [])],
    shortcut: command.shortcut ?? null,
    effect: command.effect,
    enabled: command.enabled,
    active: command.active ?? false,
  }
}

export function listCommands(commands: readonly CommandSpec[]): CommandInfo[] {
  return commands.map(toCommandInfo)
}

/**
 * Build a registry from a snapshot of the supplied commands. Duplicate ids are
 * a programming error rather than a last-write-wins merge: silently dropping
 * one command is exactly how a palette ends up hiding an action.
 */
export function createCommandRegistry(commands: readonly CommandSpec[]): CommandRegistry {
  const snapshot = [...commands]
  const byId = new Map<string, CommandSpec>()
  for (const command of snapshot) {
    if (byId.has(command.id)) {
      throw new Error(`Duplicate command id: ${command.id}`)
    }
    byId.set(command.id, command)
  }

  return {
    get: (id) => byId.get(id),
    list: () => listCommands(snapshot),
    search: (query) => filterCommands(snapshot, query),
    run: async (id) => {
      const command = byId.get(id)
      if (!command) return { ok: false, reason: 'not-found' }
      if (!command.enabled) return { ok: false, reason: 'disabled' }
      try {
        await command.run()
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: 'error', error }
      }
    },
  }
}
