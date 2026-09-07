// layout.js — tile layout math engine.
//
// Pure geometry. No DOM access, no imports. Every length inside this module is
// in inches; feet-and-inches strings are produced only by the formatting
// helpers at the bottom of the result objects.
//
// Coordinate system: x runs west -> east, y runs north -> south. The room's
// bounding box has its north-west corner at (0, 0). Walls of the bounding box
// are named north (y = 0), south (y = height), west (x = 0) and east
// (x = width). Walls that an L-shape's notch adds are named "inner north",
// "inner east", etc., by the direction they sit relative to the floor they
// bound.

const EPS = 1e-7;
const SLIVER = 2;                // any cut under this is a sliver
const MIN_PERIMETER_GAP = 0.25;  // room a full tile must leave at a wall for a movement joint

// ============================================================================
// Numbers and display
// ============================================================================

function near(a, b, tol = EPS) {
  return Math.abs(a - b) <= tol;
}

function mod(a, m) {
  let r = a % m;
  if (r < 0) r += m;
  if (near(r, m, 1e-9)) r = 0;
  return r;
}

/** Round to the nearest 1/16 inch. */
export function roundSixteenth(x) {
  return Math.round(x * 16) / 16;
}

/** 5.1875 -> `5 3/16"`. Always rounds to the nearest 1/16 first. */
export function formatInches(x) {
  const sign = x < 0 ? '-' : '';
  const r = roundSixteenth(Math.abs(x));
  let whole = Math.floor(r);
  let num = Math.round((r - whole) * 16);
  let den = 16;
  if (num === 16) { whole += 1; num = 0; }
  while (num > 0 && num % 2 === 0) { num /= 2; den /= 2; }
  if (num === 0) return `${sign}${whole}"`;
  if (whole === 0) return `${sign}${num}/${den}"`;
  return `${sign}${whole} ${num}/${den}"`;
}

/** 126.5 -> `10' 6 1/2"`. Under a foot it falls back to plain inches. */
export function formatFeetInches(x) {
  const sign = x < 0 ? '-' : '';
  const r = roundSixteenth(Math.abs(x));
  const feet = Math.floor(r / 12 + 1e-9);
  if (feet === 0) return sign + formatInches(r);
  const rem = r - feet * 12;
  return `${sign}${feet}' ${formatInches(rem)}`;
}

/** A measurement carries the raw value, the 1/16 rounding, and both displays. */
export function measurement(inches) {
  const rounded = roundSixteenth(inches);
  return {
    inches,
    rounded,
    display: formatFeetInches(rounded),
    displayInches: formatInches(rounded),
  };
}

// ============================================================================
// Rooms
// ============================================================================

/** Rectangle polygon, north-west corner at the origin. */
export function rectangle(width, height) {
  return [
    { x: 0, y: 0 }, { x: width, y: 0 },
    { x: width, y: height }, { x: 0, y: height },
  ];
}

/**
 * L-shape: a width x height rectangle with a notchWidth x notchHeight bite
 * taken out of one corner ('northeast' by default).
 */
export function lShape(width, height, notchWidth, notchHeight, corner = 'northeast') {
  if (notchWidth <= 0 || notchHeight <= 0 || notchWidth >= width || notchHeight >= height) {
    throw new Error('L-shape notch must be smaller than the room in both directions');
  }
  const W = width, H = height, nw = notchWidth, nh = notchHeight;
  switch (corner) {
    case 'northeast':
      return [{ x: 0, y: 0 }, { x: W - nw, y: 0 }, { x: W - nw, y: nh }, { x: W, y: nh },
              { x: W, y: H }, { x: 0, y: H }];
    case 'northwest':
      return [{ x: nw, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H },
              { x: 0, y: nh }, { x: nw, y: nh }];
    case 'southeast':
      return [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H - nh }, { x: W - nw, y: H - nh },
              { x: W - nw, y: H }, { x: 0, y: H }];
    case 'southwest':
      return [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: nw, y: H },
              { x: nw, y: H - nh }, { x: 0, y: H - nh }];
    default:
      throw new Error(`Unknown corner "${corner}"`);
  }
}

function toPoint(p) {
  if (Array.isArray(p)) return { x: p[0], y: p[1] };
  return { x: p.x, y: p.y };
}

/** Accepts a polygon, {width,height}, or {width,height,notch:{width,height,corner}}. */
function normalizeRoom(room) {
  let pts;
  if (Array.isArray(room)) {
    pts = room.map(toPoint);
  } else if (room && typeof room === 'object' && room.width > 0 && room.height > 0) {
    pts = room.notch
      ? lShape(room.width, room.height, room.notch.width, room.notch.height, room.notch.corner)
      : rectangle(room.width, room.height);
  } else {
    throw new Error('room must be a polygon (array of points) or {width, height[, notch]}');
  }
  if (pts.length < 4) throw new Error('room polygon needs at least four corners');
  // Drop a closing point that repeats the first one.
  const f = pts[0], l = pts[pts.length - 1];
  if (near(f.x, l.x) && near(f.y, l.y)) pts = pts.slice(0, -1);
  // Rectilinear check and translation so the bounding box starts at (0, 0).
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if (!near(a.x, b.x) && !near(a.y, b.y)) {
      throw new Error(`room walls must be horizontal or vertical (corner ${i} to ${i + 1} is neither)`);
    }
  }
  const minX = Math.min(...pts.map(p => p.x));
  const minY = Math.min(...pts.map(p => p.y));
  return pts.map(p => ({ x: p.x - minX, y: p.y - minY }));
}

function polygonArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

function pointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > y) !== (b.y > y)) {
      const xi = a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y);
      if (x < xi) inside = !inside;
    }
  }
  return inside;
}

function uniqueSorted(values) {
  const out = [...values].sort((a, b) => a - b);
  return out.filter((v, i) => i === 0 || !near(v, out[i - 1]));
}

/**
 * Split a rectilinear polygon into axis-aligned rectangles by cutting along
 * every corner coordinate and keeping the cells whose centre is inside.
 */
function decompose(pts) {
  const xs = uniqueSorted(pts.map(p => p.x));
  const ys = uniqueSorted(pts.map(p => p.y));
  const cells = [];
  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = 0; j < ys.length - 1; j++) {
      const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2;
      if (pointInPolygon(cx, cy, pts)) {
        cells.push({ x0: xs[i], y0: ys[j], x1: xs[i + 1], y1: ys[j + 1] });
      }
    }
  }
  return cells;
}

/**
 * Name every wall. A horizontal wall with floor to its south is a "north"
 * wall, and so on. Walls on the bounding box keep the plain name; a notch's
 * walls are "inner north", "inner east", ...
 */
function nameWalls(pts, bounds) {
  const walls = [];
  const counts = {};
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const horizontal = near(a.y, b.y);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    let facing, at, from, to, axis, interior;
    if (horizontal) {
      axis = 'y'; at = a.y; from = Math.min(a.x, b.x); to = Math.max(a.x, b.x);
      interior = pointInPolygon(mx, my + 1e-4, pts) ? +1 : -1; // +1: floor is south of the wall
      facing = interior > 0 ? 'north' : 'south';
    } else {
      axis = 'x'; at = a.x; from = Math.min(a.y, b.y); to = Math.max(a.y, b.y);
      interior = pointInPolygon(mx + 1e-4, my, pts) ? +1 : -1; // +1: floor is east of the wall
      facing = interior > 0 ? 'west' : 'east';
    }
    const onBox = (facing === 'north' && near(at, 0)) || (facing === 'south' && near(at, bounds.height))
      || (facing === 'west' && near(at, 0)) || (facing === 'east' && near(at, bounds.width));
    let name = onBox ? facing : `inner ${facing}`;
    counts[name] = (counts[name] || 0) + 1;
    if (counts[name] > 1) name = `${name} ${counts[name]}`;
    walls.push({ name, facing, axis, at, from, to, interior, primary: onBox });
  }
  return walls;
}

