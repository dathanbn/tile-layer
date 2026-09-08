// draw.js — renders computeLayout()'s output as a to-scale SVG plan.
//
// This fills the "to-scale plan drawing" 4:3 placeholder the design handoff
// deliberately left blank for "a separate geometry engine." No DOM library,
// just createElementNS.

const SVG_NS = 'http://www.w3.org/2000/svg';
const NON_SCALING = 'vector-effect:non-scaling-stroke;';

const INK = '#15181B', BLUE = '#1B4FD8', RED = '#C8462A', FLOOR = '#F4F5F2';
const PAINT = {
  full: { fill: '#E9EBE6', stroke: '#B9BFB6', width: 1 },
  cut: { fill: '#F6DED5', stroke: '#C8462A', width: 1 },
  // "ghost" is how a tile looks when this step is not about it: still there,
  // so the drawing stays the same floor, but visibly not the subject
  ghost: { fill: '#F1F2EF', stroke: '#DFE1DC', width: 1 },
  hot: { fill: '#F6DED5', stroke: '#C8462A', width: 2 },
  laid: { fill: '#DDE0DA', stroke: '#9AA296', width: 1 },
};

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function polygonPoints(pts) {
  return pts.map(p => `${p.x},${p.y}`).join(' ');
}

function paintAttrs(p) {
  return { fill: p.fill, stroke: p.stroke, 'stroke-width': p.width, style: NON_SCALING };
}

function drawTile(g, t, paint) {
  if (!paint) return;
  const a = paintAttrs(paint);
  if (t.shape === 'rect') {
    const b = t.bbox;
    g.appendChild(svgEl('rect', { x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0, ...a }));
    return;
  }
  const pieces = t.worldPieces && t.worldPieces.length ? t.worldPieces : [t.points];
  for (const piece of pieces) g.appendChild(svgEl('polygon', { points: polygonPoints(piece), ...a }));
}

/** Where a chalk line runs, in room coordinates. */
function lineEnds(line, room) {
  if (line.endpoints) {
    return [line.endpoints[0].x, line.endpoints[0].y, line.endpoints[1].x, line.endpoints[1].y];
  }
  if (line.from === 'north' || line.from === 'south') {
    const y = line.from === 'north' ? line.inches : room.height - line.inches;
    return [0, y, room.width, y];
  }
  const x = line.from === 'west' ? line.inches : room.width - line.inches;
  return [x, 0, x, room.height];
}

/**
 * mode 'normal' draws both chalk lines the way the plan always has. 'A' and
 * 'B' single out the line that step is about — drawn solid — and 'B' keeps A
 * on the drawing, faint, because you snap B against a line that is already
 * there. 'faint' shows both as context; 'none' leaves them off.
 */
function drawLines(svg, layout, room, mode) {
  if (mode === 'none') return;
  layout.lines.forEach((line, i) => {
    const name = i === 0 ? 'A' : 'B';
    if (mode === 'A' && name === 'B') return;
    const lead = mode === name;
    const [x1, y1, x2, y2] = lineEnds(line, room);
    svg.appendChild(svgEl('line', {
      x1, y1, x2, y2,
      stroke: BLUE,
      'stroke-width': lead ? 2.5 : 1,
      'stroke-dasharray': lead ? '' : '4 4',
      opacity: lead || mode === 'normal' ? 1 : 0.4,
      style: NON_SCALING,
    }));
  });
}

/**
 * The offset that a chalk line is snapped at, drawn as a tick from the wall
 * out to the line, so the number on the step card has somewhere to point.
 */
function drawOffsetTick(svg, line, room) {
  if (!line || line.endpoints || line.inches == null) return;
  const horizontal = line.from === 'north' || line.from === 'south';
  const at = horizontal
    ? (line.from === 'north' ? line.inches : room.height - line.inches)
    : (line.from === 'west' ? line.inches : room.width - line.inches);
  const wallAt = horizontal
    ? (line.from === 'north' ? 0 : room.height)
    : (line.from === 'west' ? 0 : room.width);
  const along = horizontal ? room.width * 0.18 : room.height * 0.18;
  const seg = horizontal
    ? { x1: along, y1: wallAt, x2: along, y2: at }
    : { x1: wallAt, y1: along, x2: at, y2: along };
  svg.appendChild(svgEl('line', { ...seg, stroke: BLUE, 'stroke-width': 1.5, style: NON_SCALING }));
  const cap = Math.min(room.width, room.height) * 0.03;
  for (const [cx, cy] of [[seg.x1, seg.y1], [seg.x2, seg.y2]]) {
    svg.appendChild(svgEl('line', {
      x1: horizontal ? cx - cap : cx, y1: horizontal ? cy : cy - cap,
      x2: horizontal ? cx + cap : cx, y2: horizontal ? cy : cy + cap,
      stroke: BLUE, 'stroke-width': 1.5, style: NON_SCALING,
    }));
  }
}

