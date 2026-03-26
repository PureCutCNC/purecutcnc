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

  interface PolyTreeStatic {
    new (): PolyNodeLike
  }

  interface PathsStatic {
    new (): IntPoint[][]
  }

  interface ClipperLibShape {
    Clipper: ClipperStatic
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
  }

  const ClipperLib: ClipperLibShape
  export default ClipperLib
}