/**
 * The maximal floor runs along one axis: for a rectangle just [0, W]; for an
 * L-shape the full width plus the narrower leg. Each is a candidate span to
 * centre the grid on.
 */
function axisSpans(cells, axis) {
  const lo = axis === 'x' ? 'x0' : 'y0', hi = axis === 'x' ? 'x1' : 'y1';
  const olo = axis === 'x' ? 'y0' : 'x0', ohi = axis === 'x' ? 'y1' : 'x1';
  const bands = uniqueSorted(cells.flatMap(c => [c[olo], c[ohi]]));
  const spans = [];
  for (let i = 0; i < bands.length - 1; i++) {
    const mid = (bands[i] + bands[i + 1]) / 2;
    const runs = cells.filter(c => c[olo] < mid && c[ohi] > mid)
      .map(c => [c[lo], c[hi]]).sort((a, b) => a[0] - b[0]);
    // merge touching runs
    const merged = [];
    for (const r of runs) {
      const last = merged[merged.length - 1];
      if (last && near(last[1], r[0])) last[1] = r[1]; else merged.push([r[0], r[1]]);
    }
    for (const [s, e] of merged) {
      if (!spans.some(sp => near(sp.start, s) && near(sp.end, e))) spans.push({ start: s, end: e, length: e - s });
    }
  }
  // Widest first: the bounding-box span is the default.
  spans.sort((a, b) => b.length - a.length);
  return spans;
}

export function analyzeRoom(roomInput, obstaclesInput = []) {
  const pts = normalizeRoom(roomInput);
  const width = Math.max(...pts.map(p => p.x));
  const height = Math.max(...pts.map(p => p.y));
  const bounds = { width, height };
  const cells = decompose(pts);
  const walls = nameWalls(pts, bounds);
  const obstacles = (obstaclesInput || []).map((o, i) => ({
    label: o.label || `obstacle ${i + 1}`,
    x0: o.x, y0: o.y, x1: o.x + o.width, y1: o.y + o.height,
  }));
  const grossArea = polygonArea(pts);
  let obstacleArea = 0;
  for (const o of obstacles) for (const c of cells) obstacleArea += rectOverlapArea(o, c);
  return {
    polygon: pts, width, height, bounds, cells, walls, obstacles,
    corners: pts.length,
    grossArea, obstacleArea, area: grossArea - obstacleArea,
    longAxis: width >= height ? 'x' : 'y',
  };
}

// ============================================================================
// Rectangle and polygon clipping
// ============================================================================

function rectOverlap(a, b) {
  const x0 = Math.max(a.x0, b.x0), y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1), y1 = Math.min(a.y1, b.y1);
  if (x1 - x0 <= EPS || y1 - y0 <= EPS) return null;
  return { x0, y0, x1, y1 };
}

function rectOverlapArea(a, b) {
  const r = rectOverlap(a, b);
  return r ? (r.x1 - r.x0) * (r.y1 - r.y0) : 0;
}

/** Sutherland-Hodgman clip of a convex polygon against an axis-aligned rect. */
function clipPolygonToRect(poly, rect) {
  const edges = [
    (p) => p.x - rect.x0, (p) => rect.x1 - p.x,
    (p) => p.y - rect.y0, (p) => rect.y1 - p.y,
  ];
  let out = poly;
  for (const inside of edges) {
    if (out.length === 0) break;
    const inp = out;
    out = [];
    for (let i = 0; i < inp.length; i++) {
      const cur = inp[i], prev = inp[(i + inp.length - 1) % inp.length];
      const dc = inside(cur), dp = inside(prev);
      if (dc >= 0) {
        if (dp < 0) out.push(lerp(prev, cur, dp / (dp - dc)));
        out.push(cur);
      } else if (dp >= 0) {
        out.push(lerp(prev, cur, dp / (dp - dc)));
      }
    }
  }
  return out;
}

