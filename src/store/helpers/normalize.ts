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

import { clearImportedModelCaches } from '../../engine/importedMesh'
import { clearSTLTransformedGeometryCache } from '../../engine/csg'
import { machineExportDiagnostics, MachineDefinitionStructureSchema } from '../../engine/gcode/types'
import type { MachineDefinition } from '../../engine/gcode/types'
import { allocateMachineId, getBundledMachine, isBundledMachineId, machinesFunctionallyEqual } from '../../machine/registry'
import { MachineLoadError, type MachineLoadDiagnostic } from '../../machine/diagnostics'
import { convertLength } from '../../utils/units'
import { defaultTool, inferFeatureKind, newProject, profileVertices, tabShape } from '../../types/project'
import { isBarStock } from '../../types/barStock'
import type {
  Clamp,
  FeatureDefinition,
  FeatureInstance,
  FeatureOperation,
  Operation,
  Point,
  Project,
  RegionMaskMode,
  SketchFeature,
  Tab,
  Tool,
} from '../../types/project'
import { normalizePlasmaTool, withCompatibleOperationTool } from '../../toolPolicy'
import { normalizeTextFontId } from '../../text'
import { idNumericSuffix } from './ids'
import { isSolid } from './featureRoles'
import { barSeedsModel } from './projectType'
import { isImportedModelFeature } from './modelAssets'
import { fallbackOperationTarget, defaultOperationForTarget, isOperationTargetValid } from './operationDefaults'
import { resolveFeatureRow } from './resolveFeatures'
import { newChuck } from './stockShape'

export function normalizeAngleDegrees(angle: number): number {
  const normalized = angle % 360
  return normalized < 0 ? normalized + 360 : normalized
}

export function angleToPoint(angleDegrees: number): Point {
  const radians = (angleDegrees * Math.PI) / 180
  return {
    x: Math.cos(radians),
    y: Math.sin(radians),
  }
}

export function inferProfileOrientationAngle(profile: SketchFeature['sketch']['profile']): number {
  const vertices = profileVertices(profile)
  let bestDirection: Point | null = null
  let bestLength = 0

  for (let index = 0; index < vertices.length; index += 1) {
    const start = vertices[index]
    const end = vertices[(index + 1) % vertices.length]
    const dx = end.x - start.x
    const dy = end.y - start.y
    const length = Math.hypot(dx, dy)
    if (length > bestLength) {
      bestLength = length
      bestDirection = { x: dx / length, y: dy / length }
    }
  }

  if (!bestDirection) {
    return 90
  }

  const xAxisAngle = Math.atan2(bestDirection.y, bestDirection.x) * (180 / Math.PI)
  return normalizeAngleDegrees(xAxisAngle + 90)
}

export function normalizeRegionMaskMode(
  operation: FeatureOperation,
  mode?: RegionMaskMode,
): RegionMaskMode | undefined {
  if (operation !== 'region') {
    return undefined
  }
  return mode === 'exclude' ? 'exclude' : 'include'
}

export function normalizeFeatureZRange(feature: SketchFeature): SketchFeature {
  const safeFeature = {
    ...feature,
    text: feature.kind === 'text' && feature.text
      ? {
        ...feature.text,
        text: feature.text.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\s*\n+\s*/g, ' ').trim() || 'TEXT',
        fontId: normalizeTextFontId(feature.text.fontId, feature.text.style),
      }
      : null,
    sketch: {
      ...feature.sketch,
      orientationAngle: normalizeAngleDegrees(
        feature.sketch.orientationAngle ?? inferProfileOrientationAngle(feature.sketch.profile),
      ),
      profile: {
        ...feature.sketch.profile,
        closed: feature.sketch.profile.closed ?? true,
      },
    },
    kind: feature.kind ?? inferFeatureKind(feature.sketch.profile),
    folderId: feature.folderId ?? null,
    regionMaskMode: normalizeRegionMaskMode(feature.operation, feature.regionMaskMode),
  }
  const { z_top, z_bottom } = safeFeature
  if (typeof z_top === 'number' && typeof z_bottom === 'number' && z_top < z_bottom) {
    return {
      ...safeFeature,
      z_top: z_bottom,
      z_bottom: z_top,
    }
  }

  return safeFeature
}