/**
 * buildPlanSvg(result, opts) — one drawing routine behind both the full plan
 * and the small step figures, so a step can never show a floor that differs
 * from the plan it came from.
 *
 *   opts.tiles      how to paint each tile: a function (tile) => paint key
 *   opts.lines      'normal' | 'A' | 'B' | 'faint' | 'none'
 *   opts.tick       'A' | 'B' | null — draw the wall-to-line offset tick
 *   opts.start      true to ring the first full tile
 *   opts.obstacles  'normal' | 'hot' | 'ghost'
 */
function buildPlanSvg(result, opts) {
  const room = result.room;
  const polygon = result.input.room;
  const obstacles = result.input.obstacles || [];
  const layout = result.layout;

  const pad = Math.max(6, Math.min(room.width, room.height) * 0.08);
  const svg = svgEl('svg', {
    viewBox: `${-pad} ${-pad} ${room.width + pad * 2} ${room.height + pad * 2}`,
    preserveAspectRatio: 'xMidYMid meet',
    width: '100%', height: '100%', style: 'display:block;',
  });

  // room ground, so any ungenerated sliver reads as floor, not a hole
  svg.appendChild(svgEl('polygon', { points: polygonPoints(polygon), fill: FLOOR }));

  const tilesGroup = svgEl('g');
  for (const t of layout.tiles) drawTile(tilesGroup, t, PAINT[opts.tiles(t)]);
  svg.appendChild(tilesGroup);

  const obstaclePaint = opts.obstacles === 'ghost'
    ? { fill: '#E4C6BC', stroke: '#C8998A', width: 1 }
    : { fill: RED, stroke: INK, width: opts.obstacles === 'hot' ? 2.5 : 1 };
  for (const o of obstacles) {
    svg.appendChild(svgEl('rect', {
      x: o.x0, y: o.y0, width: o.x1 - o.x0, height: o.y1 - o.y0, ...paintAttrs(obstaclePaint),
    }));
  }

  drawLines(svg, layout, room, opts.lines || 'normal');
  if (opts.tick) drawOffsetTick(svg, layout.lines[opts.tick === 'A' ? 0 : 1], room);

  if (opts.start) {
    if (layout.start.tile) {
      const st = layout.start.tile;
      svg.appendChild(svgEl('rect', {
        x: st.x0, y: st.y0, width: st.x1 - st.x0, height: st.y1 - st.y0,
        fill: 'none', stroke: BLUE, 'stroke-width': 2.5, style: NON_SCALING,
      }));
    } else if (layout.anchor) {
      svg.appendChild(svgEl('circle', { cx: layout.anchor.x, cy: layout.anchor.y, r: 3, fill: BLUE, style: NON_SCALING }));
    }
  }

  svg.appendChild(svgEl('polygon', {
    points: polygonPoints(polygon), fill: 'none', stroke: INK, 'stroke-width': 1.5, style: NON_SCALING,
  }));
  return svg;
}

function mount(container, svg) {
  container.innerHTML = '';
  container.appendChild(svg);
}

/**
 * renderPlan(container, result)
 *   container  the DOM element to fill (its own size sets the drawing's size)
 *   result     the full computeLayout() return value
 */
export function renderPlan(container, result) {
  if (!container) return;
  mount(container, buildPlanSvg(result, {
    tiles: (t) => (t.full ? 'full' : 'cut'),
    lines: 'normal', start: true, obstacles: 'normal',
  }));
}

/**
 * The figure beside one Lay-it instruction. Same floor every time; only the
 * part the step is asking for is drawn at full strength, so a setter can see
 * at a glance which bit of the room this sentence is about.
 */
