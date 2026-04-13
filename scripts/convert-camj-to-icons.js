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

import fs from 'fs';
import path from 'path';

const camjPath = 'src/assets/icons.camj';
const outputPath = 'public/icons.svg';

if (!fs.existsSync(camjPath)) {
    console.error(`File not found: ${camjPath}`);
    process.exit(1);
}

const project = JSON.parse(fs.readFileSync(camjPath, 'utf-8'));

function profileToSvgPath(profile) {
    if (!profile.segments.length) return '';

    const start = profile.start;
    let d = `M ${start.x} ${start.y}`;

    for (const segment of profile.segments) {
        const to = segment.to;
        if (segment.type === 'line') {
            d += ` L ${to.x} ${to.y}`;
        } else if (segment.type === 'arc') {
            const center = segment.center;
            const r = Math.hypot(to.x - center.x, to.y - center.y);
            const largeArc = 0; 
            const sweep = segment.clockwise ? 0 : 1;
            d += ` A ${r} ${r} 0 ${largeArc} ${sweep} ${to.x} ${to.y}`;
        } else if (segment.type === 'bezier') {
            const c1 = segment.control1;
            const c2 = segment.control2;
            d += ` C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`;
        }
    }

    if (profile.closed) {
        d += ' Z';
    }

    return d;
}

function projectToSvgSprite(project) {
    const icons = {};

    // Group features by folder
    for (const folder of project.featureFolders) {
        const id = folder.name; // Folder name is the ID (e.g., "new", "save")
        const folderFeatures = project.features.filter(f => f.folderId === folder.id);
        
        if (!icons[id]) icons[id] = [];
        
        for (const feature of folderFeatures) {
            const path = profileToSvgPath(feature.sketch.profile);
            if (path) {
                // If it's a rect/circle kind, we could potentially export as <rect /> or <circle />
                // but path is more universal and works for everything in icons.camj.
                icons[id].push(`<path d="${path}" />`);
            }
        }
    }

    let svg = '<svg xmlns="http://www.w3.org/2000/svg" style="display: none;">\n';

    for (const [id, paths] of Object.entries(icons)) {
        svg += `  <symbol id="${id}" viewBox="0 0 24 24">\n`;
        paths.forEach(p => {
            svg += `    ${p}\n`;
        });
        svg += `  </symbol>\n`;
    }

    svg += '</svg>';
    return svg;
}

const svgContent = projectToSvgSprite(project);
fs.writeFileSync(outputPath, svgContent);
console.log(`Converted ${project.features.length} features to ${project.featureFolders.length} icons in ${outputPath}`);
