import fs from 'fs';
import path from 'path';

const svgPath = 'public/icons.svg';
const outputPath = 'src/assets/icons.camj';

const svgContent = fs.readFileSync(svgPath, 'utf-8');

function vectorAngle(ux, uy, vx, vy) {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    if (len <= 1e-9) return 0;
    const sign = ux * vy - uy * vx < 0 ? -1 : 1;
    const value = Math.min(1, Math.max(-1, dot / len));
    return sign * Math.acos(value);
}

function svgArcToBeziers(start, rx, ry, xAxisRotation, largeArc, sweep, end) {
    if (rx <= 1e-9 || ry <= 1e-9) {
        return [{ type: 'line', to: end }];
    }

    const phi = (xAxisRotation * Math.PI) / 180;
    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);
    const dx2 = (start.x - end.x) / 2;
    const dy2 = (start.y - end.y) / 2;

    let x1p = cosPhi * dx2 + sinPhi * dy2;
    let y1p = -sinPhi * dx2 + cosPhi * dy2;
    let adjustedRx = Math.abs(rx);
    let adjustedRy = Math.abs(ry);

    const lambda = (x1p * x1p) / (adjustedRx * adjustedRx) + (y1p * y1p) / (adjustedRy * adjustedRy);
    if (lambda > 1) {
        const scale = Math.sqrt(lambda);
        adjustedRx *= scale;
        adjustedRy *= scale;
    }

    const numerator = adjustedRx * adjustedRx * adjustedRy * adjustedRy - adjustedRx * adjustedRx * y1p * y1p - adjustedRy * adjustedRy * x1p * x1p;
    const denominator = adjustedRx * adjustedRx * y1p * y1p + adjustedRy * adjustedRy * x1p * x1p;
    const factor = denominator <= 1e-9 ? 0 : Math.sqrt(Math.max(0, numerator / denominator)) * (largeArc === sweep ? -1 : 1);

    const cxp = factor * ((adjustedRx * y1p) / adjustedRy);
    const cyp = factor * (-(adjustedRy * x1p) / adjustedRx);

    const cx = cosPhi * cxp - sinPhi * cyp + (start.x + end.x) / 2;
    const cy = sinPhi * cxp + cosPhi * cyp + (start.y + end.y) / 2;

    const startAngle = vectorAngle(1, 0, (x1p - cxp) / adjustedRx, (y1p - cyp) / adjustedRy);
    let sweepAngle = vectorAngle((x1p - cxp) / adjustedRx, (y1p - cyp) / adjustedRy, (-x1p - cxp) / adjustedRx, (-y1p - cyp) / adjustedRy);

    if (!sweep && sweepAngle > 0) sweepAngle -= Math.PI * 2;
    else if (sweep && sweepAngle < 0) sweepAngle += Math.PI * 2;

    const segmentCount = Math.max(1, Math.ceil(Math.abs(sweepAngle) / (Math.PI / 2)));
    const step = sweepAngle / segmentCount;
    const beziers = [];

    for (let i = 0; i < segmentCount; i++) {
        const angle0 = startAngle + step * i;
        const angle1 = angle0 + step;
        const alpha = (4 / 3) * Math.tan((angle1 - angle0) / 4);
        const cos0 = Math.cos(angle0);
        const sin0 = Math.sin(angle0);
        const cos1 = Math.cos(angle1);
        const sin1 = Math.sin(angle1);

        const p0 = {
            x: cx + adjustedRx * cosPhi * cos0 - adjustedRy * sinPhi * sin0,
            y: cy + adjustedRx * sinPhi * cos0 + adjustedRy * cosPhi * sin0,
        };
        const p1 = {
            x: p0.x + alpha * (-adjustedRx * cosPhi * sin0 - adjustedRy * sinPhi * cos0),
            y: p0.y + alpha * (-adjustedRx * sinPhi * sin0 + adjustedRy * cosPhi * cos0),
        };
        const p3 = {
            x: cx + adjustedRx * cosPhi * cos1 - adjustedRy * sinPhi * sin1,
            y: cy + adjustedRx * sinPhi * cos1 + adjustedRy * cosPhi * sin1,
        };
        const p2 = {
            x: p3.x + alpha * (adjustedRx * cosPhi * sin1 + adjustedRy * sinPhi * cos1),
            y: p3.y + alpha * (adjustedRx * sinPhi * sin1 - adjustedRy * cosPhi * cos1),
        };

        beziers.push({ type: 'bezier', control1: p1, control2: p2, to: p3 });
    }
    return beziers;
}