export function normalizeFeatureDefinition(definition: FeatureDefinition): FeatureDefinition {
  return {
    ...definition,
    regionMaskMode: normalizeRegionMaskMode(definition.operation, definition.regionMaskMode),
  }
}

export function normalizeTool(tool: Tool, units: Project['meta']['units'], index: number): Tool {
  if (tool.type === 'plasma') return normalizePlasmaTool({ ...tool, units: tool.units ?? units })
  const defaults = defaultTool(units, index + 1)
  return {
    ...defaults,
    ...tool,
    vBitAngle: (tool.type ?? defaults.type) === 'v_bit' ? (tool.vBitAngle ?? 60) : null,
  }
}

export function dedupeProjectIds(project: Project): Project {
  let localCounter = [
    ...project.features.map((feature) => idNumericSuffix(feature.id)),
    ...project.tools.map((tool) => idNumericSuffix(tool.id)),
    ...project.operations.map((operation) => idNumericSuffix(operation.id)),
    ...project.tabs.map((tab) => idNumericSuffix(tab.id)),
    ...project.clamps.map((clamp) => idNumericSuffix(clamp.id)),
  ].reduce((max, value) => Math.max(max, value), 0) + 1

  const nextLocalId = (prefix: string) => `${prefix}${String(localCounter++).padStart(4, '0')}`

  const seenFeatureIds = new Set<string>()
  const features = project.features.map((feature) => {
    if (!seenFeatureIds.has(feature.id)) {
      seenFeatureIds.add(feature.id)
      return feature
    }

    const nextId = nextLocalId('f')
    return {
      ...feature,
      id: nextId,
    }
  })

  const seenToolIds = new Set<string>()
  const tools = project.tools.map((tool) => {
    if (!seenToolIds.has(tool.id)) {
      seenToolIds.add(tool.id)
      return tool
    }

    const nextId = nextLocalId('t')
    return {
      ...tool,
      id: nextId,
    }
  })

  const seenOperationIds = new Set<string>()
  const operations = project.operations.map((operation) => {
    if (!seenOperationIds.has(operation.id)) {
      seenOperationIds.add(operation.id)
      return {
        ...operation,
      }
    }

    const nextId = nextLocalId('op')
    return {
      ...operation,
      id: nextId,
    }
  })

  const seenClampIds = new Set<string>()
  const clamps = project.clamps.map((clamp) => {
    if (!seenClampIds.has(clamp.id)) {
      seenClampIds.add(clamp.id)
      return { ...clamp }
    }

    const nextId = nextLocalId('cl')
    return {
      ...clamp,
      id: nextId,
    }
  })

  const seenTabIds = new Set<string>()
  const tabs = project.tabs.map((tab) => {
    if (!seenTabIds.has(tab.id)) {
      seenTabIds.add(tab.id)
      return { ...tab }
    }

    const nextId = nextLocalId('tb')
    return {
      ...tab,
      id: nextId,
    }
  })

  return {
    ...project,
    features,
    tools,
    operations,
    tabs,
    clamps,
  }
}

