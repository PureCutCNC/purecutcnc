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

import type { Page } from '@playwright/test'
import { seedProject } from './helpers'

/**
 * A complete, valid machine definition for machine-library smokes. Callers
 * override `id`/`name` (and anything else) to stand in for a stale project
 * copy of a bundled machine or a legacy project-local custom machine.
 */
export function e2eMachineDefinition(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'e2e-machine',
    name: 'E2E Machine',
    description: 'Fixture controller',
    builtin: false,
    fileExtension: 'nc',
    coordinateSystem: { xAxis: 'X', yAxis: 'Y', zAxis: 'Z' },
    numberFormat: { decimalPlaces: { mm: 3, inch: 4 }, trailingZeros: false, leadingZero: true },
    units: { mmCommand: 'G21', inchCommand: 'G20' },
    program: {
      header: ['G90'],
      operationHeader: [],
      footer: ['M30'],
      commentPrefix: '(',
      commentSuffix: ')',
      lineNumbers: false,
      lineNumberIncrement: 1,
    },
    workCoordinates: { selectCommand: 'G54' },
    motion: {
      rapidCommand: 'G00',
      linearCommand: 'G01',
      cwArcCommand: 'G02',
      ccwArcCommand: 'G03',
      arcFormat: 'ij',
      modalMotion: true,
      arcInterpolation: false,
    },
    feedSpeed: {
      feedCommand: 'F',
      rpmCommand: 'S',
      spindleOnCW: 'M03',
      spindleOnCCW: 'M04',
      spindleOff: 'M05',
      inlineWithMotion: false,
      modalFeedSpeed: true,
    },
    toolChange: {
      commands: ['T[TOOL]', 'M06'],
      stopSpindleFirst: true,
      pauseAfterChange: false,
      pauseCommand: 'M00',
    },
    cannedCycles: null,
    coolant: { floodOnCommand: 'M8', mistOnCommand: 'M7', coolantOffCommand: 'M9' },
    stop: { programEndCommand: 'M30' },
    ...overrides,
  }
}

function rectProfile(x: number, y: number, w: number, h: number) {
  return {
    start: { x, y },
    segments: [
      { type: 'line' as const, to: { x: x + w, y } },
      { type: 'line' as const, to: { x: x + w, y: y + h } },
      { type: 'line' as const, to: { x, y: y + h } },
      { type: 'line' as const, to: { x, y } },
    ],
    closed: true,
  }
}

export interface MachineProjectOptions {
  name?: string
  machineDefinitions?: Record<string, unknown>[]
  selectedMachineId?: string | null
}

/** A minimal, geometry-free 3.0 project with a configurable machine section. */
export function buildMachineProjectJson(options: MachineProjectOptions = {}): string {
  const now = '2026-01-01T00:00:00.000Z'
  return JSON.stringify({
    version: '3.0',
    meta: {
      name: options.name ?? 'Machine Library E2E Fixture',
      created: now,
      modified: now,
      units: 'mm',
      showFeatureInfo: true,
      showDimensions: true,
      copyMode: 'reference',
      maxTravelZ: 50,
      operationClearanceZ: 5,
      clampClearanceXY: 10,
      clampClearanceZ: 5,
      machineDefinitions: options.machineDefinitions ?? [],
      selectedMachineId: options.selectedMachineId ?? null,
    },
    grid: {
      extent: 200,
      majorSpacing: 20,
      minorSpacing: 5,
      snapEnabled: false,
      snapIncrement: 1,
      visible: true,
    },
    stock: {
      profile: rectProfile(0, 0, 180, 120),
      thickness: 12,
      material: 'mdf',
      color: '#cccccc',
      visible: true,
      origin: { x: 0, y: 0 },
      sourceFeature: null,
    },
    origin: { name: 'Origin', x: 0, y: 0, z: 12, visible: true },
    backdrop: null,
    dimensions: {},
    annotations: [],
    modelAssets: {},
    featureDefinitions: {},
    features: [],
    featureFolders: [],
    featureTree: [],
    global_constraints: [],
    tools: [],
    operations: [],
    tabs: [],
    clamps: [],
    ai_history: [],
  })
}

export async function seedMachineProject(page: Page, options: MachineProjectOptions = {}): Promise<void> {
  await seedProject(page, buildMachineProjectJson(options))
}

/** The project's embedded machine snapshot, straight from the live store. */
export async function embeddedMachine(page: Page): Promise<{
  definitions: Record<string, unknown>[]
  selectedMachineId: string | null
}> {
  return page.evaluate(async () => {
    const w = window as unknown as {
      __pcTest: { getProject: () => Promise<Record<string, unknown>> }
    }
    const project = await w.__pcTest.getProject()
    const meta = project.meta as Record<string, unknown>
    return {
      definitions: meta.machineDefinitions as Record<string, unknown>[],
      selectedMachineId: (meta.selectedMachineId as string | null) ?? null,
    }
  })
}