function parsePath(d) {
    const tokens = d.match(/[AaCcHhLlMmQqSsTtVvZz]|[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || [];
    const profiles = [];
    let current = { x: 0, y: 0 };
    let start = { x: 0, y: 0 };
    let segments = [];
    let index = 0;
    let command = '';
    let previousCubicControl = null;
    let previousQuadraticControl = null;

    const finishSubpath = () => {
        if (segments.length > 0 || (profiles.length === 0 && tokens.length > 0)) {
            profiles.push({ start: { ...start }, segments: [...segments], closed: false });
            segments = [];
        }
    };

    const nextNumber = () => parseFloat(tokens[index++]);
    const hasNumber = () => index < tokens.length && !/[A-Za-z]/.test(tokens[index]);

    while (index < tokens.length) {
        if (/[A-Za-z]/.test(tokens[index])) {
            command = tokens[index++];
        }

        const absolute = command === command.toUpperCase();
        switch (command.toUpperCase()) {
            case 'M': {
                finishSubpath();
                const x = nextNumber();
                const y = nextNumber();
                current = absolute ? { x, y } : { x: current.x + x, y: current.y + y };
                start = { ...current };
                previousCubicControl = null;
                previousQuadraticControl = null;
                while (hasNumber()) {
                    const lx = nextNumber();
                    const ly = nextNumber();
                    current = absolute ? { x: lx, y: ly } : { x: current.x + lx, y: current.y + ly };
                    segments.push({ type: 'line', to: { ...current } });
                }
                break;
            }
            case 'L':
                while (hasNumber()) {
                    const x = nextNumber();
                    const y = nextNumber();
                    current = absolute ? { x, y } : { x: current.x + x, y: current.y + y };
                    segments.push({ type: 'line', to: { ...current } });
                }
                previousCubicControl = null;
                previousQuadraticControl = null;
                break;
            case 'H':
                while (hasNumber()) {
                    const x = nextNumber();
                    current = absolute ? { x, y: current.y } : { x: current.x + x, y: current.y };
                    segments.push({ type: 'line', to: { ...current } });
                }
                previousCubicControl = null;
                previousQuadraticControl = null;
                break;
            case 'V':
                while (hasNumber()) {
                    const y = nextNumber();
                    current = absolute ? { x: current.x, y } : { x: current.x, y: current.y + y };
                    segments.push({ type: 'line', to: { ...current } });
                }
                previousCubicControl = null;
                previousQuadraticControl = null;
                break;
            case 'C':
                while (hasNumber()) {
                    const c1x = nextNumber(); const c1y = nextNumber();
                    const c2x = nextNumber(); const c2y = nextNumber();
                    const ex = nextNumber(); const ey = nextNumber();
                    const control1 = absolute ? { x: c1x, y: c1y } : { x: current.x + c1x, y: current.y + c1y };
                    const control2 = absolute ? { x: c2x, y: c2y } : { x: current.x + c2x, y: current.y + c2y };
                    const to = absolute ? { x: ex, y: ey } : { x: current.x + ex, y: current.y + ey };
                    segments.push({ type: 'bezier', control1, control2, to });
                    current = { ...to };
                    previousCubicControl = control2;
                    previousQuadraticControl = null;
                }
                break;
            case 'S':
                while (hasNumber()) {
                    const c2x = nextNumber(); const c2y = nextNumber();
                    const ex = nextNumber(); const ey = nextNumber();
                    const control1 = previousCubicControl 
                        ? { x: 2 * current.x - previousCubicControl.x, y: 2 * current.y - previousCubicControl.y }
                        : { ...current };
                    const control2 = absolute ? { x: c2x, y: c2y } : { x: current.x + c2x, y: current.y + c2y };
                    const to = absolute ? { x: ex, y: ey } : { x: current.x + ex, y: current.y + ey };
                    segments.push({ type: 'bezier', control1, control2, to });
                    current = { ...to };
                    previousCubicControl = control2;
                    previousQuadraticControl = null;
                }
                break;
            case 'Q':
                while (hasNumber()) {
                    const cx = nextNumber(); const cy = nextNumber();
                    const ex = nextNumber(); const ey = nextNumber();
                    const control = absolute ? { x: cx, y: cy } : { x: current.x + cx, y: current.y + cy };
                    const end = absolute ? { x: ex, y: ey } : { x: current.x + ex, y: current.y + ey };
                    
                    // Quadratic to Cubic
                    const control1 = {
                        x: current.x + (2 / 3) * (control.x - current.x),
                        y: current.y + (2 / 3) * (control.y - current.y),
                    };
                    const control2 = {
                        x: end.x + (2 / 3) * (control.x - end.x),
                        y: end.y + (2 / 3) * (control.y - end.y),
                    };
                    segments.push({ type: 'bezier', control1, control2, to: end });
                    current = { ...end };
                    previousQuadraticControl = control;
                    previousCubicControl = null;
                }
                break;
            case 'T':
                while (hasNumber()) {
                    const ex = nextNumber(); const ey = nextNumber();
                    const control = previousQuadraticControl
                        ? { x: 2 * current.x - previousQuadraticControl.x, y: 2 * current.y - previousQuadraticControl.y }
                        : { ...current };
                    const end = absolute ? { x: ex, y: ey } : { x: current.x + ex, y: current.y + ey };
                    
                    // Quadratic to Cubic
                    const control1 = {
                        x: current.x + (2 / 3) * (control.x - current.x),
                        y: current.y + (2 / 3) * (control.y - current.y),
                    };
                    const control2 = {
                        x: end.x + (2 / 3) * (control.x - end.x),
                        y: end.y + (2 / 3) * (control.y - end.y),
                    };
                    segments.push({ type: 'bezier', control1, control2, to: end });
                    current = { ...end };
                    previousQuadraticControl = control;
                    previousCubicControl = null;
                }
                break;
            case 'A':
                while (hasNumber()) {
                    const rx = nextNumber();
                    const ry = nextNumber();
                    const xAxisRotation = nextNumber();
                    const largeArc = nextNumber() !== 0;
                    const sweep = nextNumber() !== 0;
                    const ex = nextNumber();
                    const ey = nextNumber();
                    const end = absolute ? { x: ex, y: ey } : { x: current.x + ex, y: current.y + ey };
                    
                    const beziers = svgArcToBeziers(current, rx, ry, xAxisRotation, largeArc, sweep, end);
                    segments.push(...beziers);
                    current = { ...end };
                    previousCubicControl = null;
                    previousQuadraticControl = null;
                }
                break;
            case 'Z':
                if (current.x !== start.x || current.y !== start.y) {
                    segments.push({ type: 'line', to: { ...start } });
                }
                current = { ...start };
                if (profiles.length === 0 || segments.length > 0) {
                   const subpath = { start: { ...start }, segments: [...segments], closed: true };
                   profiles.push(subpath);
                   segments = [];
                } else {
                   profiles[profiles.length - 1].closed = true;
                }
                previousCubicControl = null;
                previousQuadraticControl = null;
                break;
            default:
                if (tokens[index] && !/[A-Za-z]/.test(tokens[index])) {
                    index++;
                }
                break;
        }
    }
    finishSubpath();
    return profiles;
}

function parseRect(node) {
    const x = parseFloat(node.match(/x="([^"]+)"/)?.[1] || '0');
    const y = parseFloat(node.match(/y="([^"]+)"/)?.[1] || '0');
    const w = parseFloat(node.match(/width="([^"]+)"/)?.[1] || '0');
    const h = parseFloat(node.match(/height="([^"]+)"/)?.[1] || '0');
    return {
        start: { x, y },
        segments: [
            { type: 'line', to: { x: x + w, y } },
            { type: 'line', to: { x: x + w, y: y + h } },
            { type: 'line', to: { x, y: y + h } },
            { type: 'line', to: { x, y } },
        ],
        closed: true
    };
}

function parseCircle(node) {
    const cx = parseFloat(node.match(/cx="([^"]+)"/)?.[1] || '0');
    const cy = parseFloat(node.match(/cy="([^"]+)"/)?.[1] || '0');
    const r = parseFloat(node.match(/r="([^"]+)"/)?.[1] || '0');
    // Approximate with 4 arcs
    return {
        start: { x: cx + r, y: cy },
        segments: [
            { type: 'arc', to: { x: cx, y: cy + r }, center: { x: cx, y: cy }, clockwise: false },
            { type: 'arc', to: { x: cx - r, y: cy }, center: { x: cx, y: cy }, clockwise: false },
            { type: 'arc', to: { x: cx, y: cy - r }, center: { x: cx, y: cy }, clockwise: false },
            { type: 'arc', to: { x: cx + r, y: cy }, center: { x: cx, y: cy }, clockwise: false },
        ],
        closed: true
    };
}

function parsePolyline(node) {
    const pointsStr = node.match(/points="([^"]+)"/)?.[1] || '';
    const coords = pointsStr.trim().split(/[\s,]+/).map(parseFloat);
    const points = [];
    for (let i = 0; i < coords.length; i += 2) {
        points.push({ x: coords[i], y: coords[i+1] });
    }
    if (points.length < 2) return null;
    return {
        start: points[0],
        segments: points.slice(1).map(p => ({ type: 'line', to: p })),
        closed: node.includes('<polygon')
    };
}

function parseLine(node) {
    const x1 = parseFloat(node.match(/x1="([^"]+)"/)?.[1] || '0');
    const y1 = parseFloat(node.match(/y1="([^"]+)"/)?.[1] || '0');
    const x2 = parseFloat(node.match(/x2="([^"]+)"/)?.[1] || '0');
    const y2 = parseFloat(node.match(/y2="([^"]+)"/)?.[1] || '0');
    return {
        start: { x: x1, y: y1 },
        segments: [{ type: 'line', to: { x: x2, y: y2 } }],
        closed: false
    };
}

const symbols = svgContent.match(/<symbol[^>]*>([\s\S]*?)<\/symbol>/g) || [];
const features = [];
const featureFolders = [];
const featureTree = [];

symbols.forEach((symbolNode, index) => {
    const id = symbolNode.match(/id="([^"]+)"/)?.[1] || `icon_${index}`;
    
    // Create folder for this icon
    const folderId = `folder_${id}`;
    featureFolders.push({
        id: folderId,
        name: id,
        collapsed: index !== 0 // Only first folder expanded
    });
    
    // Add folder to tree
    featureTree.push({ type: 'folder', folderId: folderId });

    // Find all shapes in symbol
    const shapes = symbolNode.match(/<(path|rect|circle|polyline|line|polygon)[^>]*\/>/g) || [];
    
    shapes.forEach((shapeNode, shapeIndex) => {
        let profiles = [];
        let kind = 'composite';
        if (shapeNode.startsWith('<path')) {
            const d = shapeNode.match(/d="([^"]+)"/)?.[1] || '';
            profiles = parsePath(d);
            kind = 'composite';
        } else if (shapeNode.startsWith('<rect')) {
            profiles = [parseRect(shapeNode)];
            kind = 'rect';
        } else if (shapeNode.startsWith('<circle')) {
            profiles = [parseCircle(shapeNode)];
            kind = 'circle';
        } else if (shapeNode.startsWith('<polyline') || shapeNode.startsWith('<polygon')) {
            profiles = [parsePolyline(shapeNode)];
            kind = 'polygon';
        } else if (shapeNode.startsWith('<line')) {
            profiles = [parseLine(shapeNode)];
            kind = 'composite';
        }

        profiles.forEach((profile, subIndex) => {
            if (profile) {
                // All icons at 0,0
                const offsetX = 0;
                const offsetY = 0;

                const sketch = {
                    profile: {
                        start: { x: profile.start.x + offsetX, y: profile.start.y + offsetY },
                        segments: profile.segments.map(s => {
                            const segment = { ...s, to: { x: s.to.x + offsetX, y: s.to.y + offsetY } };
                            if (s.center) segment.center = { x: s.center.x + offsetX, y: s.center.y + offsetY };
                            if (s.control1) segment.control1 = { x: s.control1.x + offsetX, y: s.control1.y + offsetY };
                            if (s.control2) segment.control2 = { x: s.control2.x + offsetX, y: s.control2.y + offsetY };
                            return segment;
                        }),
                        closed: profile.closed
                    },
                    origin: { x: 0, y: 0 },
                    orientationAngle: 0,
                    dimensions: [],
                    constraints: []
                };

                const featureId = `icon_${id}${shapeIndex > 0 ? `_${shapeIndex}` : ''}${subIndex > 0 ? `_${subIndex}` : ''}`;
                features.push({
                    id: featureId,
                    name: `${id}_shape_${shapeIndex}${subIndex > 0 ? `_${subIndex}` : ''}`, // Give shape a sub-name
                    kind: kind,
                    folderId: folderId, // Put in folder
                    sketch,
                    operation: 'add',
                    z_top: 0,
                    z_bottom: -1,
                    visible: index === 0, // Only first icon visible
                    locked: false
                });
            }
        });
    });
});