function lerp(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

// ============================================================================
// Per-axis centring — the core algorithm
// ============================================================================

/**
 * Centre full modules on one span of the room.
 *
 *   M = tile + grout, n = floor(span / M), R = span - n*M, C = R / 2
 *   threshold = max(2, tile / 3), capped at tile / 2 so mosaics stay sane
 *   if C < threshold: C += M/2, n -= 1     (trade two slivers for two real cuts)
 *
 * Two edge cases the rule does not cover on its own:
 *   exact       — R <= grout: the tiles fit wall to wall with only a joint's
 *                 worth of gap, so there is no cut and nothing to shift.
 *   singlePiece — n = 0 before any shift: the span is narrower than one
 *                 module, so one piece runs wall to wall.
 *
 * origin is the near edge of the first full tile measured from the start of
 * the span; cutPiece is the physical width of the wall piece, which is C less
 * half a grout joint because a joint separates it from the first full tile.
 */
export function centerAxis(roomDim, tileDim, grout) {
  const M = tileDim + grout;
  let n = Math.floor((roomDim + 1e-9) / M);
  let R = roomDim - n * M;
  if (R < 0) R = 0;
  let C = R / 2;
  const threshold = Math.min(Math.max(SLIVER, tileDim / 3), tileDim / 2);
  const exact = n > 0 && R <= grout + 1e-9;
  let shifted = false;
  let singlePiece = false;
  if (exact) {
    // full tiles at both walls, leftover becomes the perimeter gap
  } else if (n === 0) {
    singlePiece = true;
  } else if (C < threshold - 1e-9) {
    C += M / 2;
    n -= 1;
    shifted = true;
  }
  let origin, cutPiece, wallGap;
  if (exact) {
    origin = (R + grout) / 2; cutPiece = 0; wallGap = origin;
  } else if (singlePiece) {
    origin = (roomDim - tileDim) / 2; cutPiece = Math.min(roomDim, tileDim); wallGap = null;
  } else {
    origin = C + grout / 2; cutPiece = C - grout / 2; wallGap = null;
  }
  return { M, n, R, C, threshold, shifted, exact, singlePiece, origin, cutPiece, wallGap, roomDim, tileDim, grout };
}

/**
 * The course-to-course shift sequence for running bond, as a function of
 * row index r. `offsetFrac` is the resolved {p, q, value} fraction of a
 * module. Three shapes:
 *
 *   drift     (default) — shift accumulates by offset every row, mod M:
 *             r*offset*M mod M. At offset = 1/q this repeats every q rows,
 *             climbing the same direction each time ("staircase").
 *   alternate — plain two-row bond regardless of q: row parity alone
 *               decides unshifted vs shifted by offset. This is the
 *               ordinary meaning of "running bond at X% offset" for any X.
 *   zigzag    — steps out by Mr/q each row up to q-1 steps, then back down
 *               to 0, a triangle wave of period 2(q-1). At q = 3 (1/3
 *               offset) this is the 0, 1, 2, 1 course-shift bounce.
 */
export function rowShiftFn(offsetFrac, Mr, pattern = 'drift') {
  const q = offsetFrac.q;
  if (pattern === 'alternate') {
    return (r) => mod(r, 2) * offsetFrac.value * Mr;
  }
  if (pattern === 'zigzag') {
    const amplitude = q - 1;
    if (amplitude <= 0) return () => 0;
    const period = 2 * amplitude;
    const step = Mr / q;
    return (r) => {
      const cyc = mod(r, period);
      const triangle = cyc <= amplitude ? cyc : period - cyc;
      return triangle * step;
    };
  }
  return (r) => mod(r * offsetFrac.value * Mr, Mr);
}

/** Snap an offset like 0.33 to 1/3 so the row cycle is exact. */
function offsetFraction(offset) {
  for (let q = 1; q <= 6; q++) {
    for (let p = 0; p <= q; p++) {
      if (Math.abs(offset - p / q) < 0.01) return { p, q, value: p / q };
    }
  }
  const pct = Math.round(offset * 100);
  let g = 100, a = pct;
  while (a) { [g, a] = [a, g % a]; }
  return { p: pct / g, q: 100 / g, value: pct / 100 };
}

/**
 * Decide the grid origin along one axis.
 *
 * Candidates are every floor span on this axis (bounding box first) with no
 * shift, with the half-module shift, and, for running bond, the finer shifts
 * that still leave opposite walls with the same set of cuts (multiples of
 * M / 2q for an offset of p/q). Every wall on the axis is scored by its
 * smallest C across the rows that touch it. The default (bounding box, no
 * shift) wins outright when it clears the threshold; otherwise the first
 * candidate in preference order that clears it; otherwise the best one.
 */
function chooseAxis({ spans, walls, tileDim, grout, offsetFrac, rowShift, rowsTouching }) {
  const M = tileDim + grout;
  const threshold = Math.min(Math.max(SLIVER, tileDim / 3), tileDim / 2);
  const q = offsetFrac ? offsetFrac.q : 1;
  const shiftFractions = [0, 0.5];
  for (let j = 1; j < 2 * q; j++) {
    const f = j / (2 * q);
    if (!shiftFractions.some(s => near(s, f))) shiftFractions.push(f);
  }

  const candidates = [];
  for (const span of spans) {
    const base = centerAxis(span.length, tileDim, grout);
    // an exact fit has nothing to shift, unless running bond's course shifts create cuts anyway
    const fractions = (base.singlePiece || (base.exact && q === 1)) ? [0] : shiftFractions;
    for (const f of fractions) {
      const shiftInches = f * M;
      let origin, n, C, shifted = f > 0;
      if (base.singlePiece || (base.exact && near(f, 0))) {
        origin = span.start + base.origin; n = base.n; C = base.C;
      } else {
        // unshifted spec values, then the candidate shift applied on top
        const n0 = Math.floor((span.length + 1e-9) / M);
        const C0 = (span.length - n0 * M) / 2;
        origin = span.start + C0 + grout / 2 + shiftInches;
        C = C0 + shiftInches;
        n = n0 - (f > 0 ? 1 : 0);
        if (near(f, 0)) { shifted = false; }
      }
      // score every wall on this axis
      const wallScores = [];
      let score = Infinity;
      for (const w of walls) {
        for (const r of rowsTouching(w)) {
          const o = origin + (rowShift ? rowShift(r) : 0);
          const gap = w.interior > 0 ? mod(o - w.at, M) : mod(w.at - o + grout, M);
          let c, kind;
          if (base.singlePiece && near(w.at, span.start) || base.singlePiece && near(w.at, span.end)) {
            c = span.length; kind = 'single';
          } else if (gap <= grout + 1e-9) {
            c = M; kind = 'full'; // a full tile lands at this wall, gap is `gap`
          } else {
            c = gap - grout / 2; kind = 'cut';
          }
          wallScores.push({ wall: w.name, row: r, C: c, kind, gap });
          score = Math.min(score, c);
        }
      }
      // opposite walls of this span must see the same set of cut widths
      const cutSet = (pred) => uniqueSorted(wallScores.filter(s => s.kind === 'cut' && pred(walls.find(w => w.name === s.wall))).map(s => s.C));
      const startSet = cutSet(w => w.interior > 0 && near(w.at, span.start));
      const endSet = cutSet(w => w.interior < 0 && near(w.at, span.end));
      const symmetric = startSet.length === endSet.length && startSet.every((v, i) => near(v, endSet[i], 1e-6));
      candidates.push({ span, fraction: f, shiftInches, origin, n, C, shifted, base, score, wallScores, threshold, M, symmetric });
    }
  }
  // preference order: bbox/0, bbox/half, other spans/0, other spans/half, then finer shifts
  const order = (c) => (spans.indexOf(c.span) * 10) + (c.fraction === 0 ? 0 : c.fraction === 0.5 ? 1 : 2 + c.fraction);
  candidates.sort((a, b) => order(a) - order(b));
  const pool = candidates.some(c => c.symmetric) ? candidates.filter(c => c.symmetric) : candidates;
  let chosen = pool.find(c => c.score >= threshold - 1e-9);
  if (!chosen) chosen = pool.reduce((best, c) => (c.score > best.score + 1e-9 ? c : best), pool[0]);
  return { ...chosen, candidates };
}

// ============================================================================
// Cut detection: intersect each tile with the room
// ============================================================================

function wallCrossesRect(w, rect) {
  if (w.axis === 'x') {
    return rect.x0 < w.at - EPS && rect.x1 > w.at + EPS &&
      Math.min(rect.y1, w.to) - Math.max(rect.y0, w.from) > EPS;
  }
  return rect.y0 < w.at - EPS && rect.y1 > w.at + EPS &&
    Math.min(rect.x1, w.to) - Math.max(rect.x0, w.from) > EPS;
}

/** Axis-aligned tile against the room: rectangle intersection per floor cell. */
function evaluateRect(rect, room, tileW, tileH) {
  const tileArea = tileW * tileH;
  const parts = [];
  let area = 0;
  let bbox = null;
  for (const c of room.cells) {
    const r = rectOverlap(rect, c);
    if (!r) continue;
    parts.push(r);
    area += (r.x1 - r.x0) * (r.y1 - r.y0);
    bbox = bbox ? {
      x0: Math.min(bbox.x0, r.x0), y0: Math.min(bbox.y0, r.y0),
      x1: Math.max(bbox.x1, r.x1), y1: Math.max(bbox.y1, r.y1),
    } : { ...r };
  }
  if (area <= 1e-6) return null;
  let obstacleHit = false;
  const obstacles = [];
  for (const o of room.obstacles) {
    let hit = false;
    for (const p of parts) {
      const a = rectOverlapArea(o, p);
      if (a > 0) { area -= a; hit = true; }
    }
    if (hit) { obstacleHit = true; obstacles.push(o.label); }
  }
  if (area <= 1e-6) return null;
  const full = area >= tileArea - 1e-6 && !obstacleHit;
  const wallCuts = [];
  for (const w of room.walls) {
    if (!wallCrossesRect(w, rect)) continue;
    let dim;
    if (w.axis === 'x') dim = w.interior > 0 ? bbox.x1 - w.at : w.at - bbox.x0;
    else dim = w.interior > 0 ? bbox.y1 - w.at : w.at - bbox.y0;
    wallCuts.push({ wall: w.name, dim });
  }
  const bw = bbox.x1 - bbox.x0, bh = bbox.y1 - bbox.y0;
  const notched = bw * bh > area + 1e-6;
  let cutType = null;
  if (!full) {
    if (obstacleHit) cutType = 'obstacle';
    else if (notched || (bw < tileW - 1e-6 && bh < tileH - 1e-6)) cutType = 'corner';
    else cutType = 'edge';
  }
  let minDim = wallCuts.length ? Math.min(...wallCuts.map(c => c.dim)) : Math.min(bw, bh);
  if (obstacleHit) {
    // the strips left between an obstacle and the tile edge are the fragile part of the piece
    for (const o of room.obstacles) {
      if (!rectOverlap(o, bbox)) continue;
      for (const strip of [o.x0 - bbox.x0, bbox.x1 - o.x1, o.y0 - bbox.y0, bbox.y1 - o.y1]) {
        if (strip > 1e-6) minDim = Math.min(minDim, strip);
      }
    }
  }
  return {
    full, cutType, area,
    piece: { width: bw, height: bh, area, shape: notched ? 'notched' : 'rect', minDim },
    wallCuts, obstacles,
    offcut: full ? 0 : tileArea - area,
  };
}

/** Rotated tile (a convex quad) against the room: clip against each floor cell. */
function evaluateQuad(quad, toLocal, room, tileW, tileH) {
  const tileArea = tileW * tileH;
  const pieces = [];
  let area = 0;
  for (const c of room.cells) {
    const clipped = clipPolygonToRect(quad, c);
    if (clipped.length < 3) continue;
    const a = polygonArea(clipped);
    if (a <= 1e-6) continue;
    pieces.push(clipped);
    area += a;
  }
  if (area <= 1e-6) return null;
  let obstacleHit = false;
  const obstacles = [];
  for (const o of room.obstacles) {
    let hit = false;
    for (const p of pieces) {
      const clipped = clipPolygonToRect(p, o);
      if (clipped.length < 3) continue;
      const a = polygonArea(clipped);
      if (a > 1e-6) { area -= a; hit = true; }
    }
    if (hit) { obstacleHit = true; obstacles.push(o.label); }
  }
  if (area <= 1e-6) return null;
  const full = area >= tileArea - 1e-4 && !obstacleHit;
  // piece size in the tile's own frame
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (const p of pieces) for (const pt of p) {
    const l = toLocal(pt);
    u0 = Math.min(u0, l.u); u1 = Math.max(u1, l.u);
    v0 = Math.min(v0, l.v); v1 = Math.max(v1, l.v);
  }
  const bw = u1 - u0, bh = v1 - v0;
  const xs = quad.map(p => p.x), ys = quad.map(p => p.y);
  const qb = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  const wallsHit = room.walls.filter(w => wallCrossesRect(w, qb));
  let cutType = null;
  if (!full) {
    if (obstacleHit) cutType = 'obstacle';
    else if (new Set(wallsHit.map(w => w.axis)).size > 1) cutType = 'corner';
    else cutType = 'edge';
  }
  return {
    full, cutType, area,
    piece: { width: bw, height: bh, area, shape: full ? 'rect' : 'polygon', minDim: Math.min(bw, bh) },
    wallCuts: wallsHit.map(w => ({ wall: w.name, dim: null })),
    obstacles,
    offcut: full ? 0 : tileArea - area,
  };
}

// ============================================================================
// Walls, lines and the "start here" corner
// ============================================================================

const LEFT_OF = { north: 'west', south: 'east', east: 'north', west: 'south' };
const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };

/** Distance from a bounding-box wall to a point. */
function distanceFromWall(wall, x, y, room) {
  switch (wall) {
    case 'north': return y;
    case 'south': return room.height - y;
    case 'west': return x;
    case 'east': return room.width - x;
    default: throw new Error(`unknown wall ${wall}`);
  }
}

function fromWall(wall, inches) {
  return { wall, ...measurement(inches) };
}

/** Where a straight line through P with direction d meets the bounding box. */
function lineBoxHits(P, d, room) {
  const hits = [];
  const test = (t) => {
    const x = P.x + d.x * t, y = P.y + d.y * t;
    if (x < -1e-6 || x > room.width + 1e-6 || y < -1e-6 || y > room.height + 1e-6) return;
    hits.push({ x: Math.min(Math.max(x, 0), room.width), y: Math.min(Math.max(y, 0), room.height), t });
  };
  if (Math.abs(d.x) > EPS) { test((0 - P.x) / d.x); test((room.width - P.x) / d.x); }
  if (Math.abs(d.y) > EPS) { test((0 - P.y) / d.y); test((room.height - P.y) / d.y); }
  hits.sort((a, b) => a.t - b.t);
  const uniq = hits.filter((h, i) => i === 0 || Math.abs(h.t - hits[i - 1].t) > 1e-6);
  return [uniq[0], uniq[uniq.length - 1]];
}

function describeBoxPoint(pt, room) {
  let wall;
  if (near(pt.x, 0, 1e-6)) wall = 'west';
  else if (near(pt.x, room.width, 1e-6)) wall = 'east';
  else if (near(pt.y, 0, 1e-6)) wall = 'north';
  else wall = 'south';
  let along;
  if (wall === 'west' || wall === 'east') {
    along = pt.y <= room.height / 2 ? fromWall('north', pt.y) : fromWall('south', room.height - pt.y);
  } else {
    along = pt.x <= room.width / 2 ? fromWall('west', pt.x) : fromWall('east', room.width - pt.x);
  }
  return { wall, along, x: pt.x, y: pt.y, text: `the ${wall} wall ${along.display} from the ${along.wall} corner` };
}

// ============================================================================
// Pattern layouts
// ============================================================================

/**
 * Stack and running bond. Rows run parallel to the focal wall. Row 0 is the
 * first full row from the focal wall; row r shifts by (r * offset * M) mod M.
 */