export function normalizeOperation(rawOperation: Operation, project: Project, index: number): Operation {
  // Migrate the retired recursive skeleton op to the medial-axis op (issue
  // #279). Legacy parameters stay serialized for compatibility; the current
  // medial generator derives resolution from geometry and ignores `stepover`.
  const operation: Operation = (rawOperation.kind as string) === 'v_carve_recursive'
    ? { ...rawOperation, kind: 'v_carve_medial' }
    : rawOperation
  const fallbackTarget = fallbackOperationTarget(project, operation.kind)
  const defaults = defaultOperationForTarget(project, operation.kind, 'rough', fallbackTarget, index)
  const normalized = {
    ...defaults,
    ...withCompatibleOperationTool(project, operation),
    ...(operation.kind === 'plasma_profile' ? {
      plasmaSide: operation.plasmaSide ?? 'auto' as const,
      plasmaReverseDirection: operation.plasmaReverseDirection ?? false,
      plasmaLeadIn: operation.plasmaLeadIn ?? 'arc' as const,
      plasmaLeadOut: operation.plasmaLeadOut ?? 'line' as const,
    } : {}),
    description: operation.description ?? '',
    roundOutsideCorners: operation.roundOutsideCorners ?? true,
    roundLinkCorners: operation.roundLinkCorners ?? true,
    cornerRelief: operation.cornerRelief ?? 'none',
    machiningOrder: operation.machiningOrder ?? 'level_first',
    finishScallopHeight: operation.finishScallopHeight ?? 0,
    waterlineAdaptiveRefinement: operation.waterlineAdaptiveRefinement ?? true,
    waterlineMicroStepover: operation.waterlineMicroStepover ?? 0,
    waterlineRefinementThreshold: operation.waterlineRefinementThreshold ?? 0,
    waterlineMaxRingsPerBand: operation.waterlineMaxRingsPerBand ?? 0,
    waterlineTipStepdown: operation.waterlineTipStepdown ?? 0,
    arcFittingEnabled: operation.arcFittingEnabled ?? true,
    edgeStrategy: (operation.kind === 'edge_route_inside' || operation.kind === 'edge_route_outside')
      ? operation.edgeStrategy ?? 'contour'
      : operation.edgeStrategy,
    carveStrategy: operation.kind === 'follow_line'
      ? operation.carveStrategy ?? 'direct'
      : operation.carveStrategy,
    // XY leads (issue #695) are deliberately NOT backfilled: absent means the
    // legacy direct entry, and a saved clearing operation must keep the motion
    // it was saved with. The field is only kept where a generator reads it, so
    // a hand-edited or kind-switched operation cannot carry a stale request
    // into an operation that has no lead seam to honour it.
    xyLeadStrategy: operation.xyLeadStrategy === 'arc'
      && (operation.kind === 'pocket'
        || operation.kind === 'surface_clean'
        || operation.kind === 'rough_surface'
        || operation.kind === 'edge_route_inside'
        || operation.kind === 'edge_route_outside')
      ? ('arc' as const)
      : undefined,
  }

  // Never silently retarget a plasma cut when saved geometry becomes open or missing.
  if (normalized.kind === 'plasma_profile') return normalized

  if (!isOperationTargetValid(project, normalized.kind, normalized.target)) {
    return {
      ...normalized,
      target: fallbackTarget,
    }
  }

  return normalized
}

export function normalizeClamp(clamp: Clamp, units: Project['meta']['units'], index: number): Clamp {
  const defaultSize = convertLength(12, 'mm', units)
  const defaultHeight = convertLength(8, 'mm', units)
  return {
    id: clamp.id || `cl${index + 1}`,
    name: clamp.name || `Clamp ${index + 1}`,
    type: clamp.type ?? 'step_clamp',
    x: clamp.x ?? 0,
    y: clamp.y ?? 0,
    w: Math.max(clamp.w ?? defaultSize, convertLength(0.1, 'mm', units)),
    h: Math.max(clamp.h ?? defaultSize, convertLength(0.1, 'mm', units)),
    height: Math.max(clamp.height ?? defaultHeight, convertLength(0.1, 'mm', units)),
    visible: clamp.visible ?? true,
  }
}

export function normalizeTab(tab: Tab, units: Project['meta']['units'], index: number): Tab {
  const defaultSize = convertLength(6, 'mm', units)
  const defaultBottom = 0
  const defaultTop = convertLength(3, 'mm', units)
  const zBottom = tab.z_bottom ?? defaultBottom
  const zTop = tab.z_top ?? defaultTop
  return {
    id: tab.id || `tb${index + 1}`,
    name: tab.name || `Tab ${index + 1}`,
    x: tab.x ?? 0,
    y: tab.y ?? 0,
    w: Math.max(tab.w ?? defaultSize, convertLength(0.1, 'mm', units)),
    h: Math.max(tab.h ?? defaultSize, convertLength(0.1, 'mm', units)),
    z_top: Math.max(zTop, zBottom),
    z_bottom: Math.min(zTop, zBottom),
    visible: tab.visible ?? true,
    shape: tabShape(tab),
  }
}

