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
 * Centralized colour palette for document-output renderers.
 *
 * These colours render documents destined for paper — SVG prints, PDF
 * booklets, operation-snapshot PNGs, and printable HTML wrappers.  They are
 * deliberately **NOT theme tokens** and must never be imported from
 * `src/theme/**`: printed paper has no dark mode, and its palette should stay
 * stable regardless of the UI theme.
 *
 * Every entry is named for its semantic **role** (e.g. `stockOutline`,
 * `targetFeatureFill`, `sheetBackground`), never its hue.  When the same
 * literal serves the same role across files it appears once; different roles
 * keep separate entries even when they share a value.
 */

import { rgb } from 'pdf-lib'

// ── Shared print-document constants ────────────────────────────────────────

/** White paper/sheet background for print documents (SVG paper rect, HTML body). */
const sheetBackground = '#ffffff' as const

// ── SVG print palettes ────────────────────────────────────────────────────

/**
 * Colour-mode SVG print palette.  Used when `DesignPrintOptions.colorMode` is
 * `'color'` (the default).  These match the light-background paper output; they
 * are independent of the UI theme.
 */
const svgColor = Object.freeze({
  stockOutline: '#6b6b6b',
  subtractFeatureStroke: '#1f6fb2',
  addFeatureStroke: '#2e8b57',
  modelFeatureStroke: '#75828f',
  regionStroke: '#8a5fc0',
  regionExcludeStroke: '#a37fd4',
  constructionStroke: '#8a97a5',
  tabOutline: '#5f8f33',
  clampOutline: '#5b6fb5',
  dimensionLine: '#333333',
  dimensionExtensionLine: '#8c8c8c',
  featureLabelText: '#333333',
  originXAxis: '#c0392b',
  originYAxis: '#27ae60',
  originDotFill: '#2e6fb2',
  gridMinorLine: '#d9dde2',
  gridMajorLine: '#b8bfc7',
  cutToolpath: '#d84315',
  rapidToolpath: '#1e88e5',
  plungeToolpath: '#8e24aa',
  footerText: '#333333',
  textHalo: '#ffffff',
})

/**
 * Monochrome SVG print palette.  Used when `DesignPrintOptions.colorMode` is
 * `'monochrome'`.  All feature roles render in greyscale for black-and-white
 * printers while keeping the same semantic keys as the colour palette.
 */
const svgMono = Object.freeze({
  stockOutline: '#555555',
  subtractFeatureStroke: '#222222',
  addFeatureStroke: '#222222',
  modelFeatureStroke: '#666666',
  regionStroke: '#444444',
  regionExcludeStroke: '#666666',
  constructionStroke: '#777777',
  tabOutline: '#555555',
  clampOutline: '#555555',
  dimensionLine: '#222222',
  dimensionExtensionLine: '#777777',
  featureLabelText: '#222222',
  originXAxis: '#222222',
  originYAxis: '#222222',
  originDotFill: '#222222',
  gridMinorLine: '#dddddd',
  gridMajorLine: '#bbbbbb',
  cutToolpath: '#333333',
  rapidToolpath: '#888888',
  plungeToolpath: '#666666',
  footerText: '#222222',
  textHalo: '#ffffff',
})

// ── PDF operation-booklet palette ──────────────────────────────────────────

const pdf = Object.freeze({
  /** Section title text, accent bar, and header stripe. */
  accentColor: rgb(0.12, 0.34, 0.54),
  /** Description-block background. */
  accentBackground: rgb(0.9, 0.95, 0.98),
  /** Body text. */
  bodyText: rgb(0.1, 0.13, 0.17),
  /** Panel and description-block border, header separator line. */
  borderStroke: rgb(0.73, 0.78, 0.83),
  /** Footer text and generated-date label. */
  footerText: rgb(0.42, 0.46, 0.5),
  /** Row-label text, section subtitles, and snapshot label. */
  mutedText: rgb(0.3, 0.34, 0.39),
  /** Snapshot frame background. */
  panelBackground: rgb(0.97, 0.98, 0.99),
  /** Row separator and page-footer hairline. */
  rowRuleStroke: rgb(0.88, 0.91, 0.94),
})

// ── Operation-snapshot canvas palette ──────────────────────────────────────

const snapshot = Object.freeze({
  /** Canvas background fill before any geometry is drawn. */
  sheetBackground: '#f6f8fb',
  /** Stock rectangle fill. */
  stockFill: '#ffffff',
  /** Stock rectangle outline. */
  stockOutline: '#9aa8b5',
  /** Target-feature profile fill (rgba). */
  targetFeatureFill: 'rgba(47, 127, 200, 0.20)',
  /** Target-feature profile stroke. */
  targetFeatureStroke: '#2563a8',
  /** Non-target feature profile fill (rgba). */
  nonTargetFeatureFill: 'rgba(124, 139, 154, 0.10)',
  /** Non-target feature profile stroke (rgba). */
  nonTargetFeatureStroke: 'rgba(105, 121, 138, 0.54)',
  /** Origin crosshair halo (white glow behind the crosshair). */
  originCrosshairHalo: 'rgba(255, 255, 255, 0.96)',
  /** Origin crosshair stroke. */
  originCrosshairStroke: '#1f2937',
  /** Origin centre dot fill. */
  originDotFill: '#2f7fc8',
  /** Origin centre dot border. */
  originDotBorder: '#ffffff',
  /** Operation-name label text (rgba). */
  labelText: 'rgba(20, 28, 36, 0.84)',
})

// ── Public frozen aggregate ───────────────────────────────────────────────

export const printPalette = Object.freeze({
  sheetBackground,
  svgColor,
  svgMono,
  pdf,
  snapshot,
})
