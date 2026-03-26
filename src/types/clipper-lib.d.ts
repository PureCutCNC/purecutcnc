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
  }

  interface ClipperOffsetLike {
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

  interface ClipperLibShape {
    Clipper: ClipperStatic
    ClipperOffset: ClipperOffsetStatic
    PolyTree: PolyTreeStatic
    Paths: PathsStatic
    PolyType: {
      ptSubject: number
      ptClip: number
    }
    ClipType: {
      ctUnion: number
      ctDifference: number
    }
    PolyFillType: {
      pftNonZero: number
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
