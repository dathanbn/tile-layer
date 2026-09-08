import { computeLayout, optimizeLayout, measurement, formatFeetInches, rectangle, lShape } from './layout.js';
import { renderPlan, renderStepFigure, renderRoomPreview } from './draw.js';

const BOX_PIECES = 8;
const LEFT_OF = { north: 'west', south: 'east', east: 'north', west: 'south' };
const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };
// The corner diagonally opposite where the chalk lines cross, so the notch
// never lands where the first full tile needs to go.
const NOTCH_CORNER = { north: 'southeast', south: 'northwest', east: 'southwest', west: 'northeast' };

let state = {
  screen: 'space', method: 'type', shape: 'rect',
  wFt: 10, wIn: 0, lFt: 12, lIn: 0, nWFt: 4, nLFt: 5,
  focal: 'north', obstacles: [], selectedObstacle: null,
  desc: '', parsed: null, parseFailed: false,
  tileW: 24, tileL: 12, thick: 0.375, rectified: true, grout: 0.125,
  pattern: 'running', offset: 0, offsetKind: 'half',
  step: 0, saveOpen: false, saveId: makeId(), customId: '', loadId: '', copied: false,
};

const anim = { cur: 50, vel: 0 };
let swatchCanvas = null;
let rafHandle = null;

function setState(patch) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  render();
}
function bump(k, d, min, max) {
  setState(s => ({ [k]: Math.max(min, Math.min(max, s[k] + d)) }));
}

// ---------------------------------------------------------------------------
// geometry adapter — state in, layout.js's computeLayout() out
// ---------------------------------------------------------------------------

function W(s) { return s.wFt * 12 + s.wIn; }
function L(s) { return s.lFt * 12 + s.lIn; }

function off(s) {
  if (s.offsetKind === 'custom') return s.offset;
  return { half: 50, zigzag: 33, stair: 33, stacked: 0 }[s.offsetKind];
}
function offsetPatternFor(kind) {
  if (kind === 'zigzag') return 'zigzag';
  if (kind === 'stair') return 'drift';
  return 'alternate'; // half, stacked, custom: the ordinary two-row bond
}
function isSquare(s) { return Math.max(s.tileW, s.tileL) / Math.min(s.tileW, s.tileL) < 1.4; }

/**
 * Obstacles now carry a real (x, y) — set when added (centered, staggered)
 * and moved by tapping the room preview on the Space screen. Clamp at read
 * time in case the room shrank since it was placed.
 */
function placedObstacles(obstacles, w, h) {
  return obstacles.map(o => ({
    x: Math.max(0, Math.min(o.x, Math.max(0, w - o.w))),
    y: Math.max(0, Math.min(o.y, Math.max(0, h - o.d))),
    width: o.w, height: o.d, label: o.label,
  }));
}

function notchDims(s, width, height) {
  return { width: Math.min(s.nWFt * 12, width - 1), height: Math.min(s.nLFt * 12, height - 1), corner: NOTCH_CORNER[s.focal] };
}

/** The room outline as drawable points — same shape computeLayout() sees. */
function roomPolygon(s) {
  const width = W(s), height = L(s);
  if (s.shape !== 'ell') return rectangle(width, height);
  const n = notchDims(s, width, height);
  return lShape(width, height, n.width, n.height, n.corner);
}

function calc(s) {
  const width = W(s), height = L(s);
  const room = s.shape === 'ell'
    ? { width, height, notch: notchDims(s, width, height) }
    : { width, height };
  const offsetPct = off(s);
  const result = computeLayout({
    room,
    tile: { width: s.tileW, height: s.tileL, rectified: s.rectified },
    grout: s.grout,
    pattern: s.pattern,
    offset: s.pattern === 'running' ? Math.abs(offsetPct) / 100 : 0,
    offsetPattern: offsetPatternFor(s.offsetKind),
    focalWall: s.focal,
    obstacles: placedObstacles(s.obstacles, width, height),
    tilesPerBox: BOX_PIECES,
  });
  const Lo = result.layout;
  const cover = BOX_PIECES * (s.tileW * s.tileL) / 144;
  return { result, W: width, L: height, layout: Lo, cover, offsetPct };
}

function wallText(layout, wall) {
  const entry = layout.cutsByWall[wall];
  if (!entry || !entry.values.length) return null;
  return entry.values.map(v => v.displayInches).join(' / ');
}

// ---------------------------------------------------------------------------
// which setup lays easiest — layout.js ranks them, this decides what to offer
// ---------------------------------------------------------------------------

/**
 * Every setup this app can actually apply, written in the app's own
 * vocabulary. optimizeLayout() hands the extra fields back untouched on the
 * winning entry, so "use this one" is a setState of exactly these keys and
 * the optimizer can never recommend something the buttons cannot express.
 */
function setupVariants(s) {
  const v = [
    { pattern: 'stack', offsetKind: null, label: 'stack bond' },
    { pattern: 'running', offset: 0.5, offsetPattern: 'alternate', offsetKind: 'half', label: 'running bond, 50%' },
    { pattern: 'diagonal', offsetKind: null, label: '45° diagonal' },
  ];
  if (!isSquare(s)) {
    v.push({ pattern: 'running', offset: 1 / 3, offsetPattern: 'zigzag', offsetKind: 'zigzag', label: 'running bond, 33% zigzag' });
    v.push({ pattern: 'running', offset: 1 / 3, offsetPattern: 'drift', offsetKind: 'stair', label: 'running bond, 33% staircase' });
    v.push({ pattern: 'herringbone', offsetKind: null, label: 'herringbone' });
  }
  // whatever the slider is on, so a custom offset is always in the running
  if (s.pattern === 'running' && s.offsetKind === 'custom') {
    const pct = Math.abs(off(s));
    v.push({ pattern: 'running', offset: pct / 100, offsetPattern: 'alternate', offsetKind: 'custom', offsetValue: s.offset, label: `running bond, ${pct}% custom` });
  }
  return v;
}

// Ranking every setup means laying out the room once per setup, so hold the
// answer until something that could change it changes.
let rankCache = { key: null, value: null };

function ranking(s) {
  const key = JSON.stringify([
    s.shape, s.wFt, s.wIn, s.lFt, s.lIn, s.nWFt, s.nLFt, s.focal,
    s.tileW, s.tileL, s.rectified, s.grout, s.pattern, s.offsetKind, s.offset,
    s.obstacles.map(o => [o.w, o.d, o.x, o.y]),
  ]);
  if (rankCache.key === key) return rankCache.value;
  const width = W(s), height = L(s);
  const value = optimizeLayout({
    room: s.shape === 'ell' ? { width, height, notch: notchDims(s, width, height) } : { width, height },
    tile: { width: s.tileW, height: s.tileL, rectified: s.rectified },
    grout: s.grout,
    pattern: s.pattern,
    offset: s.pattern === 'running' ? Math.abs(off(s)) / 100 : 0,
    offsetPattern: offsetPatternFor(s.offsetKind),
    focalWall: s.focal,
    obstacles: placedObstacles(s.obstacles, width, height),
    tilesPerBox: BOX_PIECES,
  }, { variants: setupVariants(s) });
  rankCache = { key, value };
  return value;
}