export interface MachineSnapshotNormalization {
  /** The project's embedded snapshot: zero or one definition, never a library. */
  machineDefinitions: MachineDefinition[]
  selectedMachineId: string | null
  /**
   * Non-bundled definitions the stored file carried, selected one first.
   * Decode hands these to the application library so a legacy project's custom
   * machines survive the compaction. A template-invalid definition is included
   * unchanged — the library stores it and export refuses it until it is fixed
   * (#1119).
   */
  customDefinitions: MachineDefinition[]
  /** True when the stored file carried more machines than the snapshot keeps. */
  compacted: boolean
  /** A machine ID the file selected but could not resolve to a definition. */
  unresolvedSelectionId: string | null
  /**
   * What rescue, consolidation and re-keying did, plus a retained
   * template-invalid machine. The load warning and the machine manager read
   * this instead of information being discarded here (#1119).
   */
  diagnostics: MachineLoadDiagnostic[]
}

/** A structural failure that must refuse the whole load, with its list index. */
function machineStructureError(index: number, issues: ReadonlyArray<{ path: PropertyKey[], message: string }>): MachineLoadError {
  const issue = issues[0]
  const path = issue?.path.map(String).join('.')
  const detail = issue ? (path ? `${path}: ${issue.message}` : issue.message) : 'the entry is not a machine definition'
  return new MachineLoadError([{
    severity: 'error',
    kind: 'machine-structural-error',
    index,
    message: `Machine ${index + 1} in this project could not be read (${detail}). The project was not opened; its original bytes are unchanged.`,
  }])
}

/** A retained machine whose templates still break a rule: export is blocked until corrected. */
function retainedInvalidDiagnostic(definition: MachineDefinition): MachineLoadDiagnostic | null {
  const templateDiagnostics = machineExportDiagnostics(definition)
  if (templateDiagnostics.length === 0) return null
  return {
    severity: 'warning',
    kind: 'machine-retained-invalid',
    machineId: definition.id,
    machineName: definition.name,
    templateDiagnostics,
    message: `The machine "${definition.name}" was kept and stays selected, but its templates break a machine-template rule (${templateDiagnostics.length === 1 ? 'one line' : `${templateDiagnostics.length} lines`}). G-code export is blocked until it is corrected.`,
  }
}

/**
 * Re-key a rescued definition away from a bundled id the build owns. A custom
 * id that reached this point is already unique: duplicates were consolidated or
 * re-keyed while the file was read.
 */
function asRescuedCustom(
  definition: MachineDefinition,
  usedIds: Set<string>,
): { definition: MachineDefinition, rekeyed: boolean } {
  if (!isBundledMachineId(definition.id)) {
    return { definition: { ...definition, builtin: false }, rekeyed: false }
  }
  const id = allocateMachineId(definition.name || definition.id, usedIds)
  return { definition: { ...definition, id, builtin: false }, rekeyed: true }
}

/**
 * Reduce a stored project's machine data to the single embedded snapshot the
 * current format keeps, and report what had to be rescued or dropped (#1119).
 *
 * The selected definition is preserved verbatim — including a template that
 * still breaks a #1057 rule — because it is authoritative for export. Every
 * *distinct* unselected definition is rescued into `customDefinitions` instead
 * of being compacted away: custom machines, and edited copies of bundled
 * machines. Colliding ids are re-keyed and the move is reported. An unmodified
 * bundled copy is not rescued because the build supplies it.
 *
 * A structurally unreadable entry, or a selected id carried by two different
 * definitions, refuses the load atomically: the caller never replaces the
 * project with one that lost a machine.
 */
