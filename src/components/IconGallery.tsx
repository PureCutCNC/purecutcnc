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

import { useState } from 'react'
import { Icon } from './Icon'
import { useIconIds } from './useIconIds'

/**
 * Dev-only gallery of every icon in public/icons.svg.
 *
 * Mount by navigating to `#icons` in the dev server (http://localhost:5173/#icons).
 * Renders every <symbol> id in the sprite at 16/18/24/32px so we can
 * visually verify redraws across sizes.
 */

interface GalleryProps {
  iconIds: string[]
}

const PREVIEW_SIZES = [16, 18, 24, 32]

export function IconGallery({ iconIds }: GalleryProps) {
  const [filter, setFilter] = useState('')
  const [fg, setFg] = useState('#111')
  const [bg, setBg] = useState('#fafafa')

  const filtered = filter
    ? iconIds.filter((id) => id.toLowerCase().includes(filter.toLowerCase()))
    : iconIds

  return (
    <div
      style={{
        padding: 24,
        fontFamily: 'system-ui, sans-serif',
        background: bg,
        color: fg,
        minHeight: '100vh',
      }}
    >
      <header
        style={{
          display: 'flex',
          gap: 16,
          alignItems: 'center',
          marginBottom: 24,
          flexWrap: 'wrap',
        }}
      >
        <h1 style={{ margin: 0, fontSize: 20 }}>
          Icon Gallery ({filtered.length}/{iconIds.length})
        </h1>
        <input
          type="search"
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{
            padding: '6px 10px',
            fontSize: 14,
            border: '1px solid #ccc',
            borderRadius: 4,
            minWidth: 200,
          }}
        />
        <label style={{ fontSize: 13 }}>
          fg{' '}
          <input type="color" value={fg} onChange={(e) => setFg(e.target.value)} />
        </label>
        <label style={{ fontSize: 13 }}>
          bg{' '}
          <input type="color" value={bg} onChange={(e) => setBg(e.target.value)} />
        </label>
        <span style={{ fontSize: 12, opacity: 0.6 }}>
          (dev-only · navigate away from #icons to return to the app)
        </span>
      </header>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
          gap: 12,
        }}
      >
        {filtered.map((id) => (
          <div
            key={id}
            style={{
              border: '1px solid rgba(128,128,128,0.25)',
              borderRadius: 6,
              padding: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              alignItems: 'center',
              background: 'transparent',
            }}
          >
            <div
              style={{
                display: 'flex',
                gap: 12,
                alignItems: 'flex-end',
                minHeight: 40,
              }}
            >
              {PREVIEW_SIZES.map((size) => (
                <div
                  key={size}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 4,
                  }}
                  title={`${size}px`}
                >
                  <Icon id={id} size={size} />
                  <span style={{ fontSize: 9, opacity: 0.5 }}>{size}</span>
                </div>
              ))}
            </div>
            <code
              style={{
                fontSize: 11,
                opacity: 0.75,
                fontFamily: 'ui-monospace, monospace',
                userSelect: 'all',
              }}
            >
              {id}
            </code>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Wraps IconGallery with the sprite-id fetch hook.
 * Exported separately so main.tsx can mount it without having to pull in
 * the hook and call the inner component itself.
 */
export function IconGalleryRoute() {
  const iconIds = useIconIds()
  return <IconGallery iconIds={iconIds} />
}