function layoutGrid(ctx, tx, ty, orientation) {
  const { room, grout, pattern, focalWall } = ctx;
  const offsetFrac = pattern === 'running' ? offsetFraction(ctx.offset) : { p: 0, q: 1, value: 0 };
  const rowAxis = (focalWall === 'north' || focalWall === 'south') ? 'x' : 'y';
  const acrossAxis = rowAxis === 'x' ? 'y' : 'x';
  const tileRow = rowAxis === 'x' ? tx : ty;
  const tileAcross = rowAxis === 'x' ? ty : tx;
  const focalAtStart = focalWall === 'north' || focalWall === 'west';
  const acrossExtent = acrossAxis === 'x' ? room.width : room.height;

  // 1. across axis: plain centring, one row set for the whole axis
  const across = chooseAxis({
    spans: axisSpans(room.cells, acrossAxis),
    walls: room.walls.filter(w => w.axis === acrossAxis),
    tileDim: tileAcross, grout,
    offsetFrac: null, rowShift: null, rowsTouching: () => [0],
  });
  const Ma = across.M;
  // index of the full row nearest the focal wall
  const lFirst = Math.ceil((0 - across.origin) / Ma - 1e-9);
  const lLast = Math.floor((acrossExtent - across.origin - tileAcross) / Ma + 1e-9);
  const lFocal = focalAtStart ? lFirst : lLast;
  const rowIndex = (l) => (focalAtStart ? l - lFocal : lFocal - l);
  const Mr = tileRow + grout;
  const rowShift = rowShiftFn(offsetFrac, Mr, ctx.offsetPattern);
  const rowsTouching = (w) => {
    const rows = [];
    const lo = Math.floor((w.from - across.origin) / Ma) - 1;
    const hi = Math.floor((w.to - across.origin) / Ma) + 1;
    for (let l = lo; l <= hi; l++) {
      const v0 = across.origin + l * Ma, v1 = v0 + tileAcross;
      if (v0 < w.to - EPS && v1 > w.from + EPS) rows.push(rowIndex(l));
    }
    return rows;
  };

  // 2. row axis: the running-bond aware centring
  const along = chooseAxis({
    spans: axisSpans(room.cells, rowAxis),
    walls: room.walls.filter(w => w.axis === rowAxis),
    tileDim: tileRow, grout, offsetFrac, rowShift, rowsTouching,
  });

  // 3. generate and clip every cell
  const rowExtent = rowAxis === 'x' ? room.width : room.height;
  const cells = [];
  const lLo = Math.floor((0 - across.origin) / Ma) - 1, lHi = Math.ceil((acrossExtent - across.origin) / Ma) + 1;
  for (let l = lLo; l <= lHi; l++) {
    const r = rowIndex(l);
    const shift = rowShift(r);
    const v0 = across.origin + l * Ma, v1 = v0 + tileAcross;
    const kLo = Math.floor((0 - along.origin - shift) / Mr) - 1, kHi = Math.ceil((rowExtent - along.origin - shift) / Mr) + 1;
    for (let k = kLo; k <= kHi; k++) {
      const u0 = along.origin + shift + k * Mr, u1 = u0 + tileRow;
      const rect = rowAxis === 'x' ? { x0: u0, y0: v0, x1: u1, y1: v1 } : { x0: v0, y0: u0, x1: v1, y1: u1 };
      const ev = evaluateRect(rect, room, tx, ty);
      if (!ev) continue;
      cells.push({ shape: 'rect', ...rect, row: r, col: k, ...ev });
    }
  }

  // 4. chalk lines and the start tile: first full tile in row 0 nearest the left wall
  const leftWall = LEFT_OF[focalWall];
  const fullRow0 = cells.filter(c => c.full && c.row === 0);
  const nearEdge = (c, wall) => {
    // distance from `wall` to the tile edge nearest it
    switch (wall) {
      case 'north': return c.y0;
      case 'south': return room.height - c.y1;
      case 'west': return c.x0;
      case 'east': return room.width - c.x1;
    }
  };
  let start = null;
  if (fullRow0.length) {
    const first = fullRow0.reduce((b, c) => (nearEdge(c, leftWall) < nearEdge(b, leftWall) ? c : b));
    start = { tile: { x0: first.x0, y0: first.y0, x1: first.x1, y1: first.y1 }, focal: nearEdge(first, focalWall), left: nearEdge(first, leftWall) };
  } else {
    // no full tile in the room: fall back to the grid origins, or the centre line
    // of an axis that is one piece wall to wall
    const dFocal = across.base.singlePiece ? acrossExtent / 2
      : focalAtStart ? across.origin : acrossExtent - (across.origin + lLast * Ma + tileAcross);
    const dLeft = along.base.singlePiece ? rowExtent / 2
      : (leftWall === 'west' || leftWall === 'north') ? along.origin : rowExtent - (along.origin + along.n * Mr - grout);
    start = { tile: null, focal: Math.max(0, dFocal), left: Math.max(0, dLeft) };
  }
  // A line closer than 2" to a wall cannot be snapped or checked, so move it one module in.
  const lineAIn = start.focal < SLIVER ? 1 : 0;
  const lineBIn = start.left < SLIVER ? 1 : 0;
  const lineADist = start.focal + lineAIn * Ma;
  const lineBDist = start.left + lineBIn * Mr;
  const lineA = {
    name: 'line A', parallelTo: focalWall, from: focalWall, ...measurement(lineADist), coursesIn: lineAIn,
    description: `Snap line A ${formatFeetInches(lineADist)} off the ${focalWall} wall, parallel to it. `
      + (start.tile
        ? (lineAIn ? 'It is the leading edge of the second full course; the first course sits between the line and the wall.' : 'It is the edge of the first full course.')
        : 'It is a grid line; no full tile fits this room.'),
  };
  const lineB = {
    name: 'line B', parallelTo: leftWall, from: leftWall, ...measurement(lineBDist), coursesIn: lineBIn,
    description: `Snap line B ${formatFeetInches(lineBDist)} off the ${leftWall} wall, square to line A (check it with a 3-4-5 triangle). `
      + (start.tile
        ? (lineBIn ? 'It is the edge of the second full tile in that course; the first sits between the line and the wall.' : 'It is the edge of the first full tile in that course.')
        : 'It is a grid line; no full tile fits this room.'),
  };
  const startHere = {
    from: [fromWall(focalWall, start.focal), fromWall(leftWall, start.left)],
    tile: start.tile,
    description: start.tile
      ? `Start here: set the first full tile in the corner where the lines cross, ${formatFeetInches(start.focal)} from the ${focalWall} wall and ${formatFeetInches(start.left)} from the ${leftWall} wall, and work away from both lines.`
      : `No full tile fits this room; every piece is a cut. Work from the lines outward.`,
  };

  const axes = {};
  axes[rowAxis] = axisReport(along, rowAxis, room, tileRow, grout, pattern === 'running' ? offsetFrac : null);
  axes[acrossAxis] = axisReport(across, acrossAxis, room, tileAcross, grout, null);
  return finishLayout(ctx, cells, tx, ty, orientation, {
    axes, lines: [lineA, lineB], start: startHere,
    rows: { axis: rowAxis, parallelTo: focalWall, shiftPerCourse: measurement(offsetFrac.value * Mr), offset: offsetFrac.value, pattern: pattern === 'running' ? (ctx.offsetPattern || 'drift') : null },
  });
}

function axisReport(chosen, axis, room, tileDim, grout, offsetFrac) {
  const startWall = room.walls.find(w => w.axis === axis && w.interior > 0 && near(w.at, chosen.span.start)
    && (near(chosen.span.start, 0) ? w.primary : true));
  const endWall = room.walls.find(w => w.axis === axis && w.interior < 0 && near(w.at, chosen.span.end)
    && (near(chosen.span.end, axis === 'x' ? room.width : room.height) ? w.primary : true));
  return {
    axis,
    tile: tileDim, grout,
    M: chosen.M,
    n: chosen.n,
    R: chosen.base.R,
    C: chosen.C,
    threshold: chosen.threshold,
    shifted: chosen.shifted,
    shift: { fraction: chosen.fraction, inches: chosen.shiftInches },
    exact: chosen.base.exact && chosen.fraction === 0,
    singlePiece: chosen.base.singlePiece,
    origin: chosen.origin,
    cutPiece: (chosen.base.exact && chosen.fraction === 0) ? 0 : chosen.base.singlePiece ? chosen.base.cutPiece : chosen.C - grout / 2,
    span: { start: chosen.span.start, end: chosen.span.end, length: chosen.span.length },
    centeredBetween: [startWall ? startWall.name : '?', endWall ? endWall.name : '?'],
    offset: offsetFrac ? offsetFrac.value : 0,
    candidatesTried: chosen.candidates.length,
  };
}

/** Rotation helpers for the diagonal pattern. */
function rotator(angleDeg, center) {
  const a = angleDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return {
    toWorld: (u, v) => ({ x: center.x + u * c - v * s, y: center.y + u * s + v * c }),
    toLocal: (p) => {
      const dx = p.x - center.x, dy = p.y - center.y;
      return { u: dx * c + dy * s, v: -dx * s + dy * c };
    },
  };
}

