#!/usr/bin/env python3
"""Generates a synthetic reproducer for issue #812 with the same workload shape
as the user-supplied file: one outer outline plus a dense cluster of small
subtract features, cut by a 1/4" endmill with a helix entry, so the helix
placement search runs against clearance regions carrying many island contours.

Deliberately NOT a copy of the reported project — only its statistics are
matched: 35 features, 199 source segments, 15 circles / 20 composites,
1 add / 1 line / 33 subtract, five operations, one tool.
"""
import json, math

TAU = math.pi * 2


def norm(v):
    m = math.hypot(v[0], v[1])
    return (v[0] / m, v[1] / m)


def rounded_polygon(vertices, fillet):
    """CCW convex polygon with every corner filleted: N lines + N arcs."""
    n = len(vertices)
    tangents = []
    for i, v in enumerate(vertices):
        prev = vertices[(i - 1) % n]
        nxt = vertices[(i + 1) % n]
        u_in = norm((v[0] - prev[0], v[1] - prev[1]))
        u_out = norm((nxt[0] - v[0], nxt[1] - v[1]))
        cosang = max(-1.0, min(1.0, u_in[0] * u_out[0] + u_in[1] * u_out[1]))
        turn = math.acos(cosang)              # exterior angle
        interior = math.pi - turn
        t = fillet / math.tan(interior / 2)
        bis = norm((u_out[0] - u_in[0], u_out[1] - u_in[1]))
        dist = fillet / math.sin(interior / 2)
        tangents.append({
            'p_in': (v[0] - u_in[0] * t, v[1] - u_in[1] * t),
            'p_out': (v[0] + u_out[0] * t, v[1] + u_out[1] * t),
            'centre': (v[0] + bis[0] * dist, v[1] + bis[1] * dist),
        })
    start = tangents[0]['p_out']
    segments = []
    for i in range(n):
        nxt = tangents[(i + 1) % n]
        segments.append({'type': 'line', 'to': {'x': nxt['p_in'][0], 'y': nxt['p_in'][1]}})
        segments.append({'type': 'arc', 'to': {'x': nxt['p_out'][0], 'y': nxt['p_out'][1]},
                         'center': {'x': nxt['centre'][0], 'y': nxt['centre'][1]},
                         'clockwise': False})
    return {'start': {'x': start[0], 'y': start[1]}, 'segments': segments, 'closed': True}


def regular(cx, cy, radius, sides, phase=0.0):
    return [(cx + radius * math.cos(TAU * i / sides + phase),
             cy + radius * math.sin(TAU * i / sides + phase)) for i in range(sides)]


def circle_profile(cx, cy, radius):
    return {'start': {'x': cx + radius, 'y': cy},
            'segments': [{'type': 'circle', 'center': {'x': cx, 'y': cy},
                          'to': {'x': cx + radius, 'y': cy}, 'clockwise': True}],
            'closed': True}


defs, features, next_def, next_feat = {}, [], 278, 243
FOLDER = 'fd0242'


def add_feature(name, kind, profile, operation):
    global next_def, next_feat
    did, fid = f'f-{next_def:04d}', f'f{next_feat:04d}'
    next_def += 1
    next_feat += 1
    defs[did] = {'id': did, 'kind': kind, 'profile': profile,
                 'dimensions': [], 'text': None, 'stl': None, 'operation': operation}
    features.append({'id': fid, 'name': name, 'definitionId': did,
                     'transform': {'a': 1, 'b': 0, 'c': 0, 'd': 1, 'e': 0, 'f': 0},
                     'textLayout': None, 'constraints': [], 'z_top': 0.75, 'z_bottom': 0,
                     'folderId': FOLDER, 'visible': True, 'locked': False})
    return fid


# ---- f0243: engraved detail, 30 segments, untargeted but still an obstacle.
line_id = add_feature('Detail line', 'composite',
                      rounded_polygon(regular(20.5, -6.0, 2.6, 15, 0.21), 0.30), 'line')