export function normalizeMachineDefinitions(project: Project): MachineSnapshotNormalization {
  const legacyMeta = project.meta as Project['meta'] & {
    machineId?: string | null
    customMachineDefinition?: MachineDefinition | null
  }

  const rawDefinitions = Array.isArray(project.meta.machineDefinitions)
    ? project.meta.machineDefinitions
    : null

  const snapshotOf = (
    definition: MachineDefinition | null,
    rescued: MachineDefinition[],
    rawCount: number,
    unresolvedSelectionId: string | null,
    diagnostics: MachineLoadDiagnostic[],
  ): MachineSnapshotNormalization => {
    const selectedDiagnostic = definition ? retainedInvalidDiagnostic(definition) : null
    if (selectedDiagnostic) diagnostics.push(selectedDiagnostic)
    return {
      machineDefinitions: definition ? [definition] : [],
      selectedMachineId: definition?.id ?? null,
      customDefinitions: rescued,
      compacted: rawCount > (definition ? 1 : 0),
      unresolvedSelectionId,
      diagnostics,
    }
  }

  // --- pre-3.0 shape: `machineId` plus an optional inline custom definition.
  if (!rawDefinitions) {
    if (legacyMeta.customMachineDefinition) {
      const parsed = MachineDefinitionStructureSchema.safeParse({
        ...legacyMeta.customMachineDefinition,
        builtin: false,
      })
      if (!parsed.success) {
        throw machineStructureError(0, parsed.error.issues)
      }
      const customDefinition = parsed.data
      // The inline definition is both the snapshot and a My Machines rescue:
      // it is the only copy of that machine the file carries.
      const rescued = asRescuedCustom(customDefinition, new Set([customDefinition.id]))
      return snapshotOf(customDefinition, [rescued.definition], 0, null, [])
    }
    const legacyId = legacyMeta.machineId ?? null
    const bundled = legacyId ? getBundledMachine(legacyId) ?? null : null
    const diagnostics: MachineLoadDiagnostic[] = []
    if (legacyId && !bundled) {
      diagnostics.push({
        severity: 'warning',
        kind: 'machine-selection-unresolved',
        machineId: legacyId,
        message: `This project selected a machine ("${legacyId}") that this build does not have, so no machine is selected.`,
      })
    }
    return snapshotOf(bundled, [], 0, legacyId && !bundled ? legacyId : null, diagnostics)
  }

  // Every entry must be structurally readable. A skipped entry is a machine
  // the project would silently lose, so the whole load is refused instead.
  const parsedDefinitions: Array<{ definition: MachineDefinition, index: number }> = []
  rawDefinitions.forEach((rawDefinition, index) => {
    const parsed = MachineDefinitionStructureSchema.safeParse(rawDefinition)
    if (!parsed.success) throw machineStructureError(index, parsed.error.issues)
    parsedDefinitions.push({ definition: parsed.data, index })
  })

  const selectedMachineId = project.meta.selectedMachineId ?? null
  const selectedCandidates = selectedMachineId
    ? parsedDefinitions.filter((entry) => entry.definition.id === selectedMachineId)
    : []
  // Two different definitions claiming the selected id make the selection
  // ambiguous: keeping either one would silently pick a machine for the user.
  const firstSelected = selectedCandidates[0]?.definition ?? null
  if (firstSelected) {
    const conflicting = selectedCandidates.find(
      (entry) => !machinesFunctionallyEqual(firstSelected, entry.definition),
    )
    if (conflicting) {
      throw new MachineLoadError([{
        severity: 'error',
        kind: 'machine-structural-error',
        index: conflicting.index,
        machineId: selectedMachineId ?? undefined,
        machineName: conflicting.definition.name,
        message: `This project's selected machine "${selectedMachineId}" is stored twice with different definitions, so it cannot be loaded without guessing. The project was not opened; its original bytes are unchanged.`,
      }])
    }
  }

  const diagnostics: MachineLoadDiagnostic[] = []
  // Identical duplicates are folded into one; the first occurrence wins.
  if (selectedCandidates.length > 1) {
    for (const duplicate of selectedCandidates.slice(1)) {
      diagnostics.push({
        severity: 'info',
        kind: 'machine-consolidated',
        index: duplicate.index,
        machineId: duplicate.definition.id,
        machineName: duplicate.definition.name,
        message: `Machine "${duplicate.definition.name}" appears more than once in this project; the duplicate was merged.`,
      })
    }
  }

  const selected = firstSelected
  const usedIds = new Set<string>()
  if (selected) usedIds.add(selected.id)
  const keptUnselected: Array<{ definition: MachineDefinition, index: number }> = []
  for (const entry of parsedDefinitions) {
    if (entry.definition === selected) continue
    // A second copy of the selected id was already proven identical above.
    if (selected && entry.definition.id === selected.id) continue
    if (usedIds.has(entry.definition.id)) {
      const existing = keptUnselected.find((candidate) => candidate.definition.id === entry.definition.id)
        ?? parsedDefinitions.find((candidate) => candidate.definition === selected)
      if (existing && machinesFunctionallyEqual(existing.definition, entry.definition)) {
        diagnostics.push({
          severity: 'info',
          kind: 'machine-consolidated',
          index: entry.index,
          machineId: entry.definition.id,
          machineName: entry.definition.name,
          message: `Machine "${entry.definition.name}" appears more than once in this project; the duplicate was merged.`,
        })
        continue
      }
      const id = allocateMachineId(entry.definition.name || entry.definition.id, usedIds)
      const rekeyed = { ...entry.definition, id }
      diagnostics.push({
        severity: 'warning',
        kind: 'machine-rekeyed',
        index: entry.index,
        machineId: entry.definition.id,
        machineName: entry.definition.name,
        nextId: id,
        message: `Machine "${entry.definition.name}" was kept as "${id}" because "${entry.definition.id}" is already used in this project.`,
      })
      usedIds.add(id)
      keptUnselected.push({ definition: rekeyed, index: entry.index })
      continue
    }
    usedIds.add(entry.definition.id)
    keptUnselected.push(entry)
  }

  const customDefinitions: MachineDefinition[] = []
  if (selected && !isBundledMachineId(selected.id)) customDefinitions.push(selected)
  for (const { definition, index } of keptUnselected) {
    if (isBundledMachineId(definition.id)) {
      const bundled = getBundledMachine(definition.id)
      // An unmodified bundled copy is what the build already supplies.
      if (bundled && machinesFunctionallyEqual(bundled, definition)) continue
    }
    const { definition: rescued, rekeyed } = asRescuedCustom(definition, usedIds)
    if (rekeyed) {
      diagnostics.push({
        severity: 'warning',
        kind: 'machine-rekeyed',
        index,
        machineId: definition.id,
        machineName: definition.name,
        nextId: rescued.id,
        message: `An unselected copy of "${definition.name}" was kept in My Machines as "${rescued.id}" because "${definition.id}" is a built-in id.`,
      })
    }
    diagnostics.push({
      severity: 'info',
      kind: 'machine-moved-to-library',
      index,
      machineId: definition.id,
      machineName: definition.name,
      nextId: rescued.id,
      message: `Machine "${definition.name}" was moved to My Machines so opening this project cannot lose it.`,
    })
    usedIds.add(rescued.id)
    customDefinitions.push(rescued)
  }

  if (selectedMachineId && !selected) {
    diagnostics.push({
      severity: 'warning',
      kind: 'machine-selection-unresolved',
      machineId: selectedMachineId,
      message: `This project selected a machine ("${selectedMachineId}") that it does not carry, so no machine is selected. Choose one in Project Properties before exporting G-code.`,
    })
  }

  return snapshotOf(
    selected,
    customDefinitions,
    rawDefinitions.length,
    selectedMachineId && !selected ? selectedMachineId : null,
    diagnostics,
  )
}

