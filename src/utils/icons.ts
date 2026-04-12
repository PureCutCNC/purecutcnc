import type { Project, SketchProfile } from '../types/project';

/**
 * Converts a SketchProfile to an SVG path string.
 * Assumes coordinates are already in SVG space (24x24 for icons).
 */
export function profileToSvgPath(profile: SketchProfile): string {
  if (!profile.segments.length) return '';

  let d = `M ${profile.start.x} ${profile.start.y}`;

  for (const segment of profile.segments) {
    if (segment.type === 'line') {
      d += ` L ${segment.to.x} ${segment.to.y}`;
    } else if (segment.type === 'arc') {
      const r = Math.hypot(segment.to.x - segment.center.x, segment.to.y - segment.center.y);
      const largeArc = 0; 
      const sweep = segment.clockwise ? 0 : 1;
      d += ` A ${r} ${r} 0 ${largeArc} ${sweep} ${segment.to.x} ${segment.to.y}`;
    } else if (segment.type === 'bezier') {
      d += ` C ${segment.control1.x} ${segment.control1.y}, ${segment.control2.x} ${segment.control2.y}, ${segment.to.x} ${segment.to.y}`;
    }
  }

  if (profile.closed) {
    d += ' Z';
  }

  return d;
}

/**
 * Converts a Project with icon features into an SVG sprite sheet string.
 * Each feature's name is used as the symbol ID.
 */
export function projectToSvgSprite(project: Project): string {
  const icons: Record<string, string[]> = {};

  for (const feature of project.features) {
    const id = feature.name;
    if (!icons[id]) icons[id] = [];

    const path = profileToSvgPath(feature.sketch.profile);
    if (path) {
      icons[id].push(`<path d="${path}" />`);
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