/** 45 degree diagonal: the stack grid rotated about the room centre and clipped. */
function layoutDiagonal(ctx, tx, ty, orientation) {
  const { room, grout, focalWall } = ctx;
  const center = { x: room.width / 2, y: room.height / 2 };
  const rot = rotator(45, center);
  const Mu = tx + grout, Mv = ty + grout;
  const threshold = Math.min(Math.max(SLIVER, Math.min(tx, ty) / 3), Math.min(tx, ty) / 2);
  const corners = [{ x: 0, y: 0 }, { x: room.width, y: 0 }, { x: 0, y: room.height }, { x: room.width, y: room.height }]
    .map(rot.toLocal);
  const uMin = Math.min(...corners.map(c => c.u)), uMax = Math.max(...corners.map(c => c.u));
  const vMin = Math.min(...corners.map(c => c.v)), vMax = Math.max(...corners.map(c => c.v));

  const build = (au, av) => {
    const cells = [];
    for (let k = Math.floor((uMin - au) / Mu) - 1; k <= Math.ceil((uMax - au) / Mu) + 1; k++) {
      for (let l = Math.floor((vMin - av) / Mv) - 1; l <= Math.ceil((vMax - av) / Mv) + 1; l++) {
        const u0 = au + k * Mu, v0 = av + l * Mv;
        const quad = [rot.toWorld(u0, v0), rot.toWorld(u0 + tx, v0), rot.toWorld(u0 + tx, v0 + ty), rot.toWorld(u0, v0 + ty)];
        const ev = evaluateQuad(quad, rot.toLocal, room, tx, ty);
        if (!ev) continue;
        const xs = quad.map(p => p.x), ys = quad.map(p => p.y);
        // bbox min/max double as each wall's true nearest-point distance, since
        // the closest point of any polygon to an axis-aligned line is at its bbox edge.
        const bbox = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
        cells.push({ shape: 'quad', points: quad, u0, v0, row: l, col: k, ...bbox, ...ev });
      }
    }
    return cells;
  };
  const chosen = pickAnchor([[0, 0], [Mu / 2, 0], [0, Mv / 2], [Mu / 2, Mv / 2]], build, threshold);
  const P = rot.toWorld(chosen.au, chosen.av);
  const lines = [[1, 0], [0, 1]].map(([du, dv], i) => {
    const w = rot.toWorld(du, dv);
    const d = { x: w.x - center.x, y: w.y - center.y };
    const [a, b] = lineBoxHits(P, d, room).map(h => describeBoxPoint(h, room));
    return {
      name: `line ${i === 0 ? 'A' : 'B'}`, angle: 45, endpoints: [a, b],
      through: { x: P.x, y: P.y },
      description: `Snap line ${i === 0 ? 'A' : 'B'} at 45 degrees from ${a.text} to ${b.text}.`,
    };
  });
  const leftWall = LEFT_OF[focalWall];
  const dFocal = distanceFromWall(focalWall, P.x, P.y, room);
  const dLeft = distanceFromWall(leftWall, P.x, P.y, room);
  const start = {
    from: [fromWall(focalWall, dFocal), fromWall(leftWall, dLeft)],
    tile: null,
    description: `Start here: the lines cross ${formatFeetInches(dFocal)} from the ${focalWall} wall and ${formatFeetInches(dLeft)} from the ${leftWall} wall. Set the corner of the first tile on the crossing with its edges on both lines, and work outward. Every tile at the walls is a cut.`,
  };
  return finishLayout(ctx, chosen.cells, tx, ty, orientation, {
    axes: null, lines, start,
    anchor: { x: P.x, y: P.y, shiftU: chosen.au, shiftV: chosen.av },
  });
}

/**
 * Herringbone: a horizontal tile with a vertical tile butted against its end,
 * repeated on the lattice (S', S') and (L', -L') where S' and L' are the
 * short and long modules. That lattice has area 2 S'L', the area of the pair,
 * so it tiles the plane with no gaps and no overlap.
 */
function layoutHerringbone(ctx, tx, ty, orientation) {
  const { room, grout, focalWall } = ctx;
  const long = Math.max(tx, ty), short = Math.min(tx, ty);
  const Lm = long + grout, Sm = short + grout;
  const transpose = orientation === 'perpendicular';
  const center = { x: room.width / 2, y: room.height / 2 };
  const threshold = Math.min(Math.max(SLIVER, short / 3), short / 2);
  const margin = Lm + Sm;
  // lattice inverse for the (m, n) ranges
  const mn = (dx, dy) => (transpose ? { m: (dy + dx) / (2 * Sm), n: (dy - dx) / (2 * Lm) } : { m: (dx + dy) / (2 * Sm), n: (dx - dy) / (2 * Lm) });

  const build = (ax, ay) => {
    const anchor = { x: center.x + ax, y: center.y + ay };
    const cornersMN = [[-margin, -margin], [room.width + margin, -margin], [-margin, room.height + margin], [room.width + margin, room.height + margin]]
      .map(([x, y]) => mn(x - anchor.x, y - anchor.y));
    const mLo = Math.floor(Math.min(...cornersMN.map(c => c.m))) - 1, mHi = Math.ceil(Math.max(...cornersMN.map(c => c.m))) + 1;
    const nLo = Math.floor(Math.min(...cornersMN.map(c => c.n))) - 1, nHi = Math.ceil(Math.max(...cornersMN.map(c => c.n))) + 1;
    const cells = [];
    for (let m = mLo; m <= mHi; m++) {
      for (let n = nLo; n <= nHi; n++) {
        let px = anchor.x + m * Sm + n * Lm, py = anchor.y + m * Sm - n * Lm;
        let hRect, vRect;
        if (!transpose) {
          hRect = { x0: px, y0: py, x1: px + long, y1: py + short };
          vRect = { x0: px + Lm, y0: py + Sm - Lm, x1: px + Lm + short, y1: py + Sm - Lm + long };
        } else {
          px = anchor.x + m * Sm - n * Lm; py = anchor.y + m * Sm + n * Lm;
          hRect = { x0: px, y0: py, x1: px + short, y1: py + long };
          vRect = { x0: px + Sm - Lm, y0: py + Lm, x1: px + Sm - Lm + long, y1: py + Lm + short };
        }
        for (const [rect, which] of [[hRect, 'A'], [vRect, 'B']]) {
          const w = rect.x1 - rect.x0, h = rect.y1 - rect.y0;
          const ev = evaluateRect(rect, room, w, h);
          if (!ev) continue;
          cells.push({ shape: 'rect', ...rect, row: m, col: n, unit: which, ...ev });
        }
      }
    }
    return cells;
  };
  const chosen = pickAnchor([[0, 0], [Lm / 2, 0], [0, Sm / 2], [Lm / 2, Sm / 2]], build, threshold);
  const P = { x: center.x + chosen.au, y: center.y + chosen.av };
  const leftWall = LEFT_OF[focalWall];
  const dFocal = distanceFromWall(focalWall, P.x, P.y, room);
  const dLeft = distanceFromWall(leftWall, P.x, P.y, room);
  const lines = [
    { name: 'line A', parallelTo: focalWall, from: focalWall, ...measurement(dFocal),
      description: `Snap line A ${formatFeetInches(dFocal)} off the ${focalWall} wall, parallel to it.` },
    { name: 'line B', parallelTo: leftWall, from: leftWall, ...measurement(dLeft),
      description: `Snap line B ${formatFeetInches(dLeft)} off the ${leftWall} wall, square to line A (check it with a 3-4-5 triangle).` },
  ];
  const start = {
    from: [fromWall(focalWall, dFocal), fromWall(leftWall, dLeft)],
    tile: null,
    description: `Start here: the lines cross ${formatFeetInches(dFocal)} from the ${focalWall} wall and ${formatFeetInches(dLeft)} from the ${leftWall} wall. Set the corner of the first tile on the crossing, its long side on line A, and butt the second tile against its end at a right angle. Every tile at the walls is a cut.`,
  };
  return finishLayout(ctx, chosen.cells, tx, ty, orientation, {
    axes: null, lines, start,
    anchor: { x: P.x, y: P.y, shiftX: chosen.au, shiftY: chosen.av },
  });
}

/** Try a few anchor offsets; keep the default unless it leaves a sliver. */
function pickAnchor(offsets, build, threshold) {
  let best = null;
  for (const [au, av] of offsets) {
    const cells = build(au, av);
    const cuts = cells.filter(c => !c.full);
    const smallest = cuts.length ? Math.min(...cuts.map(c => c.piece.minDim)) : Infinity;
    const cand = { au, av, cells, smallest, cuts: cuts.length };
    if (!best) { best = cand; if (smallest >= threshold) return best; continue; }
    if (smallest > best.smallest + 1e-6 || (near(smallest, best.smallest, 1e-6) && cuts.length < best.cuts)) best = cand;
  }
  return best;
}

// ============================================================================
// Counts, waste, warnings
// ============================================================================