/** Apply a ranked entry: the fields it carried in are the fields to set. */
function useSetup(entry) {
  setState({
    pattern: entry.pattern,
    ...(entry.offsetKind ? { offsetKind: entry.offsetKind } : {}),
    ...(entry.offsetKind === 'custom' ? { offset: entry.offsetValue } : {}),
    step: 0,
  });
}

// ---------------------------------------------------------------------------
// warnings — layout.js already writes plain-language strings
// ---------------------------------------------------------------------------

function warnings(c) {
  return c.layout.warnings;
}

// ---------------------------------------------------------------------------
// lay-it steps, built from the same chalk-line/start-here data the plan uses
// ---------------------------------------------------------------------------

function steps(s, c) {
  const Lo = c.layout;
  const wall = s.focal, opp = OPPOSITE[wall];
  const lineA = Lo.lines[0], lineB = Lo.lines[1];
  // A diagonal layout's lines run corner to corner, so they have endpoints
  // rather than an offset off a wall — asking for "0 inches from the north
  // wall" would be nonsense. The engine's own sentence carries the detail.
  const lineStep = (line, first) => {
    const kicker = first ? 'first line' : 'second line';
    const figure = first ? 'lineA' : 'lineB';
    if (line.endpoints) {
      return { kicker, figure, body: line.description, numLabel: '', numValue: '',
        title: first ? 'Snap your first line at 45° across the room.' : 'Snap the second line at 45°, square to the first.' };
    }
    const from = line.from ?? (first ? wall : LEFT_OF[wall]);
    const display = line.display ?? measurement(line.inches ?? 0).display;
    return { kicker, figure, body: line.description, numLabel: `from the ${from} wall`, numValue: display,
      title: first ? `Snap your first line ${display} from the ${from} wall.` : `Snap the cross line ${display} from the ${from} wall.` };
  };
  const arr = [
    lineStep(lineA, true),
    lineStep(lineB, false),
    { kicker: 'first tile', figure: 'start', title: 'Set your first tile where the two lines cross.', body: Lo.start.description, numLabel: '', numValue: '' },
  ];
  const fieldBody = s.pattern === 'running'
    ? (s.offsetKind === 'stair'
      ? `Step each course ${Lo.rows.shiftPerCourse.displayInches} the same direction, then repeat. Back-butter, then set with a twist so the ridges collapse flat.`
      : s.offsetKind === 'zigzag'
        ? `Step ${Lo.rows.shiftPerCourse.displayInches} out for two courses, then back for two. Back-butter, then set with a twist so the ridges collapse flat.`
        : `Shift every second course ${Lo.rows.shiftPerCourse.displayInches} — that is your ${Math.abs(off(s))}% offset. Back-butter, then set with a twist so the ridges collapse flat.`)
    : 'Keep joints continuous both directions. Back-butter, then set with a twist so the ridges collapse flat.';
  arr.push({
    kicker: 'the field', figure: 'field',
    title: `Lay the field: ${Lo.counts.full} full tiles.`,
    body: fieldBody,
    numLabel: s.pattern === 'running' ? 'course shift' : 'full tiles',
    numValue: s.pattern === 'running' ? Lo.rows.shiftPerCourse.displayInches : String(Lo.counts.full),
  });
  const sideWall = LEFT_OF[wall];
  const sideText = wallText(Lo, sideWall) || wallText(Lo, OPPOSITE[sideWall]) || '—';
  const endText = wallText(Lo, opp) || wallText(Lo, wall) || '—';
  // A diagonal or herringbone field meets the wall at an angle, so there is no
  // one repeated cut width to name — every piece is its own measurement.
  const repeats = sideText !== '—' || endText !== '—';
  arr.push({
    kicker: 'the cuts', figure: 'cuts',
    title: repeats
      ? `Cut the perimeter: ${sideText} at the side walls, ${endText} at the ${opp} wall.`
      : `Cut the perimeter: ${Lo.counts.cut} pieces, no two the same.`,
    body: repeats
      ? 'Measure each one at the wall rather than trusting the plan — framing wanders. Leave a 1/4" gap at every wall for movement; the baseboard covers it.'
      : 'The field meets the wall at an angle, so every piece is its own measurement. Cut them one at a time off the wall itself, and leave a 1/4" gap for movement; the baseboard covers it.',
    numLabel: 'cut tiles', numValue: String(Lo.counts.cut),
  });
  if (s.obstacles.length) {
    arr.push({ kicker: 'obstacles', figure: 'obstacles', title: `Scribe around the ${s.obstacles.map(o => o.label.toLowerCase()).join(' and ')}.`,
      body: 'Hold a full tile in place, mark the cut off the obstacle itself, and keep the joint lines running through as if it were not there.',
      numLabel: 'pieces to scribe', numValue: String(Lo.counts.obstacle) });
  }
  arr.push({ kicker: 'before you grout', figure: 'done', title: 'Wait 24 hours, then pull the spacers and check every joint.',
    body: 'Sound the field with a knuckle for hollow tiles while the thinset is still green enough to lift one.', numLabel: '', numValue: '' });
  return arr;
}

// ---------------------------------------------------------------------------
// misc helpers ported from the design's logic class
// ---------------------------------------------------------------------------

