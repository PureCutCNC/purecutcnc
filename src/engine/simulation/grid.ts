import type { Project } from '../../types/project'
import { getStockBounds } from '../../types/project'
import type { SimulationBuildOptions, SimulationGrid } from './types'

const DEFAULT_LONG_AXIS_CELLS = 180
const MIN_AXIS_CELLS = 24

export function resolveSimulationGridSpec(
  project: Project,
  options: SimulationBuildOptions = {},
): Omit<SimulationGrid, 'topZ'> {
  const stockBounds = getStockBounds(project.stock)
  const width = Math.max(stockBounds.maxX - stockBounds.minX, 1e-6)
  const height = Math.max(stockBounds.maxY - stockBounds.minY, 1e-6)
  const longAxisCells = Math.max(MIN_AXIS_CELLS, Math.round(options.targetLongAxisCells ?? DEFAULT_LONG_AXIS_CELLS))
  const longestAxis = Math.max(width, height)
  const cellSize = longestAxis / longAxisCells

  const cols = Math.max(MIN_AXIS_CELLS, Math.ceil(width / cellSize))
  const rows = Math.max(MIN_AXIS_CELLS, Math.ceil(height / cellSize))

  return {
    originX: stockBounds.minX,
    originY: stockBounds.minY,
    cellSize,
    cols,
    rows,
    stockBottomZ: 0,
    stockTopZ: project.stock.thickness,
  }
}

export function createSimulationGrid(
  project: Project,
  options: SimulationBuildOptions = {},
): SimulationGrid {
  const spec = resolveSimulationGridSpec(project, options)
  const cellCount = spec.cols * spec.rows
  const topZ = new Float32Array(cellCount)
  topZ.fill(spec.stockTopZ)

  return {
    ...spec,
    topZ,
  }
}