function finishLayout(ctx, cells, tx, ty, orientation, extra) {
  const { room, grout, pattern, tile } = ctx;
  const tileArea = tx * ty;
  const full = cells.filter(c => c.full);
  const cuts = cells.filter(c => !c.full);
  const counts = {
    full: full.length,
    cut: cuts.length,
    edge: cuts.filter(c => c.cutType === 'edge').length,
    corner: cuts.filter(c => c.cutType === 'corner').length,
    obstacle: cuts.filter(c => c.cutType === 'obstacle').length,
    total: cells.length,
  };

  // cuts per wall: the distinct piece sizes landing on each wall
  const perWall = {};
  for (const w of room.walls) perWall[w.name] = [];
  for (const c of cuts) for (const wc of c.wallCuts) if (wc.dim != null) perWall[wc.wall].push(wc.dim);
  const cutsByWall = {};
  for (const w of room.walls) {
    const vals = uniqueSorted(perWall[w.name].map(v => roundSixteenth(v + 1e-9)));
    cutsByWall[w.name] = {
      values: vals.map(measurement),
      min: vals.length ? measurement(vals[0]) : null,
      max: vals.length ? measurement(vals[vals.length - 1]) : null,
      count: cuts.filter(c => c.wallCuts.some(wc => wc.wall === w.name)).length,
    };
  }
  let smallestCut = null;
  for (const c of cuts) {
    if (!smallestCut || c.piece.minDim < smallestCut.inches) {
      smallestCut = { inches: c.piece.minDim, walls: c.wallCuts.map(w => w.wall), cutType: c.cutType };
    }
  }
  if (smallestCut) smallestCut = { ...measurement(smallestCut.inches), walls: smallestCut.walls, cutType: smallestCut.cutType };

  // area and waste
  const fieldSqFt = room.area / 144;
  const laidArea = cells.reduce((s, c) => s + c.area, 0);
  const offcut = cuts.reduce((s, c) => s + c.offcut, 0);
  const tilesForCuts = countTilesForCuts(cuts, tx, ty, pattern);
  const tilesUsed = full.length + tilesForCuts;
  const purchased = tilesUsed * tileArea;
  const actualPct = purchased > 0 ? ((purchased - laidArea) / purchased) * 100 : 0;
  let allowancePct = (pattern === 'diagonal' || pattern === 'herringbone') ? 15 : 10;
  const extraCornersPct = room.corners > 4 ? 5 : 0;
  allowancePct += extraCornersPct;
  const flatAllowanceTiles = (fieldSqFt * (1 + allowancePct / 100) * 144) / tileArea;
  // The flat allowance is a rule of thumb; it must never recommend fewer tiles
  // than the engine's own count of what this exact layout consumes (full
  // tiles plus what the cut pieces use once same-size offcuts are reused).
  const tilesToBuy = Math.ceil(Math.max(flatAllowanceTiles, tilesUsed) - 1e-9);
  const sqFtToBuy = (tilesToBuy * tileArea) / 144;
  const boxes = ctx.tilesPerBox ? Math.ceil(tilesToBuy / ctx.tilesPerBox - 1e-9) : null;

  // warnings
  const warnings = [];
  const slivers = cuts.filter(c => c.piece.minDim < SLIVER - 1e-9);
  if (slivers.length) {
    const worst = slivers.reduce((b, c) => (c.piece.minDim < b.piece.minDim ? c : b));
    const wallNames = uniqueNames(slivers.flatMap(c => c.wallCuts.map(w => w.wall)));
    const obstacleNames = uniqueNames(slivers.flatMap(c => c.obstacles));
    const where = [];
    if (wallNames.length) where.push(`on the ${joinNames(wallNames)} wall${wallNames.length > 1 ? 's' : ''}`);
    if (obstacleNames.length) where.push(`against the ${joinNames(obstacleNames)}`);
    warnings.push(`A cut only ${formatInches(worst.piece.minDim)} wide lands ${where.join(' and ')} (${slivers.length} piece${slivers.length > 1 ? 's' : ''} under ${SLIVER}"). Slivers that thin snap on the saw and read as a mistake. Try the other tile orientation or a different offset before you commit.`);
  }
  const longSide = Math.max(tile.width, tile.height);
  if (pattern === 'running' && ctx.offset > 1 / 3 + 1e-6 && longSide > 15) {
    warnings.push(`A ${Math.round(ctx.offset * 100)}% offset on a ${formatInches(longSide)} tile risks lippage: large-format tile crowns in the middle, and a half offset puts the high point of one tile against the low edge of its neighbour. Use a 33% offset or less.`);
  }
  if (grout < 0.125 - 1e-9 && !tile.rectified) {
    warnings.push(`A ${formatInches(grout)} joint is too tight for a non-rectified tile. Cushion-edge tile varies in size and needs a 1/8" joint or wider to absorb it.`);
  }
  const tightWalls = [];
  for (const w of room.walls) {
    let minGap = Infinity;
    for (const c of full) {
      let gap;
      if (w.axis === 'x') {
        if (Math.min(c.y1, w.to) - Math.max(c.y0, w.from) <= EPS) continue;
        gap = w.interior > 0 ? c.x0 - w.at : w.at - c.x1;
      } else {
        if (Math.min(c.x1, w.to) - Math.max(c.x0, w.from) <= EPS) continue;
        gap = w.interior > 0 ? c.y0 - w.at : w.at - c.y1;
      }
      if (gap >= -EPS && gap < minGap) minGap = gap;
    }
    if (minGap < MIN_PERIMETER_GAP - 1e-9) tightWalls.push({ wall: w.name, gap: minGap });
  }
  if (tightWalls.length) {
    const g = Math.min(...tightWalls.map(t => t.gap));
    warnings.push(`Full tiles land ${formatInches(g)} from the ${joinNames(tightWalls.map(t => t.wall))} wall${tightWalls.length > 1 ? 's' : ''}, which leaves no room for a perimeter movement joint. Hold the field back so there is at least ${formatInches(MIN_PERIMETER_GAP)} at every wall and fill it with flexible sealant, not grout; the baseboard will cover it.`);
  }
  if (allowancePct > 20 + 1e-9 || actualPct > 20 + 1e-9) {
    warnings.push(`Waste runs to ${Math.round(Math.max(allowancePct, actualPct))}% with this layout, above the 20% you would normally plan for. Check the other orientation and whether offcuts from one wall can finish the opposite wall.`);
  }
  if ((pattern === 'diagonal' || pattern === 'herringbone') && cuts.length) {
    // no warning, but setters should know the count is a plan count
  }

  return {
    orientation,
    pattern,
    tile: { alongX: tx, alongY: ty, width: tile.width, height: tile.height, area: tileArea, module: { x: tx + grout, y: ty + grout } },
    ...extra,
    cutsByWall,
    smallestCut,
    counts,
    area: {
      fieldSqFt, fieldSqIn: room.area,
      tileSqFtLaid: laidArea / 144,
      offcutSqFt: offcut / 144,
    },
    waste: { allowancePct, patternPct: allowancePct - extraCornersPct, extraCornersPct, actualPct },
    purchase: { sqFtToBuy, tilesToBuy, tilesPerBox: ctx.tilesPerBox || null, boxes, tilesByCount: tilesUsed, tilesForCuts },
    warnings,
    tiles: cells,
  };
}

/**
 * How many whole tiles the cut pieces consume, allowing the obvious reuse:
 * same-size edge pieces come two or more to a tile when they fit end to end
 * (a saw kerf of 1/8 between them), and diagonal half-triangles pair up.
 * Corner, notched and obstacle pieces each take a tile.
 */