export function syncFeatureTreeProject(project: Project): Project {
  const featureFolders = (project.featureFolders ?? []).map((folder) => ({
    ...folder,
    grouped: folder.grouped ?? false,
  }))
  const folderIdSet = new Set(featureFolders.map((folder) => folder.id))
  const features = project.features.map((feature) => (
    feature.folderId && !folderIdSet.has(feature.folderId)
      ? { ...feature, folderId: null }
      : feature
  ))

  const featureMap = new Map(features.map((feature) => [feature.id, feature]))
  const usedRootFeatures = new Set<string>()
  const usedFolders = new Set<string>()
  const normalizedTree: import('../../types/project').FeatureTreeEntry[] = []

  for (const entry of project.featureTree ?? []) {
    if (entry.type === 'folder') {
      if (folderIdSet.has(entry.folderId) && !usedFolders.has(entry.folderId)) {
        normalizedTree.push(entry)
        usedFolders.add(entry.folderId)
      }
      continue
    }

    const feature = featureMap.get(entry.featureId)
    if (!feature || feature.folderId !== null || usedRootFeatures.has(entry.featureId)) {
      continue
    }

    normalizedTree.push(entry)
    usedRootFeatures.add(entry.featureId)
  }

  for (const folder of featureFolders) {
    if (!usedFolders.has(folder.id)) {
      normalizedTree.push({ type: 'folder', folderId: folder.id })
      usedFolders.add(folder.id)
    }
  }

  for (const feature of features) {
    if (feature.folderId === null && !usedRootFeatures.has(feature.id)) {
      normalizedTree.push({ type: 'feature', featureId: feature.id })
      usedRootFeatures.add(feature.id)
    }
  }

  const orderedFeatures: FeatureInstance[] = []
  const pushedFeatureIds = new Set<string>()

  for (const entry of normalizedTree) {
    if (entry.type === 'folder') {
      for (const feature of features) {
        if (feature.folderId === entry.folderId && !pushedFeatureIds.has(feature.id)) {
          orderedFeatures.push(feature)
          pushedFeatureIds.add(feature.id)
        }
      }
      continue
    }

    const feature = featureMap.get(entry.featureId)
    if (feature && !pushedFeatureIds.has(feature.id)) {
      orderedFeatures.push(feature)
      pushedFeatureIds.add(feature.id)
    }
  }

  for (const feature of features) {
    if (!pushedFeatureIds.has(feature.id)) {
      orderedFeatures.push({ ...feature, folderId: null })
    }
  }

  return {
    ...project,
    features: orderedFeatures,
    featureFolders,
    featureTree: normalizedTree,
  }
}

