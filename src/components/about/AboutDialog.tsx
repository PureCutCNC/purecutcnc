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
import { useRestoreCanvasFocus } from '../../utils/useRestoreCanvasFocus'
import { loadVersionInfo, type VersionInfo } from '../../utils/version'
import './about.css'

interface AboutDialogProps {
  onClose: () => void
}

const REPO_URL = 'https://github.com/PureCutCNC/purecutcnc'
const RELEASES_URL = 'https://github.com/PureCutCNC/purecutcnc/releases'
const SITE_URL = 'https://purecutcnc.github.io'
const LICENSE_URL = 'https://github.com/PureCutCNC/purecutcnc/blob/main/LICENSE'

function formatDate(iso?: string): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

export function AboutDialog({ onClose }: AboutDialogProps) {
  useRestoreCanvasFocus()
  const [info, setInfo] = useState<VersionInfo | null>(null)

  useEffect(() => {
    let active = true
    loadVersionInfo().then((value) => {
      if (active) setInfo(value)
    })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const version = info?.version ?? '…'
  const released = formatDate(info?.date)

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog dialog--about"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="About PureCutCNC"
      >
        <div className="dialog-header">
          <h2 className="dialog-title">About</h2>
          <button className="dialog-close" onClick={onClose} aria-label="Close" type="button">
            ✕
          </button>
        </div>

        <div className="dialog-body dialog-body--about">
          <div className="about-heading">
            <span className="about-name">PureCutCNC</span>
            <span className="about-version">Version {version}</span>
          </div>

          <p className="about-tagline">
            Browser-based 2.5D CAD/CAM for CNC hobbyists — sketching and machining in one workflow.
          </p>

          {(released || info?.name) && (
            <div className="about-meta">
              {info?.name && (
                <div className="about-meta-row">
                  <span>Release</span>
                  <strong>{info.name}</strong>
                </div>
              )}
              {released && (
                <div className="about-meta-row">
                  <span>Released</span>
                  <strong>{released}</strong>
                </div>
              )}
            </div>
          )}

          <div className="about-links">
            <a className="about-link" href={SITE_URL} target="_blank" rel="noopener noreferrer">
              Website
            </a>
            <a className="about-link" href={REPO_URL} target="_blank" rel="noopener noreferrer">
              Source
            </a>
            <a className="about-link" href={RELEASES_URL} target="_blank" rel="noopener noreferrer">
              Releases
            </a>
            <a className="about-link" href={LICENSE_URL} target="_blank" rel="noopener noreferrer">
              License (Apache-2.0)
            </a>
          </div>

          <p className="about-copyright">© 2026 Franja (Frank) Povazanj. Licensed under Apache-2.0.</p>
        </div>

        <div className="dialog-footer">
          <button className="btn-primary" type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
