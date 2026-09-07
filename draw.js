// draw.js — renders computeLayout()'s output as a to-scale SVG plan.
//
// This fills the "to-scale plan drawing" 4:3 placeholder the design handoff
// deliberately left blank for "a separate geometry engine." No DOM library,
// just createElementNS.

const SVG_NS = 'http://www.w3.org/2000/svg';
const NON_SCALING = 'vector-effect:non-scaling-stroke;';

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function polygonPoints(pts) {
  return pts.map(p => `${p.x},${p.y}`).join(' ');
}

function drawRectTile(g, t) {
  const b = t.bbox;
  const cut = !t.full;
  g.appendChild(svgEl('rect', {
    x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0,
    fill: cut ? '#F6DED5' : '#E9EBE6',
    stroke: cut ? '#C8462A' : '#B9BFB6',
    'stroke-width': 1, style: NON_SCALING,
  }));
}

function drawQuadTile(g, t) {
  const cut = !t.full;
  const pieces = t.worldPieces && t.worldPieces.length ? t.worldPieces : [t.points];
  for (const piece of pieces) {
    g.appendChild(svgEl('polygon', {
      points: polygonPoints(piece),
      fill: cut ? '#F6DED5' : '#E9EBE6',
      stroke: cut ? '#C8462A' : '#B9BFB6',
      'stroke-width': 1, style: NON_SCALING,
    }));
  }
}

function drawLines(svg, layout, room) {
  for (const line of layout.lines) {
    let x1, y1, x2, y2;
    if (line.endpoints) {
      // diagonal: the engine already found where the 45-degree line crosses the room
      [x1, y1] = [line.endpoints[0].x, line.endpoints[0].y];
      [x2, y2] = [line.endpoints[1].x, line.endpoints[1].y];
    } else {
      const horizontal = line.from === 'north' || line.from === 'south';
      if (horizontal) {
        const y = line.from === 'north' ? line.inches : room.height - line.inches;
        [x1, y1, x2, y2] = [0, y, room.width, y];
      } else {
        const x = line.from === 'west' ? line.inches : room.width - line.inches;
        [x1, y1, x2, y2] = [x, 0, x, room.height];
      }
    }
    svg.appendChild(svgEl('line', {
      x1, y1, x2, y2, stroke: '#1B4FD8', 'stroke-width': 1, 'stroke-dasharray': '4 4', style: NON_SCALING,
    }));
  }
}

/**
 * renderPlan(container, result, focalWall)
 *   container  the DOM element to fill (its own size sets the drawing's size)
 *   result     the full computeLayout() return value
 */
export function renderPlan(container, result) {
  if (!container) return;
  const room = result.room;
  const polygon = result.input.room;
  const obstacles = result.input.obstacles || [];
  const layout = result.layout;

  const pad = Math.max(6, Math.min(room.width, room.height) * 0.08);
  const vbX = -pad, vbY = -pad, vbW = room.width + pad * 2, vbH = room.height + pad * 2;
  const svg = svgEl('svg', {
    viewBox: `${vbX} ${vbY} ${vbW} ${vbH}`, preserveAspectRatio: 'xMidYMid meet',
    width: '100%', height: '100%', style: 'display:block;',
  });

  // room ground, so any ungenerated sliver reads as floor, not a hole
  svg.appendChild(svgEl('polygon', { points: polygonPoints(polygon), fill: '#F4F5F2' }));

  const tilesGroup = svgEl('g');
  for (const t of layout.tiles) {
    if (t.shape === 'rect') drawRectTile(tilesGroup, t);
    else drawQuadTile(tilesGroup, t);
  }
  svg.appendChild(tilesGroup);

  for (const o of obstacles) {
    svg.appendChild(svgEl('rect', {
      x: o.x0, y: o.y0, width: o.x1 - o.x0, height: o.y1 - o.y0,
      fill: '#C8462A', stroke: '#15181B', 'stroke-width': 1, style: NON_SCALING,
    }));
  }

  drawLines(svg, layout, room);

  if (layout.start.tile) {
    const st = layout.start.tile;
    svg.appendChild(svgEl('rect', {
      x: st.x0, y: st.y0, width: st.x1 - st.x0, height: st.y1 - st.y0,
      fill: 'none', stroke: '#1B4FD8', 'stroke-width': 2.5, style: NON_SCALING,
    }));
  } else if (layout.anchor) {
    svg.appendChild(svgEl('circle', {
      cx: layout.anchor.x, cy: layout.anchor.y, r: 3,
      fill: '#1B4FD8', style: NON_SCALING,
    }));
  }

  svg.appendChild(svgEl('polygon', {
    points: polygonPoints(polygon), fill: 'none', stroke: '#15181B', 'stroke-width': 1.5, style: NON_SCALING,
  }));

  container.innerHTML = '';
  container.appendChild(svg);
}