# ---- f0244: the outer outline, 26 segments, cut by the two outside operations.
outline_id = add_feature('Panel outline', 'composite',
                         rounded_polygon(regular(14.0, -11.0, 11.6, 13, 0.11), 1.1), 'add')

# ---- f0245..f0277: 33 subtracts in a tight cluster so the clearance regions
#      between them are narrow and carry many island contours.
subtracts = []
GRID_X, GRID_Y, PITCH = 6, 6, 0.92
ORIGIN_X, ORIGIN_Y = 10.4, -14.6

# Seven long slots just one cutter wide. Cut inside with a 0.005" radial
# allowance, each leaves a clearance region about 0.242" x 2" — the shape that
# dominates the reported file. Its largest inscribed circle is half the width,
# below the tool radius, so the helix radius is clamped to exactly that circle:
# `requiredClearance` equals the region maximum, the only acceptable centres lie
# on the slot centreline, and the quadtree — seeded from the cut start at a
# corner and refining to centres offset from its parent's — never lands on the
# ridge and runs to its 20 000-cell budget.
CORRIDORS = [
    (1.10, 0.126, 0.00),
    (0.95, 0.126, 1.05),
    (0.77, 0.126, 2.10),
    (0.80, 0.166, 3.14),
    (1.26, 0.126, 4.19),
    (1.00, 0.126, 5.24),
    (0.90, 0.166, 0.52),
]
CORRIDOR_RING = 4.6
CLUSTER_CX, CLUSTER_CY = 12.7, -12.3

corridor_cells = []
for half_len, half_wid, angle in CORRIDORS:
    corridor_cells.append((
        CLUSTER_CX + math.cos(angle) * CORRIDOR_RING,
        CLUSTER_CY + math.sin(angle) * CORRIDOR_RING,
        half_len, half_wid, angle,
    ))

grid_cells = [(ORIGIN_X + col * PITCH, ORIGIN_Y + row * PITCH)
              for row in range(GRID_Y) for col in range(GRID_X)][:26]

tri_radii = [0.22, 0.26]                                          # 6 segments
# Nine more one-cutter-wide slots, short enough to sit on the cluster pitch.
rect_sizes = [(0.38, 0.126), (0.34, 0.126), (0.40, 0.166), (0.30, 0.126),
              (0.36, 0.126), (0.32, 0.166), (0.39, 0.126), (0.35, 0.126),
              (0.33, 0.166)]                                      # 8 segments
# 15 circles: eight below the 0.125" cutter radius (these force the fallback
# path), seven above it.
circle_radii = [0.055, 0.062, 0.071, 0.080, 0.088, 0.095, 0.104, 0.112,
                0.145, 0.160, 0.175, 0.190, 0.205, 0.220, 0.235]

tab_anchors = []


def rotated_rect(cx, cy, half_len, half_wid, angle):
    ca, sa = math.cos(angle), math.sin(angle)
    return [(cx + ca * dx - sa * dy, cy + sa * dx + ca * dy)
            for dx, dy in [(-half_len, -half_wid), (half_len, -half_wid),
                           (half_len, half_wid), (-half_len, half_wid)]]


# Three corridors carry four segments, four carry eight, matching the reported
# file's 4/6/8-segment split across its composite subtracts.
for index, (cx, cy, half_len, half_wid, angle) in enumerate(corridor_cells):
    verts = rotated_rect(cx, cy, half_len, half_wid, angle)
    profile = rounded_polygon(verts, half_wid * 0.92)
    if index < 3:
        profile['segments'] = profile['segments'][:4]
    fid = add_feature(f'Corridor {index + 1}', 'composite', profile, 'subtract')
    subtracts.append(fid)
    tab_anchors.append((fid, cx, cy, half_wid, 'corridor'))

queue = ([('circle', r) for r in circle_radii]
         + [('tri', r) for r in tri_radii]
         + [('rect', s) for s in rect_sizes])