export function syncFeatureBasedStock(project: Project): Project {
  const stock = project.stock
  // A bar — round or square — cannot be derived from a feature: its rectangle is
  // the bar's box, not a feature outline, and re-deriving would replace the
  // diameter (or side) with z_top.
  if (isBarStock(stock)) return project
  if (!stock.sourceFeature || !stock.sourceFeatureId) {
    return project
  }

  const sourceInstance = project.features.find((feature) => feature.id === stock.sourceFeatureId)
    ?? stock.sourceFeature
  const resolvedSource = resolveFeatureRow(project, sourceInstance)
  if (!resolvedSource) return project
  return {
    ...project,
    stock: {
      ...stock,
      sourceFeature: sourceInstance,
      profile: resolvedSource.sketch.profile,
      thickness: typeof resolvedSource.z_top === 'number' ? resolvedSource.z_top : stock.thickness,
    },
  }
}

export function cloneProject(project: Project): Project {
  const cloned = structuredClone(project)
  cloned.modelAssets = project.modelAssets
  return cloned
}

export function instantiateProjectTemplate(template?: Project, name?: string): Project {
  const now = new Date().toISOString()

  if (!template) {
    return newProject(name)
  }

  const cloned = cloneProject(template)
  const instantiated: Project = {
    ...cloned,
    meta: {
      ...cloned.meta,
      name: name?.trim() || 'Untitled',
      created: now,
      modified: now,
    },
    backdrop: null,
    dimensions: {},
    annotations: [],
    modelAssets: {},
    features: [],
    featureFolders: [],
    featureTree: [],
    global_constraints: [],
    operations: [],
    tabs: [],
    clamps: [],
    ai_history: [],
  }
  return withDefaultChuck(instantiated)
}

/**
 * A template's clamps are not carried into the new project, but a bar cannot
 * exist without its workholding: every block→bar conversion mints a chuck
 * (`projectWithStockShape`), and a project created already on a bar — the New
 * project dialog's rotary blank, or a template whose stock is one — would
 * otherwise start without it (#1046). The same `newChuck` helper sizes it, so a
 * square blank clears its corner envelope exactly as a conversion's chuck does.
 * A block (milling/plasma) has no workholding and gets none.
 */
function withDefaultChuck(project: Project): Project {
  const stock = project.stock
  if (!isBarStock(stock)) return project
  return { ...project, clamps: [newChuck(project, stock)] }
}

export function clearProjectMemoryCaches(): void {
  clearImportedModelCaches()
  clearSTLTransformedGeometryCache()
}

export function projectsEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Whether the feature list has a sensible base solid: the first solid row must
 * be Add (or an imported model). A rotary project with bar stock has no
 * base-add rule (#1054) — the bar is the material — so pass the project to
 * apply that exception; without one the historical rule answers.
 */
export function isFirstFeatureValid(
  features: SketchFeature[],
  project?: Pick<Project, 'meta' | 'stock'>,
): boolean {
  if (project && barSeedsModel(project)) return true
  const firstSolidFeature = features.find(isSolid)
  if (!firstSolidFeature) return true
  return firstSolidFeature.operation === 'add' || isImportedModelFeature(firstSolidFeature)
}
