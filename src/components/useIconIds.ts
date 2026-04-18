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

import { useEffect, useState } from 'react'

/**
 * Fetches the generated icons.svg sprite and returns every <symbol id="…">.
 * Used by the dev-only IconGallery route.
 */
export function useIconIds(): string[] {
  const [ids, setIds] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    fetch(`${import.meta.env.BASE_URL}icons.svg`)
      .then((res) => res.text())
      .then((text) => {
        if (cancelled) return
        const matches = Array.from(text.matchAll(/<symbol[^>]*\bid="([^"]+)"/g))
        const found = matches.map((m) => m[1]).sort((a, b) => a.localeCompare(b))
        setIds(found)
      })
      .catch(() => {
        /* leave ids empty on fetch failure */
      })
    return () => {
      cancelled = true
    }
  }, [])

  return ids
}