function parse(str) {
  const t = str.toLowerCase().replace(/[–—]/g, '-').trim();
  if (!t) return null;
  const parts = t.split(/\s*(?:x|by|\*)\s*/);
  if (parts.length < 2) return null;
  const one = (p) => {
    const nums = p.match(/(\d+(?:\.\d+)?(?:\s*\d+\/\d+)?)\s*(feet|foot|ft|'|inches|inch|in|")?/g);
    if (!nums) return null;
    let inches = 0, saw = false;
    nums.forEach(chunk => {
      const m = chunk.match(/(\d+(?:\.\d+)?)(?:\s*(\d+)\/(\d+))?\s*(feet|foot|ft|'|inches|inch|in|")?/);
      if (!m) return;
      let v = parseFloat(m[1]);
      if (m[2]) v += parseInt(m[2], 10) / parseInt(m[3], 10);
      const u = (m[4] || '').trim();
      if (u === 'in' || u === 'inch' || u === 'inches' || u === '"') { inches += v; saw = true; }
      else if (u) { inches += v * 12; saw = true; }
      else { inches += v * 12; }
    });
    if (!saw && /inch|inches|"/.test(p) === false) {
      const bare = parseFloat(p);
      if (!isNaN(bare) && bare > 40) inches = bare;
    }
    return inches || null;
  };
  const a = one(parts[0]), b = one(parts[1]);
  if (!a || !b) return null;
  const unitNote = /inch|"/.test(t) || (parseFloat(parts[0]) > 40) ? 'inches' : 'feet';
  return { w: a, l: b, unitNote };
}

function makeId() {
  const a = ['kerf', 'slate', 'chalk', 'float', 'notch', 'screed', 'plumb', 'bullnose', 'trowel', 'snap'];
  const b = ['plumb', 'level', 'square', 'true', 'wet', 'dry', 'bright', 'flat'];
  const c = ['jamb', 'sill', 'course', 'joint', 'bed', 'line', 'ledge', 'reveal'];
  const p = list => list[Math.floor(Math.random() * list.length)];
  return `${p(a)}-${p(b)}-${p(c)}`;
}

function presetKinds(s) {
  const half = { kind: 'half', label: '50%', note: 'half bond' };
  const stacked = { kind: 'stacked', label: '0%', note: 'stacked' };
  if (isSquare(s)) return [half, stacked];
  return [half, { kind: 'zigzag', label: '33%', note: 'zigzag' }, { kind: 'stair', label: '33%', note: 'staircase' }, stacked];
}

// ---------------------------------------------------------------------------
// save / load — localStorage only, matches "everything lives in this browser"
// ---------------------------------------------------------------------------

function saveState(id) {
  try { localStorage.setItem('tile-layer:' + id, JSON.stringify(state)); } catch {}
}
function loadState(id) {
  try {
    const raw = localStorage.getItem('tile-layer:' + id);
    if (!raw) return false;
    const loaded = JSON.parse(raw);
    state = { ...state, ...loaded, saveOpen: false, loadId: id, copied: false };
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// action registry — rebuilt fresh every render, like the mockup's renderVals()
// ---------------------------------------------------------------------------

let actions = {};
let actionSeq = 0;
function act(fn) { const key = 'a' + (actionSeq++); actions[key] = fn; return key; }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// ---------------------------------------------------------------------------
// screen renderers
// ---------------------------------------------------------------------------

function stepperRow(label, readout, parts) {
  return `<div style="margin-bottom:18px;">
    <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:8px;">
      <span class="field-label">${esc(label)}</span>
      <span style="font-family:var(--mono); font-size:13px; color:var(--blue);">${esc(readout)}</span>
    </div>
    <div style="display:grid; grid-template-columns:${parts.length > 1 ? '1fr 1fr' : '1fr'}; gap:10px;">
      ${parts.map(p => `
        <div class="stepper">
          <button class="dec" data-act="${act(() => p.dec())}">−</button>
          <div class="mid"><div class="val">${p.value}</div><div class="unit">${esc(p.unit)}</div></div>
          <button class="inc" data-act="${act(() => p.inc())}">+</button>
        </div>`).join('')}
    </div>
  </div>`;
}

function screenSpace(s, c) {
  const methods = [['type', 'Type it'], ['trace', 'Trace it'], ['describe', 'Describe it']];
  const shapes = [['rect', 'Rectangle', 0], ['ell', 'L-shape', 13]];
  let html = `<h1 class="title">Define the space</h1>
  <p class="deck">Measure wall to wall at the floor, not at the baseboard. Any of the three ways below gets you the same plan.</p>
  <div class="method-switch">
    ${methods.map(([k, label]) => {
      const on = s.method === k;
      return `<button style="background:${on ? 'var(--ground)' : 'var(--ink)'};color:${on ? 'var(--ink)' : '#fff'};" data-act="${act(() => setState({ method: k }))}">${esc(label)}</button>`;
    }).join('')}
  </div>`;

  if (s.method === 'type') {
    html += `<div style="padding-top:22px;">
      <div class="field-label" style="margin-bottom:10px;">Room shape</div>
      <div style="display:flex; gap:10px; margin-bottom:24px;">
        ${shapes.map(([k, label, notch]) => {
          const on = s.shape === k;
          return `<button style="flex:1; display:flex; align-items:center; gap:12px; background:#fff; border:1px solid ${on ? '#15181B' : '#C9CEC6'}; box-shadow:${on ? 'inset 0 0 0 2px #15181B' : 'none'}; border-radius:2px; padding:12px;" data-act="${act(() => setState({ shape: k }))}">
            <div style="width:34px; height:26px; position:relative;">
              <div style="position:absolute; inset:0; background:${on ? 'var(--blue)' : 'var(--hairline)'};"></div>
              <div style="position:absolute; right:0; top:0; width:${notch}px; height:11px; background:#fff;"></div>
            </div>
            <span style="font-size:14px; font-weight:600;">${esc(label)}</span>
          </button>`;
        }).join('')}
      </div>
      ${stepperRow('Wall to wall, side to side', `${formatFeetInches(c.W)}  ·  ${Math.round(c.W)} in`, [
        { value: s.wFt, unit: 'feet', inc: () => bump('wFt', 1, 1, 80), dec: () => bump('wFt', -1, 1, 80) },
        { value: s.wIn, unit: 'inches', inc: () => bump('wIn', 1, 0, 11), dec: () => bump('wIn', -1, 0, 11) },
      ])}
      ${stepperRow('Wall to wall, front to back', `${formatFeetInches(c.L)}  ·  ${Math.round(c.L)} in`, [
        { value: s.lFt, unit: 'feet', inc: () => bump('lFt', 1, 1, 80), dec: () => bump('lFt', -1, 1, 80) },
        { value: s.lIn, unit: 'inches', inc: () => bump('lIn', 1, 0, 11), dec: () => bump('lIn', -1, 0, 11) },
      ])}
      ${s.shape === 'ell' ? stepperRow('Notch taken out of the corner', `${s.nWFt}' × ${s.nLFt}'`, [
        { value: s.nWFt, unit: 'feet wide', inc: () => bump('nWFt', 1, 1, 40), dec: () => bump('nWFt', -1, 1, 40) },
        { value: s.nLFt, unit: 'feet deep', inc: () => bump('nLFt', 1, 1, 40), dec: () => bump('nLFt', -1, 1, 40) },
      ]) : ''}
    </div>`;
  } else if (s.method === 'trace') {
    html += `<div style="padding-top:22px;">
      <div class="field-label" style="margin-bottom:10px;">1 · Drop in a plan or a photo of one</div>
      <div class="trace-drop">
        <div class="mono-note">floor plan / photo</div>
        <button class="btn-outline" style="background:#fff;">Choose a file</button>
        <div class="mono-note">stays on this phone</div>
      </div>
      <div class="chalk-rule blue" style="margin:22px 0;"></div>
      <div class="field-label" style="margin-bottom:6px;">2 · Set the scale</div>
      <p class="deck" style="max-width:none;">Tap two points you know the real distance between — a doorway, a countertop run — then type that distance.</p>
      <div style="display:flex; gap:10px;">
        <div style="flex:1; display:flex; align-items:center; background:#fff; border:1px solid var(--hairline); height:56px; border-radius:2px; padding:0 14px;">
          <input placeholder="36" style="border:0; outline:0; width:100%; font-family:var(--mono); font-size:20px; font-weight:600;">
          <span class="mono-note">in</span>
        </div>
        <button class="btn-dark">Set scale</button>
      </div>
      <div class="chalk-rule blue" style="margin:22px 0;"></div>
      <div class="field-label" style="margin-bottom:6px;">3 · Trace the walls</div>
      <p class="deck" style="max-width:none;">Tap each inside corner in order. Close the loop on the corner you started from.</p>
      <div class="trace-preview"><div class="mono-note" style="line-height:1.6;">traced outline preview<br>4:3 placeholder</div></div>
    </div>`;
  } else {
    const parsed = s.parsed;
    html += `<div style="padding-top:22px;">
      <div class="field-label" style="margin-bottom:8px;">Type the room the way you'd say it</div>
      <input class="describe-input" data-focus-id="desc" value="${esc(s.desc)}" placeholder="12 ft by 10 ft 6 in" data-act-input="${act(e => {
        const v = e.target.value;
        const p = parse(v);
        setState({ desc: v, parsed: p, parseFailed: v.length > 3 && !p });
      })}">
      <div class="mono-note" style="margin-top:8px; line-height:1.7;">10x12 · 10 by 12 · 12 ft by 10 ft 6 in · 120 x 144 inches</div>
      ${parsed ? `<div class="parse-block">
        <div style="padding:14px 16px; border-bottom:1px solid var(--hairline-2);">
          <div class="mono-note" style="margin-bottom:6px;">read as</div>
          <div style="font-size:22px; font-weight:800; letter-spacing:-0.01em;">${formatFeetInches(parsed.w)}  ×  ${formatFeetInches(parsed.l)}</div>
          <div style="font-size:13px; color:var(--muted); margin-top:4px;">Taken as ${parsed.unitNote}, ${Math.round(parsed.w)} × ${Math.round(parsed.l)} inches. Fix either number below.</div>
        </div>
        <div style="padding:14px 16px; display:grid; grid-template-columns:1fr 1fr; gap:10px;">
          <div><div class="mono-note" style="margin-bottom:6px;">side to side (in)</div>
            <input class="text-field" style="height:52px;" data-focus-id="parseW" value="${Math.round(parsed.w)}" data-act-input="${act(e => setState({ parsed: { ...parsed, w: parseFloat(e.target.value) || 0 } }))}"></div>
          <div><div class="mono-note" style="margin-bottom:6px;">front to back (in)</div>
            <input class="text-field" style="height:52px;" data-focus-id="parseL" value="${Math.round(parsed.l)}" data-act-input="${act(e => setState({ parsed: { ...parsed, l: parseFloat(e.target.value) || 0 } }))}"></div>
        </div>
        <button style="width:100%; border:0; border-top:1px solid var(--hairline-2); background:var(--blue); color:#fff; padding:16px; font-size:15px; font-weight:700;" data-act="${act(() => {
          if (!parsed) return;
          setState({ wFt: Math.floor(parsed.w / 12), wIn: Math.round(parsed.w % 12), lFt: Math.floor(parsed.l / 12), lIn: Math.round(parsed.l % 12), method: 'type' });
        })}">Use these dimensions</button>
      </div>` : ''}
      ${s.parseFailed ? `<div class="parse-fail">Couldn't find two dimensions in that. Give it a width and a length, like <span style="font-family:var(--mono);">11 ft 4 in by 9 ft</span>.</div>` : ''}
    </div>`;
  }

  html += `<div class="chalk-rule" style="margin:28px 0 22px;"></div>
  <div class="section-head"><span class="field-label">Focal wall</span><span class="mono-note">optional</span></div>
  <p class="deck" style="max-width:none;">The wall you see first walking in. Full tiles go there; cuts get pushed to the far side. Set to north unless you change it.</p>
  <div class="wall-grid">
    ${['north', 'east', 'south', 'west'].map(w => `<button class="wall-btn${s.focal === w ? ' on' : ''}" data-act="${act(() => setState({ focal: w }))}">${w[0].toUpperCase()}${w.slice(1)}</button>`).join('')}
  </div>
  <div style="display:flex; justify-content:space-between; align-items:baseline; margin:26px 0 10px;">
    <div class="section-head" style="margin:0;"><span class="field-label">Obstacles</span><span class="mono-note">optional</span></div>
    <div class="mono-note">tile stops here</div>
  </div>
  <div style="display:flex; gap:8px; flex-wrap:wrap;">
    ${[['Island', 72, 36], ['Column', 12, 12], ['Hearth', 54, 20]].map(([label, w, d]) => `<button class="obstacle-chip" data-act="${act(() => addObstacle(label, w, d))}">+ ${label}</button>`).join('')}
  </div>
  ${s.obstacles.map(o => {
    const selected = s.selectedObstacle === o.id;
    return `<div class="obstacle-row${selected ? ' selected' : ''}" data-obstacle-id="${o.id}" data-act="${act(() => setState({ selectedObstacle: o.id }))}">
    <div class="obstacle-swatch"></div>
    <div style="flex:1;">
      <div class="name">${esc(o.label)}</div>
      <div class="size">${o.w}" × ${o.d}" — tile stops at its edge</div>
      ${selected ? `<div style="display:flex; gap:8px; margin-top:10px;">
        <div style="flex:1;">
          <div class="mono-note" style="margin-bottom:4px;">width</div>
          <div class="stepper mini">
            <button class="dec" data-act="${act(() => resizeObstacle(o.id, 'w', -6))}">−</button>
            <div class="mid"><div class="val">${o.w}"</div></div>
            <button class="inc" data-act="${act(() => resizeObstacle(o.id, 'w', 6))}">+</button>
          </div>
        </div>
        <div style="flex:1;">
          <div class="mono-note" style="margin-bottom:4px;">depth</div>
          <div class="stepper mini">
            <button class="dec" data-act="${act(() => resizeObstacle(o.id, 'd', -6))}">−</button>
            <div class="mid"><div class="val">${o.d}"</div></div>
            <button class="inc" data-act="${act(() => resizeObstacle(o.id, 'd', 6))}">+</button>
          </div>
        </div>
      </div>` : ''}
    </div>
    <button data-act="${act(() => setState(st => {
      const obstacles = st.obstacles.filter(x => x.id !== o.id);
      return { obstacles, selectedObstacle: st.selectedObstacle === o.id ? (obstacles[0] && obstacles[0].id) : st.selectedObstacle };
    }))}">×</button>
  </div>`;
  }).join('')}
  ${s.obstacles.length ? `<div style="margin-top:12px;">
    <div class="mono-note" style="margin-bottom:6px;" id="obstacle-hint">drag the shape, or tap the plan to move it there — ${esc((s.obstacles.find(o => o.id === s.selectedObstacle) || s.obstacles[0]).label)}</div>
    <div class="drawing-frame" style="margin-top:0;">
      <div class="drawing-body" id="room-preview"></div>
    </div>
  </div>` : ''}`;
  return html;
}

function updateObstacleSelectionUI(id) {
  document.querySelectorAll('[data-obstacle-id]').forEach(el => {
    el.classList.toggle('selected', el.dataset.obstacleId === String(id));
  });
  const hint = document.getElementById('obstacle-hint');
  const o = state.obstacles.find(x => x.id === id);
  if (hint && o) hint.textContent = `drag the shape, or tap the plan to move it there — ${o.label}`;
}

function pickObstaclePoint(x, y) {
  setState(st => {
    const id = st.selectedObstacle ?? (st.obstacles[0] && st.obstacles[0].id);
    if (id == null) return {};
    const width = W(st), height = L(st);
    const obstacles = st.obstacles.map(o => o.id !== id ? o : {
      ...o,
      x: Math.max(0, Math.min(width - o.w, x - o.w / 2)),
      y: Math.max(0, Math.min(height - o.d, y - o.d / 2)),
    });
    return { obstacles, selectedObstacle: id };
  });
}

function moveObstacle(id, x, y) {
  setState(st => {
    const width = W(st), height = L(st);
    const obstacles = st.obstacles.map(o => o.id !== id ? o : {
      ...o,
      x: Math.max(0, Math.min(width - o.w, x)),
      y: Math.max(0, Math.min(height - o.d, y)),
    });
    return { obstacles, selectedObstacle: id };
  });
}

function resizeObstacle(id, dim, delta) {
  setState(st => {
    const width = W(st), height = L(st);
    const obstacles = st.obstacles.map(o => {
      if (o.id !== id) return o;
      const nextW = dim === 'w' ? Math.max(6, Math.min(width, o.w + delta)) : o.w;
      const nextD = dim === 'd' ? Math.max(6, Math.min(height, o.d + delta)) : o.d;
      return {
        ...o, w: nextW, d: nextD,
        x: Math.max(0, Math.min(width - nextW, o.x)),
        y: Math.max(0, Math.min(height - nextD, o.y)),
      };
    });
    return { obstacles };
  });
}

function addObstacle(label, w, d) {
  setState(st => {
    const width = W(st), height = L(st);
    const n = st.obstacles.length;
    const stagger = 14 * n;
    const x = Math.max(0, Math.min(width - w, (width - w) / 2 + stagger));
    const y = Math.max(0, Math.min(height - d, (height - d) / 2 + stagger));
    const id = Math.random();
    return { obstacles: [...st.obstacles, { label, w, d, id, x, y }], selectedObstacle: id };
  });
}

function screenTile(s, c) {
  const tileDims = [
    { label: 'tile length (in)', key: 'tileW' },
    { label: 'tile width (in)', key: 'tileL' },
  ];
  const thicknesses = [[0.25, '1/4"'], [0.375, '3/8"'], [0.5, '1/2"']];
  const grouts = [[0.0625, '1/16"'], [0.125, '1/8"'], [0.1875, '3/16"'], [0.25, '1/4"']].filter(([v]) => s.rectified || v >= 0.125);
  const patterns = [
    ['stack', 'Stack bond', 'joints line up both ways'],
    ['running', 'Running bond', 'every other course shifts'],
    ['diagonal', '45° diagonal', 'field turned on the square'],
    ...(isSquare(s) ? [] : [['herringbone', 'Herringbone', 'pairs at right angles']]),
  ];
  const offNow = off(s);
  const previewTitle = s.pattern === 'running' ? 'Course offset' : 'Pattern preview';
  const offsetLabel = s.pattern !== 'running'
    ? ({ stack: 'stack', diagonal: '45°', herringbone: 'herringbone' })[s.pattern]
    : (s.offsetKind === 'custom' ? (offNow > 0 ? '+' : '') + offNow + '%' : offNow + '%');
  const shiftIn = c.layout.rows ? c.layout.rows.shiftPerCourse.displayInches : '0"';
  const offsetDir = offNow === 0 ? 'no shift' : (offNow > 0 ? 'stepping right' : 'stepping left');
  const offsetAdvice = s.pattern !== 'running'
    ? ({ stack: 'Joints run straight through both directions. Any bow in the tile shows up as a wandering grout line.',
         diagonal: 'The field turns 45° to the walls, so every perimeter tile is a mitre. Snap your control lines on the diagonal, not the walls.',
         herringbone: 'Pairs sit at right angles, so the field wants a 45° or 90° start line off the focal wall. Dry-lay the first three pairs.' })[s.pattern]
    : (Math.abs(offNow) > 33 && Math.max(s.tileW, s.tileL) >= 15
      ? `At ${Math.abs(offNow)}% on a ${s.tileW}" tile you are setting the crown of one tile against the end of the next. Most makers cap this at 33%.`
      : (offNow === 0
        ? 'Joints run straight through both directions. Any bow in the tile shows up as a wandering grout line.'
        : (s.offsetKind === 'zigzag'
          ? `Courses step over ${shiftIn}, out and back, so the joints never walk off in one direction. Mark all four course positions on your first tile.`
          : s.offsetKind === 'stair'
            ? `Each course steps ${shiftIn} the same way, so the joints climb across the room. Sight down the staircase every third course to keep it true.`
            : `Each course steps over ${shiftIn}. Mark that on your first course so you are not eyeballing it at course nine.`)));

  return `<h1 class="title">Pick the tile</h1>
  <p class="deck">Measure one tile out of the box. Nominal sizes lie by up to an eighth.</p>
  <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
    ${tileDims.map(t => `<div>
      <div class="mono-note" style="margin-bottom:6px;">${t.label}</div>
      <div class="stepper small">
        <button class="dec" data-act="${act(() => bumpTile(t.key, -1))}">−</button>
        <div class="mid"><div class="val">${s[t.key]}</div></div>
        <button class="inc" data-act="${act(() => bumpTile(t.key, 1))}">+</button>
      </div>
    </div>`).join('')}
  </div>

  <div style="display:flex; gap:10px; margin-top:16px;">
    <div style="flex:1;">
      <div class="mono-note" style="margin-bottom:6px;">thickness · optional, 3/8" assumed</div>
      <div class="chip-row">
        ${thicknesses.map(([v, label]) => `<button class="chip${s.thick === v ? ' on' : ''}" style="height:50px; font-size:13px;" data-act="${act(() => setState({ thick: v }))}">${label}</button>`).join('')}
      </div>
    </div>
  </div>

  <button class="rect-toggle" data-act="${act(() => setRectified(!s.rectified))}">
    <div class="rect-box" style="background:${s.rectified ? 'var(--blue)' : 'transparent'};">${s.rectified ? '✓' : ''}</div>
    <div>
      <div style="font-size:14px; font-weight:700;">Rectified edges</div>
      <div style="font-size:13px; color:var(--muted); line-height:1.35;">${s.rectified ? 'Edges cut square after firing — tight joints are fine.' : 'Cushion edge, sizes vary. Keep the joint at 1/8" or wider.'}</div>
    </div>
  </button>

  <div style="margin-top:22px;">
    <div class="mono-note" style="margin-bottom:8px;">grout joint</div>
    <div class="chip-row">
      ${grouts.map(([v, label]) => `<button class="chip${s.grout === v ? ' on' : ''}" data-act="${act(() => setState({ grout: v }))}">${label}</button>`).join('')}
    </div>
    ${!s.rectified ? `<div style="font-size:13px; line-height:1.45; color:var(--muted); margin-top:8px;">A cushion edge needs 1/8" or wider to absorb size variation, so tighter joints are off the table.</div>` : ''}
  </div>

  <div class="chalk-rule" style="margin:26px 0 20px;"></div>
  <div class="field-label" style="margin-bottom:10px;">Pattern</div>
  <div class="pattern-grid">
    ${patterns.map(([k, label, note]) => {
      const on = s.pattern === k;
      return `<button class="pattern-btn${on ? ' on' : ''}" data-act="${act(() => setState({ pattern: k }))}">
        <div class="name">${label}</div><div class="note">${note}</div>
      </button>`;
    }).join('')}
  </div>

  <div class="offset-panel">
    <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:12px;">
      <div style="font-size:14px; font-weight:700; color:#fff; white-space:nowrap;">${previewTitle}</div>
      <div style="font-family:var(--mono); font-size:22px; font-weight:600; color:#fff;" id="offset-label">${offsetLabel}</div>
    </div>
    <canvas id="swatch"></canvas>
    ${s.pattern === 'running' ? `
    <div class="offset-presets">
      ${presetKinds(s).map(o => `<button class="offset-preset${s.offsetKind === o.kind ? ' on' : ''}" data-act="${act(() => setState({ offsetKind: o.kind }))}">
        <span class="val">${o.label}</span><span class="note">${o.note}</span>
      </button>`).join('')}
    </div>
    <button class="offset-custom-btn${s.offsetKind === 'custom' ? ' on' : ''}" data-act="${act(() => setState({ offsetKind: 'custom', offset: 0 }))}">Custom</button>
    ${s.offsetKind === 'custom' ? `
    <div style="margin-top:16px; border-top:1px solid #2C3238; padding-top:8px;">
      <input type="range" min="-50" max="50" step="1" value="${s.offset}" id="offset-range" style="width:100%; margin:8px 0 6px; height:44px;">
      <div style="display:flex; justify-content:space-between; font-family:var(--mono); font-size:11px; color:#8A939E;">
        <span>−50%</span><span style="color:var(--blue-on-dark);">0 · stacked</span><span>+50%</span>
      </div>
      <div class="mono-note" style="color:#fff; margin-top:8px;" id="offset-shift-line">${shiftIn} per course, ${offsetDir}</div>
    </div>` : ''}` : ''}
    <div style="font-size:13px; line-height:1.45; color:#C6CCD3; margin-top:12px;" id="offset-advice">${offsetAdvice}</div>
  </div>`;
}

function bumpTile(k, d) {
  setState(s => {
    const next = Math.max(2, Math.min(60, s[k] + d));
    const st = { ...s, [k]: next };
    const long = Math.max(st.tileW, st.tileL), short = Math.min(st.tileW, st.tileL);
    const square = long / short < 1.4;
    const kind = (square && (s.offsetKind === 'zigzag' || s.offsetKind === 'stair')) ? 'half' : s.offsetKind;
    return { [k]: next, offsetKind: kind, pattern: (square && s.pattern === 'herringbone') ? 'running' : s.pattern };
  });
}

function setRectified(v) {
  setState(s => ({ rectified: v, grout: (!v && s.grout < 0.125) ? 0.125 : s.grout }));
}

function screenPlan(s, c) {
  const Lo = c.layout;
  const offNow = off(s);
  const patternText = ({
    stack: 'stack bond',
    running: `running bond ${Math.abs(offNow)}%${{ zigzag: ' zigzag', stair: ' staircase' }[s.offsetKind] || ''}`,
    diagonal: '45° diagonal', herringbone: 'herringbone',
  })[s.pattern];
  const groutLabel = ([[0.0625, '1/16"'], [0.125, '1/8"'], [0.1875, '3/16"'], [0.25, '1/4"']].find(x => x[0] === s.grout) || [0, ''])[1];
  const chips = [
    `${s.tileW}×${s.tileL} tile`, patternText, `${groutLabel} joint`, s.rectified ? 'rectified' : 'cushion edge',
  ];
  const warn = warnings(c);
  const sideWall = LEFT_OF[s.focal], oppSide = OPPOSITE[sideWall];
  const endWall = s.focal, oppEnd = OPPOSITE[s.focal];
  const sideText = wallText(Lo, sideWall) || wallText(Lo, oppSide) || '—';
  const endText = wallText(Lo, endWall) || wallText(Lo, oppEnd) || '—';

  return `<div class="plan-meta">${s.shape === 'ell' ? 'L-shape' : 'Rectangle'} · focal wall ${s.focal} · ${s.obstacles.length ? s.obstacles.length + ' obstacle' + (s.obstacles.length > 1 ? 's' : '') : 'no obstacles'}</div>
  <h1 class="plan-title">${formatFeetInches(c.W)} × ${formatFeetInches(c.L)}</h1>
  <div class="plan-chips">${chips.map(t => `<span class="plan-chip">${esc(t)}</span>`).join('')}</div>

  <div class="drawing-frame">
    <div class="drawing-cap"><div class="left">plan · 1:48</div><div class="right">full tiles at the ${s.focal} wall</div></div>
    <div class="drawing-body" id="plan-drawing"></div>
    <div class="drawing-foot"><span>side cuts ${sideText}</span><span>end cuts ${endText}</span></div>
  </div>

  <div class="numbers-block">
    <div class="big-stats">
      <div class="big-stat"><div class="label">full tiles</div><div class="value">${Lo.counts.full}</div><div class="note">set these first, no saw</div></div>
      <div class="big-stat"><div class="label">cut tiles</div><div class="value" style="color:var(--red);">${Lo.counts.cut}</div><div class="note">perimeter and obstacles</div></div>
    </div>
    <div class="small-stats">
      <div class="small-stat"><div class="label">floor area</div><div class="value">${Lo.area.fieldSqFt.toFixed(1)}</div><div class="note">sq ft</div></div>
      <div class="small-stat"><div class="label">waste allowance</div><div class="value">${Lo.waste.allowancePct}%</div><div class="note">for this pattern</div></div>
      <div class="small-stat"><div class="label">tile to buy</div><div class="value">${Lo.purchase.sqFtToBuy.toFixed(1)}</div><div class="note">sq ft</div></div>
    </div>
  </div>

  <div class="buy-block">
    <div class="label">buy this</div>
    <div class="row"><div class="count">${Lo.purchase.tilesToBuy}</div><div class="unit">piece${Lo.purchase.tilesToBuy === 1 ? '' : 's'}</div></div>
    <div class="note">${Lo.counts.full} go down whole and ${Lo.counts.cut} come off the saw; the rest is the ${Lo.waste.allowancePct}% allowance. That is ${Lo.purchase.sqFtToBuy.toFixed(1)} sq ft against ${Lo.area.fieldSqFt.toFixed(1)} sq ft of floor. If the shop only sells full boxes of ${BOX_PIECES}, that is ${Lo.purchase.boxes} box${Lo.purchase.boxes === 1 ? '' : 'es'} — keep the offcuts until the job is signed off.</div>
  </div>

  ${setupBlock(s, c)}

  ${warn.length ? `<div class="warning-strip">
    <div class="warning-head"><div class="title">Check these before you snap</div><div class="count">${warn.length} thing${warn.length > 1 ? 's' : ''}</div></div>
    ${warn.map(w => `<div class="warning-row"><div class="warning-marker"></div><div class="body">${esc(w)}</div></div>`).join('')}
  </div>` : ''}`;
}

/**
 * The ranked setups, easiest first. Reads as a comparison rather than a
 * verdict: the counts are all there, so a setter who wants the diagonal for
 * how it looks can see exactly what it costs and take it anyway.
 */
function setupBlock(s, c) {
  const rank = ranking(s);
  const rows = rank.ranked.map((e) => {
    const flags = [e.isCurrent ? 'now' : '', e === rank.best ? 'easiest' : ''].filter(Boolean);
    // the trouble is what decides the order, so it has to be on the row —
    // otherwise a setup with the fewest cuts sits low in the list for no
    // visible reason
    const trouble = e.ease.slivers
      ? `<span class="bad"><b>${e.ease.slivers}</b> sliver${e.ease.slivers === 1 ? '' : 's'}</span>`
      : e.ease.defects ? '<span class="bad">lippage risk</span>' : '';
    return `<div class="setup-row${e.isCurrent ? ' now' : ''}${e === rank.best ? ' best' : ''}">
      <div class="name">${esc(e.label)}${flags.length ? `<span class="flag">${flags.join(' · ')}</span>` : ''}</div>
      <div class="figures">
        <span><b>${e.ease.cutTiles}</b> cuts</span>
        <span><b>${e.ease.cutSizes}</b> size${e.ease.cutSizes === 1 ? '' : 's'}</span>
        <span><b>${e.ease.wastePct.toFixed(0)}%</b> waste</span>
        ${trouble}
      </div>
    </div>`;
  }).join('');
  return `<div class="setup-block">
    <div class="setup-head">
      <div class="title">Easiest way to lay this</div>
      <div class="mono-note">fewest cuts, then fewest saw settings</div>
    </div>
    ${rows}
    <div class="setup-note">${esc(rank.note)}</div>
    ${rank.improved ? `<button class="btn-outline-full" style="width:100%; margin-top:12px;" data-act="${act(() => useSetup(rank.best))}">Switch to ${esc(rank.best.label)}</button>` : ''}
  </div>`;
}

// What the figure beside each instruction is showing, so the drawing is never
// left to be interpreted.
const FIGURE_CAPS = {
  lineA: 'line A, and where it sits off the wall',
  lineB: 'line B, square to A',
  start: 'the first full tile, on the crossing',
  field: 'the whole tiles, laid before any cutting',
  cuts: 'the perimeter pieces, in red',
  obstacles: 'the pieces that get scribed',
  done: 'the finished floor',
};

/**
 * Give the figure the room's own proportions so the drawing fills it, but keep
 * it between a wide letterbox and a tall portrait — a 3ft x 30ft hallway drawn
 * true to shape would be a hairline on a phone.
 */
function figureAspect(c) {
  const pad = Math.min(c.W, c.L) * 0.16;
  return Math.max(0.8, Math.min(2, (c.W + pad) / (c.L + pad))).toFixed(3);
}

function screenLay(s, c) {
  const stepList = steps(s, c);
  const step = stepList[Math.min(s.step, stepList.length - 1)];
  const idx = Math.min(s.step, stepList.length - 1);
  return `<div class="lay-head"><h1 class="title" style="margin:0;">Lay it</h1><div class="mono-note" style="font-size:13px;">step ${idx + 1} of ${stepList.length}</div></div>
  <div class="tick-bar">${stepList.map((_, i) => `<div class="tick${i <= s.step ? ' done' : ''}"></div>`).join('')}</div>
  <div class="step-card">
    <div class="kicker">${step.kicker}</div>
    <div class="title">${esc(step.title)}</div>
    <div class="step-figure">
      <div class="figure-body" id="step-figure" style="aspect-ratio:${figureAspect(c)};"></div>
      <div class="figure-cap">${esc(FIGURE_CAPS[step.figure] || '')}</div>
    </div>
    <div class="body">${esc(step.body)}</div>
    ${step.numValue ? `<div class="num-block"><div class="num-label">${esc(step.numLabel)}</div><div class="num-value">${esc(step.numValue)}</div></div>` : ''}
  </div>
  <div class="all-steps-head">all steps</div>
  ${stepList.map((x, i) => `<button class="step-row" style="border-top:1px solid var(--hairline);" data-act="${act(() => setState({ step: i }))}">
    <div class="n" style="color:${i === s.step ? 'var(--blue)' : 'var(--disabled)'};">${i + 1}</div>
    <div class="fig-mini" id="step-mini-${i}"></div>
    <div class="t" style="font-weight:${i === s.step ? '700' : '500'}; color:${i === s.step ? 'var(--ink)' : 'var(--muted-2)'};">${esc(x.title)}</div>
  </button>`).join('')}`;
}

function saveSheet(s) {
  if (!s.saveOpen) return '';
  const saveId = s.customId ? s.customId : s.saveId;
  const shareLink = `tile-layer.app/#${s.customId || s.saveId}`;
  return `<div class="save-scrim" data-act="${act(() => setState({ saveOpen: false }))}" id="scrim">
    <div class="save-sheet" id="sheet">
      <div class="head"><div style="font-size:22px; font-weight:800; letter-spacing:-0.02em;">Save this layout</div>
        <button class="x" data-act="${act(() => setState({ saveOpen: false }))}">×</button></div>
      <p>Everything lives in this browser. The ID is how you get it back on another phone.</p>
      <div class="id-block">
        <div class="mono-note">your id</div>
        <div style="font-family:var(--mono); font-size:22px; font-weight:600; letter-spacing:-0.01em; margin-top:4px; word-break:break-word;">${esc(saveId)}</div>
        <button class="reroll" data-act="${act(() => { setState({ saveId: makeId(), customId: '' }); saveState(state.customId || state.saveId); })}">Give me another</button>
      </div>
      <div style="margin-top:14px;">
        <div class="mono-note" style="margin-bottom:6px;">or type your own</div>
        <input class="text-field" data-focus-id="customId" value="${esc(s.customId)}" placeholder="hall-bath-north" data-act-input="${act(e => setState({ customId: e.target.value.replace(/\s+/g, '-').toLowerCase() }))}">
      </div>
      <div class="share-row">
        <div class="share-field"><span>${esc(shareLink)}</span></div>
        <button class="btn-dark" data-act="${act(() => {
          saveState(state.customId || state.saveId);
          if (navigator.clipboard) navigator.clipboard.writeText(shareLink).catch(() => {});
          setState({ copied: true });
          setTimeout(() => setState({ copied: false }), 1600);
        })}">${s.copied ? 'Copied' : 'Copy'}</button>
      </div>
      <div class="chalk-rule" style="margin:20px 0 16px;"></div>
      <div class="mono-note" style="margin-bottom:6px;">load an existing id</div>
      <div class="load-row">
        <input class="text-field" style="flex:1;" data-focus-id="loadId" value="${esc(s.loadId)}" placeholder="kerf-plumb-jamb" data-act-input="${act(e => setState({ loadId: e.target.value }))}">
        <button class="btn-outline-full" data-act="${act(() => { if (loadState(s.loadId.trim())) render(); else alert('No layout saved under that id on this device.'); })}">Load</button>
      </div>
      <button class="btn-primary" style="width:100%; margin-top:20px;" data-act="${act(() => { saveState(state.customId || state.saveId); setState({ saveOpen: false }); })}">Save it</button>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// shell: nav, action bar, top-level render
// ---------------------------------------------------------------------------

const NAV = [['space', 'Space'], ['tile', 'Tile'], ['plan', 'Plan'], ['lay', 'Lay']];
const ORDER = ['space', 'tile', 'plan', 'lay'];

function render() {
  actions = {};
  actionSeq = 0;
  const s = state;
  const c = calc(s);
  const warn = warnings(c);
  const idx = ORDER.indexOf(s.screen);
  const primaryLabel = s.screen === 'space' ? 'Next: pick the tile'
    : s.screen === 'tile' ? 'Build the plan'
    : s.screen === 'plan' ? 'Lay it out' + (warn.length ? ' anyway' : '')
    : (s.step >= steps(s, c).length - 1 ? 'Done — save it' : 'Next step');

  const focus = captureFocus();

  let screenHtml = '';
  if (s.screen === 'space') screenHtml = screenSpace(s, c);
  else if (s.screen === 'tile') screenHtml = screenTile(s, c);
  else if (s.screen === 'plan') screenHtml = screenPlan(s, c);
  else screenHtml = screenLay(s, c);

  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="topbar">
      <div class="wordmark">tile<span class="dot">·</span>layer</div>
      <button class="btn-outline" data-act="${act(() => setState({ saveOpen: true }))}">save / load</button>
    </div>
    <div class="step-strip">
      ${NAV.map(([k, label], i) => `<button class="step-tab${k === s.screen ? ' active' : ''}" data-act="${act(() => setState({ screen: k }))}">
        <div class="num">${i + 1}</div><div class="lbl">${label}</div>
      </button>`).join('')}
    </div>
    <div class="well">${screenHtml}</div>
    <div class="actionbar">
      ${idx > 0 ? `<button class="btn-back" data-act="${act(() => setState({ screen: ORDER[Math.max(0, idx - 1)] }))}">‹</button>` : ''}
      <button class="btn-primary" data-act="${act(() => {
        if (s.screen === 'lay') {
          const n = steps(s, c).length;
          if (s.step >= n - 1) setState({ saveOpen: true }); else setState({ step: s.step + 1 });
        } else setState({ screen: ORDER[Math.min(ORDER.length - 1, idx + 1)] });
      })}">${primaryLabel}</button>
    </div>
    ${saveSheet(s)}
  `;

  restoreFocus(focus);
  if (s.screen === 'tile') {
    swatchCanvas = document.getElementById('swatch');
    wireOffsetRange();
    startSwatchLoop();
  } else {
    stopSwatchLoop();
  }
  if (s.screen === 'plan') {
    renderPlan(document.getElementById('plan-drawing'), c.result);
  }
  if (s.screen === 'lay') {
    const stepList = steps(s, c);
    const idx = Math.min(s.step, stepList.length - 1);
    renderStepFigure(document.getElementById('step-figure'), c.result, stepList[idx].figure);
    // the same drawing in miniature against every row, so the list reads as a
    // sequence of pictures rather than a wall of sentences
    stepList.forEach((x, i) => renderStepFigure(document.getElementById(`step-mini-${i}`), c.result, x.figure));
  }
  if (s.screen === 'space' && s.obstacles.length) {
    const selected = s.selectedObstacle ?? s.obstacles[0].id;
    renderRoomPreview(document.getElementById('room-preview'), roomPolygon(s), s.obstacles, selected, {
      onSelect: updateObstacleSelectionUI,
      onDragEnd: moveObstacle,
      onPick: pickObstaclePoint,
    });
  }
}

// ---------------------------------------------------------------------------
// focus preservation across full innerHTML re-renders
// ---------------------------------------------------------------------------

function captureFocus() {
  const el = document.activeElement;
  const id = el && el.dataset ? el.dataset.focusId : null;
  if (!id) return null;
  return { id, selStart: el.selectionStart, selEnd: el.selectionEnd };
}
function restoreFocus(focus) {
  if (!focus) return;
  const el = document.querySelector(`[data-focus-id="${focus.id}"]`);
  if (!el) return;
  el.focus();
  if (typeof el.setSelectionRange === 'function' && focus.selStart != null) {
    try { el.setSelectionRange(focus.selStart, focus.selEnd); } catch {}
  }
}

// ---------------------------------------------------------------------------
// the offset slider — kept out of the normal render loop while dragging
// ---------------------------------------------------------------------------

function wireOffsetRange() {
  const range = document.getElementById('offset-range');
  if (!range) return;
  range.addEventListener('input', (e) => {
    state.offset = parseInt(e.target.value, 10);
    const offNow = off(state);
    const labelEl = document.getElementById('offset-label');
    if (labelEl) labelEl.textContent = (offNow > 0 ? '+' : '') + offNow + '%';
    const shiftIn = state.pattern === 'running' ? calc(state).layout.rows.shiftPerCourse.displayInches : '0"';
    const dirEl = document.getElementById('offset-shift-line');
    if (dirEl) dirEl.textContent = `${shiftIn} per course, ${offNow === 0 ? 'no shift' : offNow > 0 ? 'stepping right' : 'stepping left'}`;
  });
  range.addEventListener('change', () => render());
}

// ---------------------------------------------------------------------------
// the offset-preview swatch — a critically-damped spring, ported directly
// from the design's logic class
// ---------------------------------------------------------------------------

function rowStepPreview(state, r) {
  const k = state.offsetKind;
  if (k === 'zigzag') return [0, 1, 2, 1][((r % 4) + 4) % 4];
  if (k === 'stair') return ((r % 3) + 3) % 3;
  return ((r % 2) + 2) % 2;
}

function drawSwatch() {
  const cv = swatchCanvas;
  if (!cv || !cv.isConnected) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w) return;
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#0F1214'; g.fillRect(0, 0, w, h);

  const { tileW, tileL, pattern } = state;
  const ratio = tileW / tileL;
  const th = Math.min(30, h / 4.2);
  const tw = th * ratio;
  const j = Math.max(1.5, state.grout / 0.125 * 2);
  const off2 = anim.cur / 100;
  const face = '#E9EBE6', edge = '#B9BFB6';

  const tile = (x, y, ww, hh) => {
    g.fillStyle = face; g.fillRect(x, y, ww, hh);
    g.fillStyle = edge; g.fillRect(x, y + hh - 1.5, ww, 1.5);
    g.fillStyle = 'rgba(255,255,255,0.5)'; g.fillRect(x, y, ww, 1);
  };

  g.save();
  const span = w + h;
  if (pattern === 'diagonal') { g.translate(w / 2, h / 2); g.rotate(Math.PI / 4); g.translate(-span / 2, -span / 2); }

  if (pattern === 'herringbone') {
    const u = th + j, lng = 2 * th + j;
    for (let m = -40; m < 60; m++) {
      for (let n = -30; n < 30; n++) {
        const x = (m + 2 * n) * u, y = (m - 2 * n) * u;
        if (x < -3 * u || x > w + 3 * u || y < -3 * u || y > h + 3 * u) continue;
        tile(x, y, lng, th);
        tile(x + 2 * u, y - u, th, lng);
      }
    }
  } else {
    const ext = pattern === 'diagonal' ? span : 0;
    const rows = Math.ceil((h + ext) / (th + j)) + 3;
    const cols = Math.ceil((w + ext) / (tw + j)) + 5;
    for (let r = 0; r < rows; r++) {
      const shift = (pattern === 'running' ? rowStepPreview(state, r) * off2 * (tw + j) : 0);
      for (let c = -4; c < cols; c++) {
        tile(c * (tw + j) + shift, r * (th + j) + 6, tw, th);
      }
    }
  }
  g.restore();

  if (pattern === 'running' || pattern === 'stack') {
    g.strokeStyle = 'rgba(27,79,216,0.95)'; g.lineWidth = 2; g.setLineDash([7, 5]);
    const x = (tw + j) * (anim.cur / 100) + 0.5;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    g.setLineDash([]);
  }
}

function startSwatchLoop() {
  if (rafHandle) return;
  const loop = () => {
    const target = state.pattern === 'running' ? off(state) : 0;
    const a = (target - anim.cur) * 0.22 - anim.vel * 0.28;
    anim.vel += a;
    anim.cur += anim.vel;
    if (Math.abs(target - anim.cur) < 0.02 && Math.abs(anim.vel) < 0.02) { anim.cur = target; anim.vel = 0; }
    drawSwatch();
    rafHandle = requestAnimationFrame(loop);
  };
  rafHandle = requestAnimationFrame(loop);
}
function stopSwatchLoop() {
  if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = null; }
}

// ---------------------------------------------------------------------------
// event delegation — attached once to the stable root
// ---------------------------------------------------------------------------

const root = document.getElementById('app');
root.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el && actions[el.dataset.act]) actions[el.dataset.act](e);
});
root.addEventListener('input', (e) => {
  const el = e.target.closest('[data-act-input]');
  if (el && actions[el.dataset.actInput]) actions[el.dataset.actInput](e);
});

render();