queue = [queue[i] for i in (list(range(0, len(queue), 2)) + list(range(1, len(queue), 2)))]

for (cx, cy), (shape, spec) in zip(grid_cells, queue):
    if shape == 'circle':
        add_feature(f'Bore {spec:.3f}', 'circle', circle_profile(cx, cy, spec), 'subtract')
    elif shape == 'tri':
        add_feature('Triangle pocket', 'composite',
                    rounded_polygon(regular(cx, cy, spec, 3, 0.3), spec * 0.35), 'subtract')
    else:
        w, h = spec
        verts = rotated_rect(cx, cy, w, h, (len(subtracts) % 4) * 0.7854)
        add_feature('Slot', 'composite', rounded_polygon(verts, h * 0.92), 'subtract')
    fid = features[-1]['id']
    subtracts.append(fid)
    reach = spec if shape in ('circle', 'tri') else max(spec)
    tab_anchors.append((fid, cx, cy, reach, shape))

drill_id = max((a for a in tab_anchors if a[4] == 'circle'), key=lambda a: a[3])[0]
inside_targets = [f for f in subtracts if f != drill_id]

# 104 tabs on a 0.60" lattice over the cut cluster. Each becomes a keep-out
# loop grown by the cutter's clearance — 0.118 + 2 x 0.125 = 0.368 across — so
# the free space left between two neighbouring loops is 0.60 - 0.368 = 0.232",
# narrower than the 0.25" cutter. Those slivers are the regions whose largest
# inscribed circle lands below the tool radius, which is what pins the helix
# radius to the region maximum and sends the placement search to its cell
# budget. `withEntryKeepOut` hands every loop to every region as an island, so
# the same searches also carry ~60 contours of scan cost per candidate cell.
TAB = 0.11811023622047245
TAB_PITCH = 0.60
tabs = []
lattice_cols, lattice_rows = 11, 10
lattice_x0 = CLUSTER_CX - (lattice_cols - 1) * TAB_PITCH / 2
lattice_y0 = CLUSTER_CY - (lattice_rows - 1) * TAB_PITCH / 2
for row in range(lattice_rows):
    for col in range(lattice_cols):
        if len(tabs) >= 104:
            break
        tabs.append({'id': f'tb{600 + len(tabs):04d}', 'name': f'Tab {len(tabs) + 1}',
                     'x': lattice_x0 + col * TAB_PITCH, 'y': lattice_y0 + row * TAB_PITCH,
                     'w': TAB, 'h': TAB, 'z_top': TAB, 'z_bottom': 0,
                     'visible': True, 'shape': 'rect'})

TOOL = {'id': 't0521', 'name': '1/4" Endmill', 'units': 'inch', 'type': 'flat_endmill',
        'diameter': 0.25, 'vBitAngle': None, 'flutes': 2, 'material': 'carbide',
        'defaultRpm': 18000, 'defaultFeed': 30, 'defaultPlungeFeed': 12,
        'defaultStepdown': 0.125, 'defaultStepover': 0.32, 'maxCutDepth': 1}

BASE_OP = {'description': '', 'enabled': True, 'showToolpath': True, 'debugToolpath': False,
           'toolRef': 't0521', 'stepdown': 0.125, 'stepover': 0.32, 'feed': 30,
           'plungeFeed': 12, 'rpm': 18000, 'pocketPattern': 'offset', 'pocketAngle': 0,
           'pocketSlotFeedPercent': 60, 'pocketFeedReduction': 'slots_only',
           'roundOutsideCorners': True, 'roundLinkCorners': True, 'cornerRelief': 'none',
           'stockToLeaveRadial': 0, 'stockToLeaveAxial': 0, 'finishWalls': True,
           'finishFloor': True, 'cutDirection': 'conventional',
           'arcFittingEnabled': True, 'machiningOrder': 'feature_first'}