const STEP_FIGURES = {
  lineA: { tiles: () => 'ghost', lines: 'A', tick: 'A', obstacles: 'ghost' },
  lineB: { tiles: () => 'ghost', lines: 'B', tick: 'B', obstacles: 'ghost' },
  start: { tiles: () => 'ghost', lines: 'faint', start: true, obstacles: 'ghost' },
  field: { tiles: (t) => (t.full ? 'full' : 'ghost'), lines: 'faint', start: true, obstacles: 'ghost' },
  cuts: { tiles: (t) => (t.full ? 'laid' : 'hot'), lines: 'none', obstacles: 'ghost' },
  obstacles: { tiles: (t) => (t.cutType === 'obstacle' ? 'hot' : 'laid'), lines: 'none', obstacles: 'hot' },
  done: { tiles: (t) => (t.full ? 'full' : 'cut'), lines: 'none', obstacles: 'normal' },
};

export function renderStepFigure(container, result, figure) {
  if (!container) return;
  const opts = STEP_FIGURES[figure] || STEP_FIGURES.done;
  mount(container, buildPlanSvg(result, { obstacles: 'normal', ...opts }));
}

/**
 * renderRoomPreview(container, polygon, obstacles, selectedId, handlers)
 *   polygon     the room outline (array of {x,y}, inches) — no tiles yet,
 *               this runs on the Space screen before a tile is even picked
 *   obstacles   [{ id, label, x, y, w, d }] in room inches
 *   selectedId  which obstacle is highlighted
 *   handlers.onSelect(id)      an obstacle was grabbed — update the
 *                              surrounding page's highlight/hint immediately,
 *                              without waiting for the drag to finish
 *   handlers.onDragEnd(id,x,y) drag released; x,y is the obstacle's new
 *                              top-left corner, in room inches
 *   handlers.onPick(x, y)      the empty floor was tapped — move whichever
 *                              obstacle is currently selected there, centered
 *                              on the tap
 */
export function renderRoomPreview(container, polygon, obstacles, selectedId, handlers) {
  if (!container) return;
  const { onSelect, onDragEnd, onPick } = handlers;
  const width = Math.max(...polygon.map(p => p.x));
  const height = Math.max(...polygon.map(p => p.y));
  const pad = Math.max(6, Math.min(width, height) * 0.08);
  const vbX = -pad, vbY = -pad, vbW = width + pad * 2, vbH = height + pad * 2;
  const svg = svgEl('svg', {
    viewBox: `${vbX} ${vbY} ${vbW} ${vbH}`, preserveAspectRatio: 'xMidYMid meet',
    width: '100%', height: '100%', style: 'display:block; touch-action:none;',
  });

  function toRoomPoint(e) {
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }

  svg.appendChild(svgEl('polygon', { points: polygonPoints(polygon), fill: '#F4F5F2' }));

  const DRAG_THRESHOLD = 4; // inches of pointer movement before a tap counts as a drag

  for (const o of obstacles) {
    const selected = o.id === selectedId;
    const rect = svgEl('rect', {
      x: o.x, y: o.y, width: o.w, height: o.d,
      fill: selected ? '#C8462A' : '#D98A73',
      stroke: selected ? '#15181B' : 'none', 'stroke-width': 1.5, style: NON_SCALING + 'cursor:grab;',
    });

    rect.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      rect.setPointerCapture(e.pointerId);
      const start = toRoomPoint(e);
      const grabDx = start.x - o.x, grabDy = start.y - o.y;
      let dragged = false;
      onSelect(o.id);

      const move = (ev) => {
        const p = toRoomPoint(ev);
        if (!dragged && Math.hypot(p.x - start.x, p.y - start.y) > DRAG_THRESHOLD) dragged = true;
        if (!dragged) return;
        const nx = Math.max(0, Math.min(width - o.w, p.x - grabDx));
        const ny = Math.max(0, Math.min(height - o.d, p.y - grabDy));
        rect.setAttribute('x', nx);
        rect.setAttribute('y', ny);
      };
      const up = (ev) => {
        rect.removeEventListener('pointermove', move);
        rect.removeEventListener('pointerup', up);
        if (dragged) {
          onDragEnd(o.id, Number(rect.getAttribute('x')), Number(rect.getAttribute('y')));
        }
      };
      rect.addEventListener('pointermove', move);
      rect.addEventListener('pointerup', up);
    });
    svg.appendChild(rect);
  }

  svg.appendChild(svgEl('polygon', {
    points: polygonPoints(polygon), fill: 'none', stroke: '#15181B', 'stroke-width': 1.5, style: NON_SCALING,
  }));

  svg.addEventListener('click', (e) => {
    const loc = toRoomPoint(e);
    onPick(loc.x, loc.y);
  });

  container.innerHTML = '';
  container.appendChild(svg);
}
