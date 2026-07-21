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
 * The allowlisted, typed set of semantic theme roles a custom theme may
 * override. This is the single authority on what is editable: schema
 * validation, the guided editor, and import all reject keys outside this
 * list. Tokens are colors only — never selectors, URLs, fonts, spacing, or
 * arbitrary CSS.
 *
 * Keys map onto the runtime boundaries introduced by the appearance work:
 * - `css` tokens are the `--<key>` custom properties in `src/index.css`;
 * - `canvas` tokens feed the 2D sketch canvas palette;
 * - `three` tokens feed the Three.js viewport/simulation palette.
 */

export type ThemeTokenGroup =
  | 'surfaces'
  | 'text'
  | 'controls'
  | 'status'
  | 'sketch-roles'
  | 'canvas'
  | 'canvas-geometry'
  | 'canvas-controls'
  | 'canvas-toolpath'
  | 'canvas-annotation'
  | 'three'

export interface ThemeTokenGroupMeta {
  id: ThemeTokenGroup
  label: string
  description: string
}

export const THEME_TOKEN_GROUPS: readonly ThemeTokenGroupMeta[] = [
  { id: 'surfaces', label: 'Surfaces', description: 'Application, panel, and input backgrounds.' },
  { id: 'text', label: 'Text', description: 'Primary, muted, status, and on-accent text.' },
  { id: 'controls', label: 'Borders & controls', description: 'Borders, hover, pressed, selected, and depth effects.' },
  { id: 'status', label: 'Accent & status', description: 'Accent, focus, positive, informational, warning, and danger colors.' },
  { id: 'sketch-roles', label: 'Sketch roles', description: 'Semantic colors for line, region, and construction features.' },
  { id: 'canvas', label: 'Sketch canvas', description: 'Canvas background, grid, labels, and interaction accents.' },
  { id: 'canvas-geometry', label: 'Canvas geometry', description: 'Feature fills and outlines by operation.' },
  { id: 'canvas-controls', label: 'Canvas controls', description: 'Sketch control points, handles, and guides.' },
  { id: 'canvas-toolpath', label: 'Canvas toolpaths', description: 'Toolpath move kinds drawn over the sketch.' },
  { id: 'canvas-annotation', label: 'Canvas annotations', description: 'Dimensions, origin, clamps, tabs, snapping, and validation.' },
  { id: 'three', label: '3D & simulation', description: 'Viewport background and grid presentation.' },
] as const

export type ThemeTokenKind = 'css' | 'canvas' | 'three'

export interface ThemeTokenMeta {
  /** Stable token key, e.g. `text`, `canvas.background`, `three.gridMajor`. */
  key: string
  kind: ThemeTokenKind
  group: ThemeTokenGroup
  label: string
}

function css(key: string, group: ThemeTokenGroup, label: string): ThemeTokenMeta {
  return { key, kind: 'css', group, label }
}

function canvas(name: string, label: string, group: ThemeTokenGroup = 'canvas'): ThemeTokenMeta {
  return { key: `canvas.${name}`, kind: 'canvas', group, label }
}

function three(name: string, label: string): ThemeTokenMeta {
  return { key: `three.${name}`, kind: 'three', group: 'three', label }
}

