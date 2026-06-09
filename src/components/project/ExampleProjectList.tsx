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
 * Renders the bundled example projects from `public/examples/manifest.json` and
 * loads a chosen one through the existing `openProjectFromText` store action —
 * the same path used when opening a `.camj` file from disk. Used by both the
 * empty-state onboarding overlay and the New Project dialog.
 */

import { useEffect, useState } from 'react'
import { useProjectStore } from '../../store/projectStore'

interface ExampleManifestEntry {
  id: string
  title: string
  description: string
  file: string
  thumbnail?: string
}

interface ExampleProjectListProps {
  /** Called after an example has been loaded into the store. */
  onOpened?: () => void
}

const examplesBase = `${import.meta.env.BASE_URL}examples/`

export function ExampleProjectList({ onOpened }: ExampleProjectListProps) {
  const [entries, setEntries] = useState<ExampleManifestEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openingId, setOpeningId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`${examplesBase}manifest.json`)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Failed to load examples (${response.status})`)
        }
        return response.json() as Promise<ExampleManifestEntry[]>
      })
      .then((data) => {
        if (cancelled) return
        setEntries(data)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load examples.')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleOpen(entry: ExampleManifestEntry) {
    setOpeningId(entry.id)
    setError(null)

    let content: string
    try {
      const response = await fetch(`${examplesBase}${entry.file}`)
      if (!response.ok) {
        throw new Error(`Failed to load ${entry.file} (${response.status})`)
      }
      content = await response.text()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load example.')
      setOpeningId(null)
      return
    }

    // Mirror useFileActions: show the loading overlay and yield a frame so the
    // browser can paint before the synchronous parse/normalize blocks the thread.
    useProjectStore.setState({ projectLoading: true })
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    )

    try {
      useProjectStore.getState().openProjectFromText(content, null)
      onOpened?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open example.')
    } finally {
      useProjectStore.setState({ projectLoading: false })
      setOpeningId(null)
    }
  }

  if (loading) {
    return <div className="example-project-list__status">Loading examples…</div>
  }

  if (entries.length === 0) {
    return (
      <div className="example-project-list__status example-project-list__status--error">
        {error ?? 'No examples available.'}
      </div>
    )
  }

  return (
    <div className="example-project-list">
      {entries.map((entry) => (
        <button
          key={entry.id}
          className="example-project-card"
          type="button"
          onClick={() => handleOpen(entry)}
          disabled={openingId !== null}
        >
          {entry.thumbnail ? (
            <img
              className="example-project-card__thumb"
              src={`${examplesBase}${entry.thumbnail}`}
              alt=""
              loading="lazy"
            />
          ) : null}
          <span className="example-project-card__title">{entry.title}</span>
          <span className="example-project-card__meta">{entry.description}</span>
          {openingId === entry.id ? (
            <span className="example-project-card__status">Opening…</span>
          ) : null}
        </button>
      ))}
      {error ? (
        <div className="example-project-list__status example-project-list__status--error">{error}</div>
      ) : null}
    </div>
  )
}
