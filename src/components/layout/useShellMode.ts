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

export type ShellMode = 'desktop-wide' | 'desktop-compact' | 'tablet' | 'tablet-compact'

const COARSE_QUERY = '(pointer: coarse)'
const NO_HOVER_QUERY = '(hover: none)'

function computeShellMode(width: number, isCoarse: boolean): ShellMode {
  if (isCoarse) {
    return width >= 900 ? 'tablet' : 'tablet-compact'
  }
  return width >= 1400 ? 'desktop-wide' : 'desktop-compact'
}

export function useShellMode(): ShellMode {
  const [mode, setMode] = useState<ShellMode>(() => {
    const isCoarse = window.matchMedia(COARSE_QUERY).matches || window.matchMedia(NO_HOVER_QUERY).matches
    return computeShellMode(window.innerWidth, isCoarse)
  })

  useEffect(() => {
    const coarseMql = window.matchMedia(COARSE_QUERY)
    const noHoverMql = window.matchMedia(NO_HOVER_QUERY)

    function update() {
      const isCoarse = coarseMql.matches || noHoverMql.matches
      setMode(computeShellMode(window.innerWidth, isCoarse))
    }

    window.addEventListener('resize', update)
    coarseMql.addEventListener('change', update)
    noHoverMql.addEventListener('change', update)

    return () => {
      window.removeEventListener('resize', update)
      coarseMql.removeEventListener('change', update)
      noHoverMql.removeEventListener('change', update)
    }
  }, [])

  return mode
}

export function isTabletMode(mode: ShellMode): boolean {
  return mode === 'tablet' || mode === 'tablet-compact'
}
