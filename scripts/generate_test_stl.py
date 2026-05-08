#!/usr/bin/env python3
"""Generate a test STL: 2x2x1 inch block with four 0.25" holes in the corners."""

import struct
import math
import os

INCH = 25.4  # mm

W = 2.0 * INCH
D = 2.0 * INCH
H = 1.0 * INCH
HOLE_R = 0.25 / 2 * INCH
HOLE_INSET = 0.5 * INCH
HOLE_SEGMENTS = 32

def cross(a, b):
    return (
        a[1]*b[2] - a[2]*b[1],
        a[2]*b[0] - a[0]*b[2],
        a[0]*b[1] - a[1]*b[0],
    )

def normalize(v):
    l = math.sqrt(v[0]**2 + v[1]**2 + v[2]**2)
    if l == 0:
        return (0, 0, 0)
    return (v[0]/l, v[1]/l, v[2]/l)

def sub(a, b):
    return (a[0]-b[0], a[1]-b[1], a[2]-b[2])

def tri_normal(v0, v1, v2):
    return normalize(cross(sub(v1, v0), sub(v2, v0)))

def write_stl(filename, triangles):
    with open(filename, 'wb') as f:
        f.write(b'\0' * 80)
        f.write(struct.pack('<I', len(triangles)))
        for v0, v1, v2 in triangles:
            n = tri_normal(v0, v1, v2)
            f.write(struct.pack('<3f', *n))
            f.write(struct.pack('<3f', *v0))
            f.write(struct.pack('<3f', *v1))
            f.write(struct.pack('<3f', *v2))
            f.write(struct.pack('<H', 0))

def box_triangles(w, d, h):
    x, y, z = w/2, d/2, h
    verts = [
        (-x,-y, 0), ( x,-y, 0), ( x, y, 0), (-x, y, 0),
        (-x,-y, z), ( x,-y, z), ( x, y, z), (-x, y, z),
    ]
    faces = [
        (0,3,2), (0,2,1),  # bottom
        (4,5,6), (4,6,7),  # top
        (0,1,5), (0,5,4),  # front
        (2,3,7), (2,7,6),  # back
        (1,2,6), (1,6,5),  # right
        (3,0,4), (3,4,7),  # left
    ]
    return [(verts[a], verts[b], verts[c]) for a, b, c in faces]

def cylinder_triangles(cx, cy, z0, z1, r, segs):
    tris = []
    for i in range(segs):
        a0 = 2 * math.pi * i / segs
        a1 = 2 * math.pi * (i + 1) / segs
        p0 = (cx + r*math.cos(a0), cy + r*math.sin(a0))
        p1 = (cx + r*math.cos(a1), cy + r*math.sin(a1))
        c = (cx, cy)

        # bottom cap (outward normal = -Z, so wind CW from below)
        tris.append(((c[0],c[1],z0), (p1[0],p1[1],z0), (p0[0],p0[1],z0)))
        # top cap
        tris.append(((c[0],c[1],z1), (p0[0],p0[1],z1), (p1[0],p1[1],z1)))
        # side
        tris.append(((p0[0],p0[1],z0), (p1[0],p1[1],z0), (p1[0],p1[1],z1)))
        tris.append(((p0[0],p0[1],z0), (p1[0],p1[1],z1), (p0[0],p0[1],z1)))
    return tris

def main():
    tris = box_triangles(W, D, H)

    hole_positions = [
        (-W/2 + HOLE_INSET, -D/2 + HOLE_INSET),
        ( W/2 - HOLE_INSET, -D/2 + HOLE_INSET),
        ( W/2 - HOLE_INSET,  D/2 - HOLE_INSET),
        (-W/2 + HOLE_INSET,  D/2 - HOLE_INSET),
    ]
    for cx, cy in hole_positions:
        tris.extend(cylinder_triangles(cx, cy, -0.01, H + 0.01, HOLE_R, HOLE_SEGMENTS))

    out_dir = os.path.join(os.path.dirname(__file__), '..', 'public', 'test-models')
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, 'test-block-2x2x1.stl')
    write_stl(out_path, tris)
    print(f"Written {len(tris)} triangles to {os.path.abspath(out_path)}")

if __name__ == '__main__':
    main()
