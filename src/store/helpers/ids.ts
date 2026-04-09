import type { Project } from '../../types/project'

let idCounter = 1

export function genId(prefix = 'f'): string {
  return `${prefix}${String(idCounter++).padStart(4, '0')}`
}

export function idNumericSuffix(id: string): number {
  const match = id.match(/(\d+)$/)
  return match ? Number.parseInt(match[1], 10) : 0
}

export function syncIdCounter(project: Project): void {
  const usedIds = [
    ...project.features.map((feature) => feature.id),
    ...project.featureFolders.map((folder) => folder.id),
    ...project.tools.map((tool) => tool.id),
    ...project.operations.map((operation) => operation.id),
    ...project.tabs.map((tab) => tab.id),
    ...project.clamps.map((clamp) => clamp.id),
  ]
  const maxSuffix = usedIds.reduce((max, id) => Math.max(max, idNumericSuffix(id)), 0)
  idCounter = Math.max(idCounter, maxSuffix + 1)
}

export function nextUniqueGeneratedId(project: Project, prefix: string): string {
  const usedIds = new Set([
    ...project.features.map((feature) => feature.id),
    ...project.featureFolders.map((folder) => folder.id),
    ...project.tools.map((tool) => tool.id),
    ...project.operations.map((operation) => operation.id),
    ...project.tabs.map((tab) => tab.id),
    ...project.clamps.map((clamp) => clamp.id),
  ])

  let nextId = genId(prefix)
  while (usedIds.has(nextId)) {
    nextId = genId(prefix)
  }
  return nextId
}

let placementSessionCounter = 1

export function nextPlacementSession(): number {
  return placementSessionCounter++
}
