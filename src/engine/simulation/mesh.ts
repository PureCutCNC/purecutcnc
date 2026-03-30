import * as THREE from 'three'
import type { SimulationGrid } from './types'

const MATERIAL_EPSILON = 1e-6

function addQuad(
  positions: number[],
  normals: number[],
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  d: THREE.Vector3,
) {
  const ab = new THREE.Vector3().subVectors(b, a)
  const ac = new THREE.Vector3().subVectors(c, a)
  const normal = new THREE.Vector3().crossVectors(ab, ac).normalize()

  const vertices = [a, b, c, a, c, d]
  for (const vertex of vertices) {
    positions.push(vertex.x, vertex.y, vertex.z)
    normals.push(normal.x, normal.y, normal.z)
  }
}

export function buildSimulationGeometry(grid: SimulationGrid): THREE.BufferGeometry {
  const positions: number[] = []
  const normals: number[] = []
  const { originX, originY, cellSize, cols, rows, stockBottomZ } = grid

  const cellTop = (col: number, row: number) => grid.topZ[row * cols + col]
  const cellHasMaterial = (col: number, row: number) => cellTop(col, row) > stockBottomZ + MATERIAL_EPSILON

  for (let row = 0; row < rows; row += 1) {
    const z0 = originY + row * cellSize
    const z1 = z0 + cellSize

    for (let col = 0; col < cols; col += 1) {
      const x0 = originX + col * cellSize
      const x1 = x0 + cellSize
      const top = cellTop(col, row)
      const hasMaterial = cellHasMaterial(col, row)

      if (hasMaterial) {
        addQuad(
          positions,
          normals,
          new THREE.Vector3(x0, top, z0),
          new THREE.Vector3(x1, top, z0),
          new THREE.Vector3(x1, top, z1),
          new THREE.Vector3(x0, top, z1),
        )

        addQuad(
          positions,
          normals,
          new THREE.Vector3(x0, stockBottomZ, z0),
          new THREE.Vector3(x0, stockBottomZ, z1),
          new THREE.Vector3(x1, stockBottomZ, z1),
          new THREE.Vector3(x1, stockBottomZ, z0),
        )
      }

      if (hasMaterial) {
        const leftNeighborTop = col > 0 && cellHasMaterial(col - 1, row) ? cellTop(col - 1, row) : stockBottomZ
        if (Math.abs(leftNeighborTop - top) > 1e-9) {
          const low = Math.min(leftNeighborTop, top)
          const high = Math.max(leftNeighborTop, top)
          addQuad(
            positions,
            normals,
            new THREE.Vector3(x0, low, z0),
            new THREE.Vector3(x0, high, z0),
            new THREE.Vector3(x0, high, z1),
            new THREE.Vector3(x0, low, z1),
          )
        }

        const rightNeighborTop = col < cols - 1 && cellHasMaterial(col + 1, row) ? cellTop(col + 1, row) : stockBottomZ
        if (Math.abs(rightNeighborTop - top) > 1e-9) {
          const low = Math.min(rightNeighborTop, top)
          const high = Math.max(rightNeighborTop, top)
          addQuad(
            positions,
            normals,
            new THREE.Vector3(x1, low, z1),
            new THREE.Vector3(x1, high, z1),
            new THREE.Vector3(x1, high, z0),
            new THREE.Vector3(x1, low, z0),
          )
        }

        const bottomNeighborTop = row > 0 && cellHasMaterial(col, row - 1) ? cellTop(col, row - 1) : stockBottomZ
        if (Math.abs(bottomNeighborTop - top) > 1e-9) {
          const low = Math.min(bottomNeighborTop, top)
          const high = Math.max(bottomNeighborTop, top)
          addQuad(
            positions,
            normals,
            new THREE.Vector3(x1, low, z0),
            new THREE.Vector3(x1, high, z0),
            new THREE.Vector3(x0, high, z0),
            new THREE.Vector3(x0, low, z0),
          )
        }

        const topNeighborTop = row < rows - 1 && cellHasMaterial(col, row + 1) ? cellTop(col, row + 1) : stockBottomZ
        if (Math.abs(topNeighborTop - top) > 1e-9) {
          const low = Math.min(topNeighborTop, top)
          const high = Math.max(topNeighborTop, top)
          addQuad(
            positions,
            normals,
            new THREE.Vector3(x0, low, z1),
            new THREE.Vector3(x0, high, z1),
            new THREE.Vector3(x1, high, z1),
            new THREE.Vector3(x1, low, z1),
          )
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}
