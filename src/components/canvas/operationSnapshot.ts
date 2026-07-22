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

import { getFeatureGeometryProfiles } from '../../text'
import { getProfileBounds, rectProfile } from '../../types/project'
import type { Operation, Project, SketchProfile } from '../../types/project'
import type { ToolpathResult } from '../../engine/toolpaths'
import type { ToolpathVisibility } from '../toolpathVisibility'
import { drawToolpath } from './previewPrimitives'
import { traceProfilePath } from './profilePrimitives'
import { drawClampFootprint, drawTabFootprint } from './scenePrimitives'
import { computeFitViewStateForBounds, computeViewTransform } from './viewTransform'
import { worldToCanvas } from './viewTransform'
import type { ViewTransform } from './viewTransform'
import { resolvedProjectFeatures } from '../../store/helpers/resolveFeatures'
import { printPalette } from '../../engine/designPrint/printPalette'

interface Bounds2D {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface OperationSnapshotOptions {
  width?: number
  height?: number
  pixelRatio?: number
}

const DEFAULT_WIDTH = 1200
const DEFAULT_HEIGHT = 760
const MAX_PIXEL_RATIO = 2

const SNAPSHOT_TOOLPATH_VISIBILITY: ToolpathVisibility = {
  cuts: true,
  rapids: true,
  plunges: true,
  retractions: true,
  directions: true,
}

function includeProfileBounds(bounds: Bounds2D, profile: SketchProfile): Bounds2D {
  const profileBounds = getProfileBounds(profile)
  return {
    minX: Math.min(bounds.minX, profileBounds.minX),
    minY: Math.min(bounds.minY, profileBounds.minY),
    maxX: Math.max(bounds.maxX, profileBounds.maxX),
    maxY: Math.max(bounds.maxY, profileBounds.maxY),
  }
}

function includeToolpathBounds(bounds: Bounds2D, toolpath: ToolpathResult | null): Bounds2D {
  if (!toolpath?.bounds) {
    return bounds
  }

  return {
    minX: Math.min(bounds.minX, toolpath.bounds.minX),
    minY: Math.min(bounds.minY, toolpath.bounds.minY),
    maxX: Math.max(bounds.maxX, toolpath.bounds.maxX),
    maxY: Math.max(bounds.maxY, toolpath.bounds.maxY),
  }
}

function includePointBounds(bounds: Bounds2D, point: { x: number; y: number }): Bounds2D {
  return {
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y),
  }
}

function operationTargetIds(operation: Operation): Set<string> {
  return operation.target.source === 'features'
    ? new Set(operation.target.featureIds)
    : new Set<string>()
}

function snapshotBounds(project: Project, operation: Operation, toolpath: ToolpathResult | null): Bounds2D {
  let bounds = includeProfileBounds({
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  }, project.stock.profile)

  const targetIds = operationTargetIds(operation)
  for (const feature of resolvedProjectFeatures(project)) {
    if (!feature.visible && !targetIds.has(feature.id)) {
      continue
    }
    for (const profile of getFeatureGeometryProfiles(feature)) {
      bounds = includeProfileBounds(bounds, profile)
    }
  }

  for (const tab of project.tabs) {
    if (tab.visible) {
      bounds = includeProfileBounds(bounds, rectProfile(tab.x, tab.y, tab.w, tab.h))
    }
  }

  for (const clamp of project.clamps) {
    if (clamp.visible) {
      bounds = includeProfileBounds(bounds, rectProfile(clamp.x, clamp.y, clamp.w, clamp.h))
    }
  }

  bounds = includePointBounds(bounds, project.origin)

  return includeToolpathBounds(bounds, toolpath)
}

function drawProfile(
  ctx: CanvasRenderingContext2D,
  profile: SketchProfile,
  vt: ViewTransform,
  style: { fill: string; stroke: string; lineWidth: number; dash?: number[] },
): void {
  traceProfilePath(ctx, profile, vt)
  ctx.fillStyle = style.fill
  ctx.fill()
  ctx.strokeStyle = style.stroke
  ctx.lineWidth = style.lineWidth
  ctx.setLineDash(style.dash ?? [])
  ctx.stroke()
  ctx.setLineDash([])
}

function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) {
        reject(new Error('Failed to render operation booklet snapshot.'))
        return
      }
      resolve(new Uint8Array(await blob.arrayBuffer()))
    }, 'image/png')
  })
}