function countTilesForCuts(cuts, tx, ty, pattern) {
  const KERF = 0.125;
  const groups = {};
  let tiles = 0;
  for (const c of cuts) {
    if (pattern === 'diagonal') {
      if (c.cutType === 'edge' && c.area <= tx * ty / 2 + 1e-6) { groups.tri = (groups.tri || 0) + 1; } else tiles += 1;
      continue;
    }
    if (c.cutType !== 'edge' || c.piece.shape !== 'rect') { tiles += 1; continue; }
    // an edge piece keeps the full tile in one direction and is cut across the other
    const w = c.piece.width, h = c.piece.height;
    const tileW = c.x1 - c.x0, tileH = c.y1 - c.y0;
    const acrossX = w < tileW - 1e-6;
    const dim = acrossX ? w : h, tileDim = acrossX ? tileW : tileH;
    const key = `${acrossX ? 'x' : 'y'}:${roundSixteenth(tileDim)}:${roundSixteenth(dim)}`;
    groups[key] = (groups[key] || 0) + 1;
  }
  for (const [key, count] of Object.entries(groups)) {
    if (key === 'tri') { tiles += Math.ceil(count / 2); continue; }
    const [, tileDim, dim] = key.split(':').map(Number);
    const perTile = Math.max(1, Math.floor((tileDim + KERF) / (dim + KERF) + 1e-9));
    tiles += Math.ceil(count / perTile);
  }
  return tiles;
}

function uniqueNames(list) {
  return [...new Set(list)];
}

function joinNames(list) {
  if (list.length <= 1) return list.join('');
  return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
}

// ============================================================================
// Entry point
// ============================================================================

const PATTERNS = ['stack', 'running', 'diagonal', 'herringbone'];
const WALLS = ['north', 'south', 'east', 'west'];

/**
 * computeLayout({ room, tile, grout, pattern, offset, offsetPattern, focalWall, obstacles, tilesPerBox })
 *
 *   room       polygon in inches (array of {x,y} or [x,y]), or {width,height}
 *              or {width,height,notch:{width,height,corner}}
 *   tile       { width, height, rectified }
 *   grout      joint width in inches
 *   pattern    'stack' | 'running' | 'diagonal' | 'herringbone'
 *   offset     0..0.5, running bond only
 *   offsetPattern  running bond only, default 'drift':
 *     drift     — shift accumulates every row, mod a module (r*offset*M mod M).
 *                 At offset = 1/q this climbs the same direction for q rows,
 *                 then repeats ("staircase").
 *     alternate — plain two-row bond regardless of offset: odd rows shift,
 *                 even rows don't. The ordinary meaning of "X% offset".
 *     zigzag    — steps out by M/q each row up to q-1 steps, then back down
 *                 to 0 (a triangle wave). At offset = 1/3 this is the
 *                 0, 1, 2, 1 course-shift bounce.
 *   focalWall  'north' | 'south' | 'east' | 'west'
 *   obstacles  [{ x, y, width, height, label }] in room inches (optional)
 *   tilesPerBox  number (optional) — enables the box count
 *
 * Returns both tile orientations, flags the better one, and copies it to
 * `layout` for convenience.
 */
export function computeLayout(input) {
  const pattern = input.pattern || 'stack';
  if (!PATTERNS.includes(pattern)) throw new Error(`pattern must be one of ${PATTERNS.join(', ')}`);
  const focalWall = input.focalWall || 'north';
  if (!WALLS.includes(focalWall)) throw new Error(`focalWall must be one of ${WALLS.join(', ')}`);
  const tile = { width: +input.tile.width, height: +input.tile.height, rectified: !!input.tile.rectified };
  if (!(tile.width > 0) || !(tile.height > 0)) throw new Error('tile width and height must be positive');
  const grout = +input.grout;
  if (!(grout >= 0)) throw new Error('grout must be zero or positive');
  let offset = input.offset == null ? 0.5 : +input.offset;
  if (pattern !== 'running') offset = 0;
  if (offset < 0 || offset > 0.5) throw new Error('offset must be between 0 and 0.5');
  const offsetPattern = input.offsetPattern || 'drift';
  if (!['drift', 'alternate', 'zigzag'].includes(offsetPattern)) {
    throw new Error("offsetPattern must be 'drift', 'alternate', or 'zigzag'");
  }
  const room = analyzeRoom(input.room, input.obstacles);
  const ctx = { room, tile, grout, pattern, offset, offsetPattern, focalWall, tilesPerBox: input.tilesPerBox || null };

  const long = Math.max(tile.width, tile.height), short = Math.min(tile.width, tile.height);
  const square = near(long, short);
  const orientations = {};
  for (const orientation of ['parallel', 'perpendicular']) {
    // parallel: tile's long axis along the room's long wall
    const longAlongX = (room.longAxis === 'x') === (orientation === 'parallel');
    const tx = longAlongX ? long : short, ty = longAlongX ? short : long;
    let layout;
    if (pattern === 'diagonal') layout = layoutDiagonal(ctx, tx, ty, orientation);
    else if (pattern === 'herringbone') layout = layoutHerringbone(ctx, tx, ty, orientation);
    else layout = layoutGrid(ctx, tx, ty, orientation);
    layout.longAxisAlong = longAlongX ? 'x' : 'y';
    layout.longAxisParallelTo = longAlongX ? 'north/south walls' : 'east/west walls';
    orientations[orientation] = layout;
  }
  const recommended = compareOrientations(orientations.parallel, orientations.perpendicular, square, pattern);
  orientations[recommended.better].better = true;
  orientations[recommended.better === 'parallel' ? 'perpendicular' : 'parallel'].better = false;

  return {
    input: { room: room.polygon, tile, grout, pattern, offset, focalWall, obstacles: room.obstacles, tilesPerBox: ctx.tilesPerBox },
    room: {
      width: room.width, height: room.height, corners: room.corners, area: room.area, areaSqFt: room.area / 144,
      walls: room.walls.map(w => ({ name: w.name, facing: w.facing, at: w.at, from: w.from, to: w.to })),
      longAxis: room.longAxis, obstacleArea: room.obstacleArea,
    },
    orientations,
    recommended: recommended.better,
    orientationNote: recommended.note,
    layout: orientations[recommended.better],
    warnings: orientations[recommended.better].warnings,
  };
}

function compareOrientations(par, perp, square, pattern) {
  if (square) return { better: 'parallel', note: 'Square tile: orientation makes no difference.' };
  const sc = (l) => (l.smallestCut ? l.smallestCut.inches : Infinity);
  const wasteDiff = par.waste.actualPct - perp.waste.actualPct;
  let better, why;
  if (Math.abs(wasteDiff) > 0.5) {
    better = wasteDiff < 0 ? 'parallel' : 'perpendicular';
    why = `less waste (${par.waste.actualPct.toFixed(1)}% parallel vs ${perp.waste.actualPct.toFixed(1)}% perpendicular)`;
  } else if (Math.abs(sc(par) - sc(perp)) > 1 / 16) {
    better = sc(par) > sc(perp) ? 'parallel' : 'perpendicular';
    why = `a bigger smallest cut (${formatInches(sc(par))} parallel vs ${formatInches(sc(perp))} perpendicular)`;
  } else if (par.counts.cut !== perp.counts.cut) {
    better = par.counts.cut < perp.counts.cut ? 'parallel' : 'perpendicular';
    why = `fewer cuts (${par.counts.cut} parallel vs ${perp.counts.cut} perpendicular)`;
  } else {
    better = 'parallel';
    why = 'the two come out the same, so the long side runs with the long wall';
  }
  if (pattern === 'herringbone') {
    return { better, note: `Herringbone runs tiles both ways, so orientation only mirrors the chevrons; ${better} comes out with ${why}.` };
  }
  if (pattern === 'diagonal') {
    return { better, note: `${better === 'parallel' ? 'Long side of the tile rising toward the long wall' : 'Long side of the tile rising away from the long wall'}: ${why}.` };
  }
  return { better, note: `${better === 'parallel' ? 'Long side of the tile along the long wall' : 'Long side of the tile across the long wall'}: ${why}.` };
}
