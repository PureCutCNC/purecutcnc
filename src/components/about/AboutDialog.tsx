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

import { useEffect, useMemo, useState } from 'react'
import { useRestoreCanvasFocus } from '../../utils/useRestoreCanvasFocus'
import { loadVersionInfo, type VersionInfo } from '../../utils/version'
import { platform } from '../../platform'
import { useI18n } from '../../i18n/i18nContext'
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
  const { t, languageTag } = useI18n()
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
  const released = useMemo(() => formatDate(info?.date), [info?.date])

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

  // eslint-disable-next-line react-hooks/exhaustive-deps -- t is identity-stable; languageTag drives locale recomputes
  const versionLabel = useMemo(() => t('viewport.about.version', { version }), [t, version, languageTag])

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog dialog--about"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('viewport.about.ariaLabel')}
      >
        <div className="dialog-header">
          <h2 className="dialog-title">{t('viewport.about.title')}</h2>
          <button className="dialog-close" onClick={onClose} aria-label={t('viewport.about.close')} type="button">
            ✕
          </button>
        </div>

        <div className="dialog-body dialog-body--about">
          <div className="about-heading">
            <span className="about-name">PureCutCNC</span>
            <span className="about-version">{versionLabel}</span>
          </div>

          <p className="about-tagline">{t('viewport.about.tagline')}</p>

          {(released || info?.name) && (
            <div className="about-meta">
              {info?.name && (
                <div className="about-meta-row">
                  <span>{t('viewport.about.releaseLabel')}</span>
                  <strong>{info.name}</strong>
                </div>
              )}
              {released && (
                <div className="about-meta-row">
                  <span>{t('viewport.about.releasedLabel')}</span>
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
              {t('viewport.about.website')}
            </a>
            <a
              className="about-link"
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={handleExternalLink(REPO_URL)}
            >
              {t('viewport.about.source')}
            </a>
            <a
              className="about-link"
              href={RELEASES_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={handleExternalLink(RELEASES_URL)}
            >
              {t('viewport.about.releases')}
            </a>
            <a
              className="about-link"
              href={LICENSE_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={handleExternalLink(LICENSE_URL)}
            >
              {t('viewport.about.license')}
            </a>
          </div>

          <div className="about-support">
            <p className="about-support-text">{t('viewport.about.supportText')}</p>
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
              {t('viewport.about.buyCoffee')}
            </a>
          </div>

          <p className="about-copyright">© 2026 Franja (Frank) Povazanj. Licensed under Apache-2.0.</p>
        </div>

        <div className="dialog-footer">
          <button className="btn-primary" type="button" onClick={onClose}>
            {t('viewport.about.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