def op(oid, name, kind, pass_, targets, **extra):
    o = dict(BASE_OP)
    o.update({'id': oid, 'name': name, 'kind': kind, 'pass': pass_,
              'target': {'source': 'features', 'featureIds': targets}})
    o.update(extra)
    return o


project = {
    'version': '3.1',
    'meta': {'name': 'entry-helix-dense-islands', 'created': '2026-09-19T00:00:00.000Z',
             'modified': '2026-09-19T00:00:00.000Z', 'units': 'inch',
             'showFeatureInfo': False, 'showDimensions': False, 'copyMode': 'reference',
             'maxTravelZ': 2, 'operationClearanceZ': 0.2, 'clampClearanceXY': 0.08,
             'clampClearanceZ': 0.2, 'machineDefinitions': [], 'selectedMachineId': None},
    'grid': {'extent': 30, 'majorSpacing': 1, 'minorSpacing': 0.1, 'snapEnabled': False,
             'snapIncrement': 0.1, 'visible': True},
    'stock': {'profile': {'start': {'x': 0, 'y': -25},
                          'segments': [{'type': 'line', 'to': {'x': 28, 'y': -25}},
                                       {'type': 'line', 'to': {'x': 28, 'y': 3}},
                                       {'type': 'line', 'to': {'x': 0, 'y': 3}},
                                       {'type': 'line', 'to': {'x': 0, 'y': -25}}],
                          'closed': True},
              'thickness': 0.75, 'material': 'aluminum_6061', 'color': '#b9a83c',
              'visible': False, 'origin': {'x': 0, 'y': 0}},
    'origin': {'name': 'Origin', 'x': 0, 'y': 0, 'z': 0, 'visible': True},
    'backdrop': None, 'dimensions': {}, 'annotations': [], 'modelAssets': {},
    'featureDefinitions': defs, 'features': features,
    'featureFolders': [{'id': FOLDER, 'name': 'Panel', 'collapsed': False, 'grouped': False}],
    'featureTree': [{'type': 'folder', 'folderId': FOLDER}],
    'global_constraints': [], 'tools': [TOOL],
    'operations': [
        op('op0626', 'Drill', 'drilling', 'rough', [drill_id],
           drillType='helical', peckDepth=0.07874015748031496,
           retractHeight=0.03937007874015748, dwellTime=0.5,
           countersinkDiameter=0.2362204724409449),
        op('op0627', 'Edge route inside Rough', 'edge_route_inside', 'rough', inside_targets,
           edgeStrategy='contour', entryStrategy='helix', entryRampAngle=5,
           stockToLeaveRadial=0.005, stockToLeaveAxial=0.005),
        op('op0628', 'Edge route inside Finish', 'edge_route_inside', 'finish', inside_targets,
           edgeStrategy='contour', entryStrategy='helix', entryRampAngle=5),
        op('op0629', 'Edge route outside Rough', 'edge_route_outside', 'rough', [outline_id],
           edgeStrategy='contour', entryStrategy='helix', entryRampAngle=5,
           stockToLeaveRadial=0.005, stockToLeaveAxial=0.005),
        op('op0630', 'Edge route outside Finish', 'edge_route_outside', 'finish', [outline_id],
           edgeStrategy='contour', entryStrategy='helix', entryRampAngle=5),
    ],
    'tabs': tabs, 'clamps': [], 'ai_history': [],
}

total_segments = sum(len(v['profile']['segments']) for v in defs.values())
kinds = {}
ops_count = {}
for v in defs.values():
    kinds[v['kind']] = kinds.get(v['kind'], 0) + 1
    ops_count[v['operation']] = ops_count.get(v['operation'], 0) + 1
print(f'features={len(features)} defs={len(defs)} segments={total_segments} '
      f'kinds={kinds} operations={ops_count} tabs={len(tabs)}')

with open('src/engine/test-fixtures/entry-helix-dense-islands.camj', 'w') as fh:
    json.dump(project, fh, indent=1)
print('size:', len(json.dumps(project, indent=1)), 'bytes')
