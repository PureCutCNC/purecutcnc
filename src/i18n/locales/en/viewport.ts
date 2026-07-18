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
 * Viewport namespace: 3D + simulation viewport controls, about dialog,
 * onboarding empty state, error screens, and the pre-React fatal-error HTML.
 *
 * Keys are permanent identifiers: renaming one orphans it in every custom
 * language pack, so treat renames as breaking and only do them deliberately.
 */
export const viewportEn = {
  'viewport.presets.top': 'Top view',
  'viewport.presets.bottom': 'Bottom view',
  'viewport.presets.front': 'Front view',
  'viewport.presets.back': 'Back view',
  'viewport.presets.right': 'Right view',
  'viewport.presets.left': 'Left view',
  'viewport.presets.iso': 'Isometric view',

  'viewport.sim.modeLabel': 'Simulation mode',
  'viewport.sim.modeSelected': 'Selected',
  'viewport.sim.modeVisible': 'Visible',
  'viewport.sim.detailLabel': 'Detail',
  'viewport.sim.detailTitle': 'Simulation detail',
  'viewport.sim.playTool': 'Play Tool',
  'viewport.sim.playToolDisabledMode': 'Switch to Selected mode to use Tool playback',
  'viewport.sim.playToolDisabledNoOp': 'Select an operation with a valid toolpath to play',
  'viewport.sim.playToolToggle': 'Toggle tool playback',
  'viewport.sim.webglUnavailableTitle': "3D simulation isn't available",
  'viewport.sim.webglUnavailableBody': 'This view requires WebGL2, which your browser or graphics driver did not provide. Try updating your browser or enabling hardware acceleration in its settings.',
  'viewport.sim.webglLostTitle': '3D graphics context lost',
  'viewport.sim.webglLostBody': 'Waiting for the browser to restore it — playback has been paused. If this message persists, reload the app.',
  'viewport.sim.play': 'Play',
  'viewport.sim.pause': 'Pause',
  'viewport.sim.stop': 'Stop & reset',
  'viewport.sim.progressAria': 'Playback progress',
  'viewport.sim.speedLabel': 'Speed',
  'viewport.sim.speedTooltipFeed': 'Speed multiplier of operation feed ({feed} = 1×). Current: {multiplier}',
  'viewport.sim.speedTooltipFallback': 'Speed multiplier of fallback feed ({feed} = 1×). Current: {multiplier}',
  'viewport.sim.speedAria': 'Playback speed multiplier',
  'viewport.sim.stepLabel': 'Step',
  'viewport.sim.stepTooltip': 'Maximum distance the tool advances per frame. Smaller = smoother motion, larger = faster playback.',
  'viewport.sim.feedTooltip': "Cutting feed of the current move. Reduced slotting pocket cuts show their scaled feed here; the dot colour marks the move kind (rapids have no feed).",
  'viewport.sim.moveKindIdle': 'Idle',

  'viewport.about.ariaLabel': 'About PureCutCNC',
  'viewport.about.title': 'About',
  'viewport.about.close': 'Close',
  'viewport.about.version': 'Version {version}',
  'viewport.about.tagline': '2.5D CAD/CAM for CNC hobbyists — sketching and machining in one workflow, on the web or your desktop.',
  'viewport.about.releaseLabel': 'Release',
  'viewport.about.releasedLabel': 'Released',
  'viewport.about.website': 'Website',
  'viewport.about.source': 'Source',
  'viewport.about.releases': 'Releases',
  'viewport.about.license': 'License (Apache-2.0)',
  'viewport.about.supportText': 'PureCutCNC is free, and stays free — but building and maintaining it takes real time and money. If it helps you, a coffee keeps it going.',
  'viewport.about.buyCoffee': 'Buy me a coffee',

  'viewport.empty.title': 'Start your part',
  'viewport.empty.subtitle': 'Draw a shape, import a file, or open a finished example to see the full workflow.',
  'viewport.empty.drawTitle': 'Draw a shape',
  'viewport.empty.drawMeta': 'Sketch a rectangle on the canvas',
  'viewport.empty.importTitle': 'Import a file',
  'viewport.empty.importMeta': 'SVG, DXF, OBJ, STL, or CAMJ files',
  'viewport.empty.examplesLabel': 'Open an example…',

  'viewport.error.eyebrow': 'Something went wrong',
  'viewport.error.title': "Sorry — PureCutCNC couldn't start on this device.",
  'viewport.error.body': "This usually means your browser or operating system doesn't support the 3D graphics features the app needs. Try a current version of Chrome, Edge, or Firefox on a reasonably recent desktop or tablet, or use one of our desktop builds.",
  'viewport.error.showDetails': 'Show technical details',
  'viewport.error.reload': 'Reload',
  'viewport.error.desktopDownloads': 'Desktop Downloads',
  'viewport.error.projectWebsite': 'Project Website',

  'viewport.error.userAgent': 'User agent:',
  'viewport.error.timestamp': 'Timestamp:',
} as const satisfies Record<string, string>
