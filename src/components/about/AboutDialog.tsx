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
import { platform } from '../../platform'
import './about.css'

interface AboutDialogProps {
  onClose: () => void
}

const REPO_URL = 'https://github.com/PureCutCNC/purecutcnc'
const RELEASES_URL = 'https://github.com/PureCutCNC/purecutcnc/releases'
const SITE_URL = 'https://purecutcnc.github.io'
const LICENSE_URL = 'https://github.com/PureCutCNC/purecutcnc/blob/main/LICENSE'
const SPONSOR_URL = 'https://buymeacoffee.com/purecutcnc'

function formatDate(iso?: string): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

export function AboutDialog({ onClose }: AboutDialogProps) {
  useRestoreCanvasFocus()
  const [info, setInfo] = useState<VersionInfo | null>(null)
  const [desktopVersion, setDesktopVersion] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    loadVersionInfo().then((value) => {
      if (active) setInfo(value)
    })
    // version.json is not bundled with the desktop app, so loadVersionInfo would
    // report "dev" there — prefer Tauri's real app version instead.
    if (platform.isDesktop) {
      platform
        .getAppVersion()
        .then((v) => {
          if (active) setDesktopVersion(v)
        })
        .catch(() => {})
    }
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

  const version = desktopVersion ?? info?.version ?? '…'
  const released = formatDate(info?.date)

  // In the Tauri webview a plain <a target="_blank"> does not open the system
  // browser, so on desktop route external links through the platform opener.
  // On web the native anchor behaviour (new tab, modified-click) is left intact.
  const handleExternalLink =
    (url: string) => (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (platform.isDesktop) {
        event.preventDefault()
        void platform.openExternal(url)
      }
    }

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
            2.5D CAD/CAM for CNC hobbyists — sketching and machining in one workflow, on the
            web or your desktop.
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
            <a
              className="about-link"
              href={SITE_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={handleExternalLink(SITE_URL)}
            >
              Website
            </a>
            <a
              className="about-link"
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={handleExternalLink(REPO_URL)}
            >
              Source
            </a>
            <a
              className="about-link"
              href={RELEASES_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={handleExternalLink(RELEASES_URL)}
            >
              Releases
            </a>
            <a
              className="about-link"
              href={LICENSE_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={handleExternalLink(LICENSE_URL)}
            >
              License (Apache-2.0)
            </a>
          </div>

          <div className="about-support">
            <p className="about-support-text">
              PureCutCNC is free, and stays free — but building and maintaining it takes real
              time and money. If it helps you, a coffee keeps it going.
            </p>
            <a
              className="about-coffee-btn"
              href={SPONSOR_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={handleExternalLink(SPONSOR_URL)}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M18 8h1a4 4 0 0 1 0 8h-1" />
                <path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z" />
                <line x1="6" y1="1" x2="6" y2="4" />
                <line x1="10" y1="1" x2="10" y2="4" />
                <line x1="14" y1="1" x2="14" y2="4" />
              </svg>
              Buy me a coffee
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