const now = new Date().toISOString();
const project = {
    version: '1.0',
    meta: {
        name: 'Icons',
        created: now,
        modified: now,
        units: 'mm',
        showFeatureInfo: true,
        maxTravelZ: 50,
        operationClearanceZ: 5,
        clampClearanceXY: 2,
        clampClearanceZ: 5,
        machineDefinitions: [],
        selectedMachineId: null
    },
    grid: {
        extent: 500,
        majorSpacing: 30,
        minorSpacing: 10,
        snapEnabled: true,
        snapIncrement: 1,
        visible: true
    },
    stock: {
        profile: {
            start: { x: 0, y: 0 },
            segments: [
                { type: 'line', to: { x: 24, y: 0 } },
                { type: 'line', to: { x: 24, y: 24 } },
                { type: 'line', to: { x: 0, y: 24 } },
                { type: 'line', to: { x: 0, y: 0 } }
            ],
            closed: true
        },
        thickness: 1,
        material: 'plastic',
        color: '#eee',
        visible: true,
        origin: { x: 0, y: 0 }
    },
    origin: { name: 'Origin', x: 0, y: 0, z: 1, visible: true },
    backdrop: null,
    dimensions: {},
    features,
    featureFolders,
    featureTree,
    global_constraints: [],
    tools: [],
    operations: [],
    tabs: [],
    clamps: [],
    ai_history: []
};

fs.writeFileSync(outputPath, JSON.stringify(project, null, 2));
console.log(`Converted ${symbols.length} icons to ${outputPath}`);