function drawSnapshotOrigin(
  ctx: CanvasRenderingContext2D,
  project: Project,
  vt: ViewTransform,
  pixelRatio: number,
): void {
  const anchor = worldToCanvas(project.origin, vt)
  const arm = 22 * pixelRatio
  const radius = 5 * pixelRatio

  ctx.save()
  ctx.lineCap = 'round'

  ctx.beginPath()
  ctx.moveTo(anchor.cx - arm, anchor.cy)
  ctx.lineTo(anchor.cx + arm, anchor.cy)
  ctx.moveTo(anchor.cx, anchor.cy - arm)
  ctx.lineTo(anchor.cx, anchor.cy + arm)
  ctx.strokeStyle = printPalette.snapshot.originCrosshairHalo
  ctx.lineWidth = 9 * pixelRatio
  ctx.stroke()

  ctx.beginPath()
  ctx.moveTo(anchor.cx - arm, anchor.cy)
  ctx.lineTo(anchor.cx + arm, anchor.cy)
  ctx.moveTo(anchor.cx, anchor.cy - arm)
  ctx.lineTo(anchor.cx, anchor.cy + arm)
  ctx.strokeStyle = printPalette.snapshot.originCrosshairStroke
  ctx.lineWidth = 5 * pixelRatio
  ctx.stroke()

  ctx.beginPath()
  ctx.arc(anchor.cx, anchor.cy, radius, 0, Math.PI * 2)
  ctx.fillStyle = printPalette.snapshot.originDotFill
  ctx.fill()
  ctx.strokeStyle = printPalette.snapshot.originDotBorder
  ctx.lineWidth = 2 * pixelRatio
  ctx.stroke()

  ctx.restore()
}

export async function renderOperationSnapshotPng(
  project: Project,
  operation: Operation,
  toolpath: ToolpathResult | null,
  options: OperationSnapshotOptions = {},
): Promise<Uint8Array> {
  const pixelRatio = Math.max(1, Math.min(options.pixelRatio ?? window.devicePixelRatio ?? 1, MAX_PIXEL_RATIO))
  const canvasW = Math.round((options.width ?? DEFAULT_WIDTH) * pixelRatio)
  const canvasH = Math.round((options.height ?? DEFAULT_HEIGHT) * pixelRatio)
  const canvas = document.createElement('canvas')
  canvas.width = canvasW
  canvas.height = canvasH

  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('Failed to create operation booklet snapshot canvas.')
  }

  ctx.fillStyle = printPalette.snapshot.sheetBackground
  ctx.fillRect(0, 0, canvasW, canvasH)

  const viewState = computeFitViewStateForBounds(project.stock, snapshotBounds(project, operation, toolpath), canvasW, canvasH)
  const vt = computeViewTransform(project.stock, canvasW, canvasH, viewState)
  const targetIds = operationTargetIds(operation)

  drawProfile(ctx, project.stock.profile, vt, {
    fill: printPalette.snapshot.stockFill,
    stroke: printPalette.snapshot.stockOutline,
    lineWidth: 2 * pixelRatio,
  })

  for (const feature of resolvedProjectFeatures(project)) {
    const isTarget = targetIds.has(feature.id) || operation.target.source === 'stock'
    const profiles = getFeatureGeometryProfiles(feature)
    for (const profile of profiles) {
      drawProfile(ctx, profile, vt, isTarget
        ? {
            fill: printPalette.snapshot.targetFeatureFill,
            stroke: printPalette.snapshot.targetFeatureStroke,
            lineWidth: 2.4 * pixelRatio,
          }
        : {
            fill: printPalette.snapshot.nonTargetFeatureFill,
            stroke: printPalette.snapshot.nonTargetFeatureStroke,
            lineWidth: 1.2 * pixelRatio,
            dash: [7 * pixelRatio, 5 * pixelRatio],
          })
    }
  }

  for (const tab of project.tabs) {
    if (tab.visible) {
      drawTabFootprint(ctx, tab, vt, false)
    }
  }

  for (const clamp of project.clamps) {
    if (clamp.visible) {
      drawClampFootprint(ctx, clamp, vt, false, false)
    }
  }

  if (toolpath) {
    drawToolpath(ctx, toolpath, vt, true, SNAPSHOT_TOOLPATH_VISIBILITY)
  }

  drawSnapshotOrigin(ctx, project, vt, pixelRatio)

  ctx.fillStyle = printPalette.snapshot.labelText
  ctx.font = `${Math.round(14 * pixelRatio)}px "IBM Plex Mono", "SFMono-Regular", Consolas, monospace`
  ctx.fillText(operation.name, 22 * pixelRatio, 30 * pixelRatio)

  return canvasToPngBytes(canvas)
}
