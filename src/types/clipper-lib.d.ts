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

declare module 'clipper-lib' {
  interface IntPoint {
    X: number
    Y: number
  }

  interface PolyNodeLike {
    IsHole(): boolean
    Contour(): IntPoint[]
    Childs?(): PolyNodeLike[]
    m_Childs?: PolyNodeLike[]
  }

  interface ClipperLike {
    AddPaths(paths: IntPoint[][], polyType: number, closed: boolean): void
    Execute(clipType: number, solution: unknown, subjFillType: number, clipFillType: number): boolean
  }

  interface ClipperStatic {
    new (): ClipperLike
    Area(poly: IntPoint[]): number
  }

  interface ClipperOffsetLike {
    ArcTolerance: number
    AddPaths(paths: IntPoint[][], joinType: number, endType: number): void
    Execute(solution: IntPoint[][], delta: number): void
  }

  interface ClipperOffsetStatic {
    new (): ClipperOffsetLike
  }

  interface PolyTreeStatic {
    new (): PolyNodeLike
  }

  interface PathsStatic {
    new (): IntPoint[][]
  }

  interface ClipperJS {
    PerimeterOfPath(path: IntPoint[], closed: boolean, scale: number): number
    PerimeterOfPaths(paths: IntPoint[][], closed: boolean, scale: number): number
  }

  interface ClipperLibShape {
    Clipper: ClipperStatic
    ClipperOffset: ClipperOffsetStatic
    PolyTree: PolyTreeStatic
    Paths: PathsStatic
    JS: ClipperJS
    PolyType: {
      ptSubject: number
      ptClip: number
    }
    ClipType: {
      ctUnion: number
      ctIntersection: number
      ctDifference: number
      ctXor: number
    }
    PolyFillType: {
      pftNonZero: number
      pftEvenOdd: number
    }
    JoinType: {
      jtMiter: number
      jtRound: number
      jtSquare: number
    }
    EndType: {
      etClosedPolygon: number
    }
  }

  const ClipperLib: ClipperLibShape
  export default ClipperLib
}