export const THEME_TOKENS: readonly ThemeTokenMeta[] = [
  // Application and panel surfaces.
  css('bg', 'surfaces', 'App background'),
  css('bg-elev-1', 'surfaces', 'Raised background 1'),
  css('bg-elev-2', 'surfaces', 'Raised background 2'),
  css('surface-app', 'surfaces', 'App surface'),
  css('surface-canvas', 'surfaces', 'Canvas surface'),
  css('surface-panel', 'surfaces', 'Panel surface'),
  css('surface-subtle', 'surfaces', 'Subtle surface'),
  css('surface-raised', 'surfaces', 'Raised surface'),
  css('surface-popover', 'surfaces', 'Popover surface'),
  css('surface-translucent', 'surfaces', 'Translucent surface'),
  css('surface-input', 'surfaces', 'Input surface'),

  // Text.
  css('text', 'text', 'Primary text'),
  css('text-dim', 'text', 'Muted text'),
  css('status-text', 'text', 'Status bar text'),
  css('status-text-muted', 'text', 'Status bar muted text'),
  css('on-accent', 'text', 'Text on accent'),

  // Borders, interaction states, and depth effects.
  css('line', 'controls', 'Border'),
  css('line-strong', 'controls', 'Strong border'),
  css('surface-hover', 'controls', 'Hover wash'),
  css('surface-control-top', 'controls', 'Control gradient top'),
  css('surface-control-bottom', 'controls', 'Control gradient bottom'),
  css('surface-button-top', 'controls', 'Button gradient top'),
  css('surface-button-bottom', 'controls', 'Button gradient bottom'),
  css('surface-active-top', 'controls', 'Pressed gradient top'),
  css('surface-active-bottom', 'controls', 'Pressed gradient bottom'),
  css('surface-inset', 'controls', 'Inset shading'),
  css('surface-sheen', 'controls', 'Sheen'),
  css('surface-sheen-soft', 'controls', 'Sheen (soft)'),
  css('surface-sheen-mid', 'controls', 'Sheen (mid)'),
  css('surface-sheen-strong', 'controls', 'Sheen (strong)'),
  css('shadow', 'controls', 'Shadow'),
  css('shadow-strong', 'controls', 'Strong shadow'),

  // Accent and status colors.
  css('accent', 'status', 'Accent / focus'),
  css('accent-strong', 'status', 'Accent (strong)'),
  css('accent-soft', 'status', 'Accent wash'),
  css('add', 'status', 'Positive / add'),
  css('cut', 'status', 'Informational / cut'),
  css('danger-text', 'status', 'Danger text'),
  css('warning-text', 'status', 'Warning text'),

  // Toolpath legend swatches; mirror the canvas and 3D overlay colours.
  css('toolpath-cut', 'status', 'Toolpath cut'),
  css('toolpath-rapid', 'status', 'Toolpath rapid'),
  css('toolpath-plunge', 'status', 'Toolpath plunge'),
  css('toolpath-direction', 'status', 'Toolpath direction'),

  // Semantic sketch feature roles.
  css('role-line', 'sketch-roles', 'Line role'),
  css('role-line-text', 'sketch-roles', 'Line role text'),
  css('role-region', 'sketch-roles', 'Region role'),
  css('role-region-text', 'sketch-roles', 'Region role text'),
  css('role-construction', 'sketch-roles', 'Construction role'),
  css('role-construction-text', 'sketch-roles', 'Construction role text'),

  // 2D sketch canvas presentation.
  canvas('background', 'Canvas background'),
  canvas('gridMajor', 'Grid (major)'),
  canvas('gridMinor', 'Grid (minor)'),
  canvas('labelBackground', 'Label background'),
  canvas('labelText', 'Label text'),
  canvas('mutedGeometry', 'Muted geometry'),
  canvas('veil', 'Inactive veil'),
  canvas('active', 'Active highlight'),
  canvas('activeStrong', 'Active highlight ring'),
  canvas('draft', 'Draft / preview stroke'),
  canvas('draftStrong', 'Draft ring / close target'),

  // Feature geometry by operation.
  canvas('featureCutFill', 'Cut feature fill', 'canvas-geometry'),
  canvas('featureCutStroke', 'Cut feature outline', 'canvas-geometry'),
  canvas('featureAddFill', 'Add feature fill', 'canvas-geometry'),
  canvas('featureAddStroke', 'Add feature outline', 'canvas-geometry'),
  canvas('featureModelFill', 'Model feature fill', 'canvas-geometry'),
  canvas('featureModelStroke', 'Model feature outline', 'canvas-geometry'),
  canvas('featureRegionFill', 'Region fill', 'canvas-geometry'),
  canvas('featureRegionStroke', 'Region outline', 'canvas-geometry'),
  canvas('featureRegionExcludeStroke', 'Excluded region outline', 'canvas-geometry'),
  canvas('featureConstructionStroke', 'Construction outline', 'canvas-geometry'),
  canvas('featureGroupFill', 'Group selection fill', 'canvas-geometry'),
  canvas('featureGroupStroke', 'Group selection outline', 'canvas-geometry'),
  canvas('featureInfoText', 'Feature label text', 'canvas-geometry'),
  canvas('featureInfoSubText', 'Feature label detail text', 'canvas-geometry'),

  // Sketch control points and handles.
  canvas('handleFill', 'Handle fill', 'canvas-controls'),
  canvas('handleStroke', 'Handle outline', 'canvas-controls'),
  canvas('nodeStroke', 'Node outline', 'canvas-controls'),
  canvas('vertexFill', 'Vertex fill', 'canvas-controls'),
  canvas('vertexStroke', 'Vertex outline', 'canvas-controls'),
  canvas('handleGuide', 'Handle guide line', 'canvas-controls'),

  // Toolpath move kinds.
  canvas('toolpathCut', 'Cut move', 'canvas-toolpath'),
  canvas('toolpathRapid', 'Rapid move', 'canvas-toolpath'),
  canvas('toolpathPlunge', 'Plunge move', 'canvas-toolpath'),
  canvas('toolpathCollision', 'Collision warning', 'canvas-toolpath'),
  canvas('toolpathDirection', 'Direction marker', 'canvas-toolpath'),

  // Dimensions, origin, clamps, tabs, snapping, validation.
  canvas('dimensionLine', 'Dimension line', 'canvas-annotation'),
  canvas('dimensionText', 'Dimension text', 'canvas-annotation'),
  canvas('dimensionDriven', 'Driven dimension', 'canvas-annotation'),
  canvas('dimensionWarning', 'Dimension warning', 'canvas-annotation'),
  canvas('dimensionHighlight', 'Dimension highlight', 'canvas-annotation'),
  canvas('originAxisX', 'Origin X axis', 'canvas-annotation'),
  canvas('originAxisY', 'Origin Y axis', 'canvas-annotation'),
  canvas('originCenter', 'Origin centre', 'canvas-annotation'),
  canvas('clampFill', 'Clamp fill', 'canvas-annotation'),
  canvas('clampStroke', 'Clamp outline', 'canvas-annotation'),
  canvas('clampSelectedFill', 'Clamp fill (selected)', 'canvas-annotation'),
  canvas('clampSelectedStroke', 'Clamp outline (selected)', 'canvas-annotation'),
  canvas('clampCollidingFill', 'Clamp fill (colliding)', 'canvas-annotation'),
  canvas('clampCollidingStroke', 'Clamp outline (colliding)', 'canvas-annotation'),
  canvas('clampCollidingSelectedFill', 'Clamp fill (colliding, selected)', 'canvas-annotation'),
  canvas('clampCollidingSelectedStroke', 'Clamp outline (colliding, selected)', 'canvas-annotation'),
  canvas('tabFill', 'Tab fill', 'canvas-annotation'),
  canvas('tabStroke', 'Tab outline', 'canvas-annotation'),
  canvas('tabSelectedFill', 'Tab fill (selected)', 'canvas-annotation'),
  canvas('tabSelectedStroke', 'Tab outline (selected)', 'canvas-annotation'),
  canvas('snapPerpendicular', 'Perpendicular snap guide', 'canvas-annotation'),
  canvas('editAddFill', 'Add-point preview fill', 'canvas-annotation'),
  canvas('editAddStroke', 'Add-point preview outline', 'canvas-annotation'),
  canvas('editDeleteFill', 'Delete preview fill', 'canvas-annotation'),
  canvas('editDeleteStroke', 'Delete preview outline', 'canvas-annotation'),
  canvas('editDisconnectFill', 'Disconnect preview fill', 'canvas-annotation'),
  canvas('editDisconnectStroke', 'Disconnect preview outline', 'canvas-annotation'),
  canvas('measurementBackdrop', 'Measurement label background', 'canvas-annotation'),
  canvas('measurementText', 'Measurement label text', 'canvas-annotation'),
  canvas('stockExceeded', 'Stock exceeded warning', 'canvas-annotation'),
  canvas('invalidText', 'Invalid value text', 'canvas-annotation'),
  canvas('invalidBackdrop', 'Invalid value background', 'canvas-annotation'),
  canvas('constraint', 'Constraint overlay', 'canvas-annotation'),
  canvas('constraintHighlight', 'Constraint highlight', 'canvas-annotation'),
  canvas('constraintInvalid', 'Constraint invalid', 'canvas-annotation'),
  canvas('markerHalo', 'Marker halo', 'canvas-annotation'),
  canvas('markerOutline', 'Marker outline', 'canvas-annotation'),

  // Three.js viewport / simulation presentation.
  three('background', '3D background'),
  three('gridMinorCenter', '3D grid minor (center)'),
  three('gridMinor', '3D grid minor'),
  three('gridMajorCenter', '3D grid major (center)'),
  three('gridMajor', '3D grid major'),
  three('toolpathCut', '3D cut move'),
  three('toolpathRapid', '3D rapid move'),
  three('toolpathPlunge', '3D plunge move'),
  three('stockDefault', '3D default stock'),
  three('stockMeshFallback', '3D stock mesh fallback'),
  three('stockWireframeFallback', '3D stock wireframe fallback'),
  three('meshFeatureDefault', '3D feature mesh default'),
  three('meshFeatureSelected', '3D feature mesh selected'),
  three('meshFeatureHovered', '3D feature mesh hovered'),
  three('meshFeatureRegion', '3D feature mesh region'),
  three('meshFeatureSubtract', '3D feature mesh subtract'),
  three('meshFeatureAdd', '3D feature mesh add'),
  three('clampDefault', '3D clamp default'),
  three('clampSelected', '3D clamp selected'),
  three('clampColliding', '3D clamp colliding'),
  three('clampCollidingSelected', '3D clamp colliding+selected'),
  three('tabDefault', '3D tab default'),
  three('tabSelected', '3D tab selected'),
  three('originAxisX', '3D origin X axis'),
  three('originAxisY', '3D origin Y axis'),
  three('originAxisZ', '3D origin Z axis'),
  three('originCenter', '3D origin center'),
  three('toolCutter', '3D tool cutter'),
  three('toolCutterEmissive', '3D tool cutter emissive'),
  three('toolShank', '3D tool shank'),
  three('lineDefault', '3D line overlay default'),
  three('lineSubtract', '3D line overlay subtract'),
] as const

export type ThemeTokenKey = (typeof THEME_TOKENS)[number]['key']

const TOKEN_BY_KEY = new Map<string, ThemeTokenMeta>(THEME_TOKENS.map((token) => [token.key, token]))

export function isThemeTokenKey(key: string): key is ThemeTokenKey {
  return TOKEN_BY_KEY.has(key)
}

export function themeTokenMeta(key: ThemeTokenKey): ThemeTokenMeta {
  const meta = TOKEN_BY_KEY.get(key)
  if (!meta) throw new Error(`Unknown theme token: ${key}`)
  return meta
}

/** All token keys of one kind, in declaration order. */
export function themeTokenKeys(kind?: ThemeTokenKind): ThemeTokenKey[] {
  return THEME_TOKENS.filter((token) => (kind ? token.kind === kind : true)).map((token) => token.key)
}

/** The CSS custom property name for a `css`-kind token key. */
export function cssVariableName(key: ThemeTokenKey): string {
  return `--${key}`
}
