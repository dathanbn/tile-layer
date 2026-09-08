// layout.test.js — run with `node layout.test.js` (or `npm test`).
//
// Every case prints a row in a table at the end: what went in, what came
// out, and whether the assertions held. Read the table, not just the count.

import assert from 'node:assert/strict';
import {
  computeLayout, centerAxis, roundSixteenth, formatInches, formatFeetInches, lShape, rowShiftFn,
  layoutEase, easeVerdict, optimizeLayout,
} from './layout.js';

const rows = [];
let failures = 0;

function test(name, input, fn) {
  const row = { name, input, result: '', status: 'pass' };
  try {
    row.result = fn() || '';
  } catch (e) {
    failures += 1;
    row.status = 'FAIL';
    row.result = (e && e.message) || String(e);
    console.error(`\nFAIL ${name}\n${e.stack || e}`);
  }
  rows.push(row);
}

const closeTo = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);
const inches = (m) => (m ? m.displayInches : '-');
const wallVals = (layout, wall) => layout.cutsByWall[wall].values.map(v => v.rounded);

/**
 * The invariant every case must satisfy: on each axis the two walls the grid
 * was centred between report the same set of cut widths.
 */
function assertOppositeWallsEqual(result) {
  for (const key of ['parallel', 'perpendicular']) {
    const layout = result.orientations[key];
    if (!layout.axes) continue; // diagonal and herringbone have no straight wall cuts
    for (const axis of ['x', 'y']) {
      const [a, b] = layout.axes[axis].centeredBetween;
      assert.deepEqual(wallVals(layout, a), wallVals(layout, b),
        `${key}: cuts on ${a} ${JSON.stringify(wallVals(layout, a))} differ from ${b} ${JSON.stringify(wallVals(layout, b))}`);
    }
  }
}

/** After a half-module shift, C must sit in [M/2, M). */
function assertShiftInvariant(axis) {
  if (axis.shift.fraction === 0.5) {
    assert.ok(axis.C >= axis.M / 2 - 1e-9 && axis.C < axis.M, `shifted C=${axis.C} not in [${axis.M / 2}, ${axis.M})`);
  }
}

function summary(result) {
  const L = result.layout;
  const cuts = Object.entries(L.cutsByWall)
    .filter(([, v]) => v.values.length)
    .map(([w, v]) => `${w} ${v.values.map(x => x.displayInches).join('/')}`)
    .join(', ');
  const start = L.start.from.map(f => `${f.display} from ${f.wall}`).join(', ');
  return `${result.recommended}; start ${start}; full ${L.counts.full}, cut ${L.counts.cut}; `
    + `cuts: ${cuts || 'none by wall'}; smallest ${inches(L.smallestCut)}; waste ${L.waste.allowancePct}%`
    + (L.warnings.length ? `; ${L.warnings.length} warning(s)` : '');
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

test('display rounds to 1/16"', '5.15, 126.53, 11.97, 0.03', () => {
  assert.equal(formatInches(5.15), '5 1/8"');
  assert.equal(formatFeetInches(126.53), `10' 6 1/2"`);
  assert.equal(formatInches(11.97), '12"');
  assert.equal(formatInches(0.03), '0"');
  assert.equal(formatInches(5.1875), '5 3/16"');
  assert.equal(formatFeetInches(11.9999), `1' 0"`);
  assert.equal(roundSixteenth(5.15625), 5.1875);
  return '5 1/8", 10\' 6 1/2", 12", 0"';
});

// ---------------------------------------------------------------------------
// Per-axis algorithm
// ---------------------------------------------------------------------------

test('axis: room divides evenly by the module, no shift', '121.25" span, 12" tile, 1/8" joint', () => {
  const a = centerAxis(121.25, 12, 0.125);
  assert.equal(a.n, 10);
  closeTo(a.R, 0, 1e-9);
  assert.equal(a.shifted, false);
  assert.equal(a.exact, true);
  assert.equal(a.cutPiece, 0);
  return `n=${a.n}, R=${a.R}, exact fit, no cut, ${formatInches(a.wallGap)} gap at each wall`;
});

test('axis: 1" sliver forces the half-module shift', '111.125" span, 12" tile, 1/8" joint', () => {
  const a = centerAxis(111.125, 12, 0.125);
  closeTo(a.R, 2, 1e-9, 'R');
  assert.equal(a.shifted, true);
  assert.equal(a.n, 8);
  assert.ok(a.C >= a.M / 2 && a.C < a.M, `C=${a.C} not in [M/2, M)`);
  closeTo(a.C, 1 + 12.125 / 2, 1e-9, 'C');
  return `C was 1", shifted to ${formatInches(a.C)} (M/2=${formatInches(a.M / 2)}), n 9 -> 8, wall piece ${formatInches(a.cutPiece)}`;
});

test('axis: cut exactly at the threshold does not shift', '117.125" span, 12" tile, 1/8" joint (C=4=tile/3)', () => {
  const a = centerAxis(117.125, 12, 0.125);
  closeTo(a.C, 4, 1e-9);
  assert.equal(a.shifted, false);
  return `C=${formatInches(a.C)} = threshold ${a.threshold}, no shift`;
});

test('axis: span narrower than one module is a single piece', '8" span, 12" tile', () => {
  const a = centerAxis(8, 12, 0.125);
  assert.equal(a.n, 0);
  assert.equal(a.singlePiece, true);
  assert.equal(a.cutPiece, 8);
  return 'one 8" piece wall to wall';
});

test('axis: threshold never exceeds half the tile (mosaic)', '50.5" span, 3" tile, 1/8" joint', () => {
  const a = centerAxis(50.5, 3, 0.125);
  assert.equal(a.shifted, true);
  assert.equal(a.threshold, 1.5);
  assert.ok(a.cutPiece <= 3 + 1e-9, `piece ${a.cutPiece} bigger than the tile`);
  return `threshold ${a.threshold}", piece ${formatInches(a.cutPiece)}`;
});

// ---------------------------------------------------------------------------
// Whole layouts
// ---------------------------------------------------------------------------

test('reference gazebo: 120x144, 12x24, 3/16 joint', '120" x 144" room, 12x24 tile, 3/16" joint, stack, focal north, 8 per box', () => {
  const r = computeLayout({ room: { width: 120, height: 144 }, tile: { width: 12, height: 24, rectified: true }, grout: 3 / 16, pattern: 'stack', focalWall: 'north', tilesPerBox: 8 });
  assertOppositeWallsEqual(r);
  const L = r.orientations.parallel;
  assert.equal(L.axes.x.shifted, false, 'x shifted');
  assert.equal(L.axes.y.shifted, false, 'y shifted');
  closeTo(L.axes.y.C, 11.53, 0.02, 'C along the 144" axis');
  closeTo(L.axes.x.C, 5.16, 0.02, 'C along the 120" axis');
  assert.equal(L.axes.x.n, 9);
  assert.equal(L.axes.y.n, 5);
  // physical pieces are C less half a joint
  closeTo(wallVals(L, 'north')[0], roundSixteenth(11.53 - 3 / 32), 1 / 16);
  closeTo(wallVals(L, 'west')[0], roundSixteenth(5.16 - 3 / 32), 1 / 16);
  assert.equal(L.counts.full, 45);
  assert.equal(L.counts.cut, 32);
  assert.equal(L.counts.corner, 4);
  assert.equal(L.warnings.length, 0, JSON.stringify(L.warnings));
  assert.equal(r.recommended, 'parallel');
  assert.ok(r.orientations.perpendicular.counts.full > 0);
  assert.equal(L.purchase.boxes, 9);
  assert.equal(L.waste.allowancePct, 10);
  closeTo(L.area.fieldSqFt, 120, 1e-9);
  assert.equal(L.lines[0].from, 'north');
  closeTo(L.lines[0].inches, L.axes.y.C + 3 / 32, 1e-9, 'line A is the near edge of the first full course');
  closeTo(L.start.from[1].inches, L.axes.x.C + 3 / 32, 1e-9, 'start tile from the west wall');
  return summary(r) + `; C=${L.axes.y.C.toFixed(2)} (144 axis), ${L.axes.x.C.toFixed(2)} (120 axis); boxes ${L.purchase.boxes}`;
});

test('room that divides evenly: no shift, no cuts, movement-joint warning', '121.25" x 97" room, 12x12 tile, 1/8" joint', () => {
  const r = computeLayout({ room: { width: 121.25, height: 97 }, tile: { width: 12, height: 12 }, grout: 0.125, pattern: 'stack' });
  assertOppositeWallsEqual(r);
  const L = r.layout;
  assert.equal(L.axes.x.shifted, false);
  assert.equal(L.axes.y.shifted, false);
  assert.equal(L.axes.x.exact, true);
  assert.equal(L.counts.full, 80);
  assert.equal(L.counts.cut, 0);
  assert.ok(L.warnings.some(w => /movement joint/.test(w)), 'expected the movement joint warning');
  assert.ok(L.lines[0].inches >= 2, 'chalk line moved one course in');
  return summary(r);
});

test('1" sliver room: shift lands C in [M/2, M)', '111.125" x 100" room, 12x12 tile, 1/8" joint', () => {
  const r = computeLayout({ room: { width: 111.125, height: 100 }, tile: { width: 12, height: 12 }, grout: 0.125, pattern: 'stack' });
  assertOppositeWallsEqual(r);
  const L = r.layout;
  assert.equal(L.axes.x.shifted, true);
  assertShiftInvariant(L.axes.x);
  assertShiftInvariant(L.axes.y);
  assert.equal(L.axes.x.n, 8);
  assert.equal(wallVals(L, 'west').length, 1);
  closeTo(wallVals(L, 'west')[0], 7, 1e-9, 'west piece');
  assert.ok(L.smallestCut.inches >= 2, 'no sliver survives');
  assert.ok(!L.warnings.some(w => /Slivers/.test(w)));
  return summary(r) + `; x: C ${L.axes.x.C} in [${L.axes.x.M / 2}, ${L.axes.x.M})`;
});

test('room narrower than two tiles', '20" x 30" room, 12x12 tile, 1/8" joint', () => {
  const r = computeLayout({ room: { width: 20, height: 30 }, tile: { width: 12, height: 12 }, grout: 0.125, pattern: 'stack' });
  assertOppositeWallsEqual(r);
  const L = r.layout;
  assert.equal(L.axes.x.n, 0);
  assert.equal(L.axes.x.shifted, true, 'one tile plus two slivers becomes two real pieces');
  assertShiftInvariant(L.axes.x);
  assert.equal(L.counts.full, 0);
  closeTo(wallVals(L, 'west')[0], 9.9375, 1e-9);
  assert.ok(L.smallestCut.inches >= 2);
  assert.ok(/no full tile/i.test(L.start.description));
  return summary(r);
});

test('room narrower than one tile: single piece', '8" x 40" room, 12x12 tile', () => {
  const r = computeLayout({ room: { width: 8, height: 40 }, tile: { width: 12, height: 12 }, grout: 0.125, pattern: 'stack' });
  assertOppositeWallsEqual(r);
  const L = r.layout;
  assert.equal(L.axes.x.singlePiece, true);
  assert.equal(L.counts.full, 0);
  assert.equal(wallVals(L, 'west')[0], 8);
  assert.equal(wallVals(L, 'east')[0], 8);
  assert.ok(L.lines.every(l => l.inches >= 0), 'no negative chalk line');
  return summary(r);
});

test('L-shape whose legs want different origins', '144" x 120" L, 53" x 54.5" notch NE, 12x12 tile, 1/8" joint', () => {
  // Centred on the full width, the inner east wall would get a 3/4" sliver
  // and the inner north wall a 1/2" sliver. Centred on the narrow leg, the
  // east wall would get 1 3/8". The engine has to find the grid that clears
  // every wall.
  const r = computeLayout({ room: { width: 144, height: 120, notch: { width: 53, height: 54.5, corner: 'northeast' } }, tile: { width: 12, height: 12 }, grout: 0.125, pattern: 'stack' });
  assertOppositeWallsEqual(r);
  const L = r.layout;
  assert.equal(r.room.corners, 6);
  assert.equal(L.waste.allowancePct, 15, '10% + 5% for more than four corners');
  assert.ok(L.smallestCut.inches >= L.axes.x.threshold - 1e-9, `smallest cut ${L.smallestCut.inches} under threshold`);
  for (const w of ['west', 'east', 'inner east', 'north', 'south', 'inner north']) {
    assert.ok(L.cutsByWall[w].values.length > 0, `${w} has cuts`);
    assert.ok(L.cutsByWall[w].min.inches >= 2, `${w} has a sliver: ${L.cutsByWall[w].min.inches}`);
  }
  assert.equal(L.axes.x.shifted, true, 'x axis shifted to clear the inner wall');
  assertShiftInvariant(L.axes.x);
  assert.ok(!L.warnings.some(w => /Slivers/.test(w)));
  closeTo(L.area.fieldSqFt, (144 * 120 - 53 * 54.5) / 144, 1e-9);
  assert.equal(L.counts.corner, 6, 'four outside corners plus the notch corner tile');
  return summary(r);
});

test('L-shape via explicit polygon matches the shorthand', 'same L as a point list', () => {
  const a = computeLayout({ room: lShape(144, 120, 53, 54.5), tile: { width: 12, height: 12 }, grout: 0.125 });
  const b = computeLayout({ room: [[0, 0], [91, 0], [91, 54.5], [144, 54.5], [144, 120], [0, 120]], tile: { width: 12, height: 12 }, grout: 0.125 });
  assert.deepEqual(a.layout.counts, b.layout.counts);
  assert.deepEqual(a.layout.cutsByWall, b.layout.cutsByWall);
  return `${a.layout.counts.full} full, ${a.layout.counts.cut} cut both ways`;
});

test('running bond 50%: side walls take two values, lippage warning on 24" tile', '120" x 144" room, 12x24 tile, 3/16" joint, running 50%', () => {
  const r = computeLayout({ room: { width: 120, height: 144 }, tile: { width: 12, height: 24 }, grout: 3 / 16, pattern: 'running', offset: 0.5, focalWall: 'north' });
  assertOppositeWallsEqual(r);
  const L = r.layout;
  assert.equal(L.rows.axis, 'x');
  assert.equal(wallVals(L, 'west').length, 2, 'two cut widths on the west wall');
  assert.equal(wallVals(L, 'east').length, 2);
  assert.equal(wallVals(L, 'north').length, 1, 'walls parallel to the courses see one width');
  const [a, b] = wallVals(L, 'west');
  closeTo(b - a, L.axes.x.M / 2, 1 / 16, 'the two widths differ by half a module');
  assert.ok(L.warnings.some(w => /lippage/.test(w)), 'lippage warning');
  closeTo(L.rows.shiftPerCourse.inches, L.axes.x.M / 2, 1e-9);
  return summary(r);
});

test('running bond 50% avoids a sliver with a quarter-module shift', '110" x 100" room, 12x12 tile, 1/8" joint, running 50%', () => {
  // C = 7/16" here. A half-module shift only swaps which course gets the
  // sliver, so the engine must shift a quarter module instead.
  const r = computeLayout({ room: { width: 110, height: 100 }, tile: { width: 12, height: 12 }, grout: 0.125, pattern: 'running', offset: 0.5 });
  assertOppositeWallsEqual(r);
  const L = r.layout;
  assert.equal(L.axes.x.shift.fraction, 0.25, 'quarter shift');
  assert.ok(L.smallestCut.inches >= 2, `sliver survived: ${L.smallestCut.inches}`);
  assert.equal(wallVals(L, 'west').length, 2);
  return summary(r) + `; shift ${L.axes.x.shift.fraction} M`;
});

test('running bond 33%: no lippage warning, three widths per side wall', '110" x 97" room, 12x24 tile, 1/8" joint, running 1/3, focal east', () => {
  const r = computeLayout({ room: { width: 110, height: 97 }, tile: { width: 12, height: 24 }, grout: 0.125, pattern: 'running', offset: 1 / 3, focalWall: 'east' });
  assertOppositeWallsEqual(r);
  const L = r.layout;
  assert.equal(L.rows.axis, 'y', 'courses run north-south along the east focal wall');
  assert.ok(!L.warnings.some(w => /lippage/.test(w)), 'a third offset is allowed on large format');
  assert.equal(L.lines[0].from, 'east');
  assert.equal(L.lines[1].from, 'north');
  assert.ok(wallVals(L, 'north').length >= 2);
  return summary(r);
});

test('focal wall south: lines measured from south and east', '120" x 144" room, 12x24, stack, focal south', () => {
  const r = computeLayout({ room: { width: 120, height: 144 }, tile: { width: 12, height: 24 }, grout: 3 / 16, pattern: 'stack', focalWall: 'south' });
  assertOppositeWallsEqual(r);
  const L = r.layout;
  assert.equal(L.lines[0].from, 'south');
  assert.equal(L.lines[1].from, 'east');
  closeTo(L.lines[0].inches, 11.625, 1e-9);
  closeTo(L.lines[1].inches, 5.25, 1e-9);
  assert.equal(L.start.from[0].wall, 'south');
  return summary(r);
});

test('diagonal: every perimeter tile is a cut, coverage is sound', '120" x 144" room, 12x12 tile, 1/8" joint, diagonal', () => {
  const r = computeLayout({ room: { width: 120, height: 144 }, tile: { width: 12, height: 12 }, grout: 0.125, pattern: 'diagonal' });
  const L = r.layout;
  assert.equal(L.waste.allowancePct, 15);
  for (const c of L.tiles) {
    const touches = c.points.some(p => p.x < 1e-6 || p.y < 1e-6 || p.x > 120 - 1e-6 || p.y > 144 - 1e-6);
    if (touches) assert.equal(c.full, false, 'a tile reaching a wall must be a cut');
  }
  const expected = (12 * 12) / (12.125 * 12.125);
  closeTo(L.area.tileSqFtLaid / L.area.fieldSqFt, expected, 0.02, 'tile face fraction of the floor');
  assert.equal(L.lines[0].angle, 45);
  assert.equal(L.lines.length, 2);
  assert.ok(L.counts.full > 0 && L.counts.cut > 0);
  return summary(r) + `; ${L.lines[0].description}`;
});

test('herringbone: no gaps, no overlaps, coverage is sound', '60" x 50" room, 6x12 tile, 1/8" joint, herringbone', () => {
  const r = computeLayout({ room: { width: 60, height: 50 }, tile: { width: 6, height: 12 }, grout: 0.125, pattern: 'herringbone' });
  const L = r.layout;
  assert.equal(L.waste.allowancePct, 15);
  const cells = L.tiles;
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i], b = cells[j];
      const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      assert.ok(ox <= 1e-6 || oy <= 1e-6, `tiles ${i} and ${j} overlap`);
    }
  }
  const expected = (6 * 12) / (6.125 * 12.125);
  closeTo(L.area.tileSqFtLaid / L.area.fieldSqFt, expected, 0.02, 'tile face fraction of the floor');
  assert.ok(L.counts.full > 0 && L.counts.cut > 0);
  return summary(r);
});

test('orientation: both computed, better one flagged', '96" x 140" room, 6x24 plank, 1/8" joint, stack', () => {
  const r = computeLayout({ room: { width: 96, height: 140 }, tile: { width: 6, height: 24 }, grout: 0.125, pattern: 'stack' });
  assertOppositeWallsEqual(r);
  const p = r.orientations.parallel, q = r.orientations.perpendicular;
  assert.equal(p.longAxisAlong, 'y', 'parallel: 24" side runs with the 140" wall');
  assert.equal(q.longAxisAlong, 'x');
  assert.equal(p.better !== q.better, true, 'exactly one flagged');
  assert.equal(r.orientations[r.recommended].better, true);
  assert.ok(typeof p.waste.actualPct === 'number' && typeof q.waste.actualPct === 'number');
  assert.ok(p.smallestCut && q.smallestCut);
  return `${r.recommended}: ${r.orientationNote} parallel waste ${p.waste.actualPct.toFixed(1)}%/smallest ${inches(p.smallestCut)}, perpendicular ${q.waste.actualPct.toFixed(1)}%/${inches(q.smallestCut)}`;
});

test('warnings: tight joint on non-rectified tile', '120" x 144", 12x12 non-rectified, 1/16" joint', () => {
  const r = computeLayout({ room: { width: 120, height: 144 }, tile: { width: 12, height: 12, rectified: false }, grout: 1 / 16, pattern: 'stack' });
  assert.ok(r.warnings.some(w => /non-rectified/.test(w)));
  const ok = computeLayout({ room: { width: 120, height: 144 }, tile: { width: 12, height: 12, rectified: true }, grout: 1 / 16, pattern: 'stack' });
  assert.ok(!ok.warnings.some(w => /non-rectified/.test(w)));
  return r.warnings.find(w => /non-rectified/.test(w));
});

test('warnings: obstacle sliver and obstacle cut count', '120" x 144", 12x12, 1/8" joint, 12" column 1" off a joint', () => {
  const r = computeLayout({ room: { width: 120, height: 144 }, tile: { width: 12, height: 12 }, grout: 0.125, pattern: 'stack', obstacles: [{ x: 42.875, y: 40, width: 12, height: 12, label: 'column' }] });
  assertOppositeWallsEqual(r);
  const L = r.layout;
  assert.equal(L.counts.obstacle, 4);
  assert.ok(L.warnings.some(w => /against the column/.test(w)), JSON.stringify(L.warnings));
  closeTo(L.area.fieldSqFt, 119, 1e-9, 'obstacle area comes off the field');
  return summary(r);
});

test('warnings: waste above 20 percent', '20" x 30" room, 12x12 tile', () => {
  const r = computeLayout({ room: { width: 20, height: 30 }, tile: { width: 12, height: 12 }, grout: 0.125, pattern: 'stack' });
  assert.ok(r.warnings.some(w => /Waste runs to/.test(w)));
  return `${r.layout.waste.actualPct.toFixed(0)}% actual`;
});

test('boxes round up', '120" x 144", 12x24, 3/16", 8 tiles per box', () => {
  const r = computeLayout({ room: { width: 120, height: 144 }, tile: { width: 12, height: 24 }, grout: 3 / 16, pattern: 'stack', tilesPerBox: 8 });
  const P = r.layout.purchase;
  assert.equal(P.tilesToBuy, 66, '120 sq ft + 10% = 132 sq ft = 66 tiles');
  assert.equal(P.boxes, 9);
  const none = computeLayout({ room: { width: 120, height: 144 }, tile: { width: 12, height: 24 }, grout: 3 / 16, pattern: 'stack' });
  assert.equal(none.layout.purchase.boxes, null);
  return `${P.sqFtToBuy} sq ft, ${P.tilesToBuy} tiles, ${P.boxes} boxes`;
});

test('purchase never recommends fewer tiles than the layout consumes', '100" x 130" room, 12x24 tile, 1/8" joint, stack', () => {
  // The flat 10% allowance undercounts this room: reused-offcut accounting
  // shows 54 tiles actually go into the floor (28 full + 26 for the cuts),
  // while 100 sq ft field * 1.10 only buys 50. The purchase figure must be
  // floored at the engine's own consumption count, not just the flat rule.
  const r = computeLayout({ room: { width: 100, height: 130 }, tile: { width: 12, height: 24 }, grout: 0.125, pattern: 'stack', focalWall: 'north' });
  const L = r.layout;
  const consumed = L.counts.full + L.purchase.tilesForCuts;
  assert.equal(consumed, 54);
  assert.ok(L.purchase.tilesToBuy >= consumed, `tilesToBuy ${L.purchase.tilesToBuy} is short of the ${consumed} tiles the layout actually uses`);
  closeTo(L.purchase.sqFtToBuy, L.purchase.tilesToBuy * 2, 1e-9, 'sqFtToBuy must agree with tilesToBuy');
  return `flat allowance alone would buy ${Math.ceil(L.area.fieldSqFt * 1.10 * 144 / 288)} tiles, layout consumes ${consumed}, recommendation is ${L.purchase.tilesToBuy}`;
});

test('lippage warning boundary: exactly 15" and exactly 33% do not warn', '24" tile at 50%, 15" tile at 50%, 24" tile at 1/3', () => {
  const at15 = computeLayout({ room: { width: 120, height: 144 }, tile: { width: 12, height: 15 }, grout: 0.125, pattern: 'running', offset: 0.5 });
  assert.ok(!at15.warnings.some(w => /lippage/.test(w)), '15" exactly is not "over 15 inches"');
  const over15 = computeLayout({ room: { width: 120, height: 144 }, tile: { width: 12, height: 15.5 }, grout: 0.125, pattern: 'running', offset: 0.5 });
  assert.ok(over15.warnings.some(w => /lippage/.test(w)));
  const atThird = computeLayout({ room: { width: 120, height: 144 }, tile: { width: 12, height: 24 }, grout: 0.125, pattern: 'running', offset: 1 / 3 });
  assert.ok(!atThird.warnings.some(w => /lippage/.test(w)), '33% exactly is not "above 33 percent"');
  const overThird = computeLayout({ room: { width: 120, height: 144 }, tile: { width: 12, height: 24 }, grout: 0.125, pattern: 'running', offset: 0.34 });
  assert.ok(overThird.warnings.some(w => /lippage/.test(w)));
  return 'no warning at 15"/50%, warning above; no warning at 1/3 offset, warning above';
});

test('grout warning boundary: exactly 1/8" on non-rectified does not warn', '1/8" vs 1/16" less on non-rectified tile', () => {
  const ok = computeLayout({ room: { width: 120, height: 144 }, tile: { width: 12, height: 12, rectified: false }, grout: 0.125, pattern: 'stack' });
  assert.ok(!ok.warnings.some(w => /non-rectified/.test(w)));
  const tight = computeLayout({ room: { width: 120, height: 144 }, tile: { width: 12, height: 12, rectified: false }, grout: 0.124, pattern: 'stack' });
  assert.ok(tight.warnings.some(w => /non-rectified/.test(w)));
  return 'no warning at 1/8" exactly, warning just under it';
});

test('movement-joint warning: only when a full tile is actually flush to a wall', '120.5x144.5 leaves 1/4"+ everywhere vs an exact-fit room', () => {
  const clear = computeLayout({ room: { width: 120.5, height: 144.5 }, tile: { width: 12, height: 24 }, grout: 0.1875, pattern: 'stack' });
  assert.ok(!clear.warnings.some(w => /movement joint/.test(w)));
  const flush = computeLayout({ room: { width: 121.25, height: 97 }, tile: { width: 12, height: 12 }, grout: 0.125, pattern: 'stack' });
  assert.ok(flush.warnings.some(w => /movement joint/.test(w)));
  return 'no warning with clearance, warning when full tiles sit flush';
});

test('opposite walls equal across a sweep of rooms and patterns', '18 rooms x stack, running 50%, running 33% x 2 tiles x 2 focal walls', () => {
  let n = 0;
  for (const w of [37, 60, 96.5, 110, 121.25, 144]) {
    for (const h of [41, 72.25, 97]) {
      for (const pattern of ['stack', 'running']) {
        for (const tile of [{ width: 12, height: 12 }, { width: 12, height: 24 }]) {
          for (const offset of pattern === 'running' ? [0.5, 1 / 3] : [0]) {
            for (const focalWall of ['north', 'east']) {
              const r = computeLayout({ room: { width: w, height: h }, tile, grout: 0.125, pattern, offset, focalWall });
              assertOppositeWallsEqual(r);
              for (const key of ['parallel', 'perpendicular']) {
                assertShiftInvariant(r.orientations[key].axes.x);
                assertShiftInvariant(r.orientations[key].axes.y);
              }
              n++;
            }
          }
        }
      }
    }
  }
  return `${n} layouts, opposite walls equal in every one, C in [M/2, M) after every half shift`;
});

test('offsetPattern: drift, alternate and zigzag produce the exact course sequences', 'offset=1/3 (q=3), 8 rows, each of the three shapes', () => {
  const M = 12;
  const frac = { p: 1, q: 3, value: 1 / 3 };
  const drift = rowShiftFn(frac, M, 'drift');
  const alternate = rowShiftFn(frac, M, 'alternate');
  const zigzag = rowShiftFn(frac, M, 'zigzag');
  const seq = (fn) => Array.from({ length: 8 }, (_, r) => Math.round(fn(r) * 100) / 100);
  assert.deepEqual(seq(drift), [0, 4, 8, 0, 4, 8, 0, 4], 'staircase: same direction every course');
  assert.deepEqual(seq(alternate), [0, 4, 0, 4, 0, 4, 0, 4], 'plain two-row bond regardless of q');
  assert.deepEqual(seq(zigzag), [0, 4, 8, 4, 0, 4, 8, 4], 'out and back, joints never walk off one way');
  // half bond (q=2): alternate and drift coincide, zigzag degenerates to the same 2-row bond
  const half = { p: 1, q: 2, value: 0.5 };
  assert.deepEqual(seq(rowShiftFn(half, M, 'drift')), [0, 6, 0, 6, 0, 6, 0, 6]);
  assert.deepEqual(seq(rowShiftFn(half, M, 'alternate')), [0, 6, 0, 6, 0, 6, 0, 6]);
  assert.deepEqual(seq(rowShiftFn(half, M, 'zigzag')), [0, 6, 0, 6, 0, 6, 0, 6]);
  return 'drift 0,4,8,0,4,8,..; zigzag 0,4,8,4,0,4,8,4,..; alternate 0,4,0,4,..; all agree at 50%';
});

test('offsetPattern reaches the whole-layout API and stays symmetric', '120x144 room, 12x12 tile, running 1/3, each offsetPattern', () => {
  for (const offsetPattern of ['drift', 'alternate', 'zigzag']) {
    const r = computeLayout({ room: { width: 120, height: 144 }, tile: { width: 12, height: 12 }, grout: 0.125, pattern: 'running', offset: 1 / 3, offsetPattern, focalWall: 'north' });
    assertOppositeWallsEqual(r);
    assert.equal(r.layout.rows.pattern, offsetPattern);
  }
  // zigzag has a real 3-value cut set at the side walls (0, M/3, 2M/3 apart), not just 2
  const zz = computeLayout({ room: { width: 120, height: 144 }, tile: { width: 12, height: 12 }, grout: 0.125, pattern: 'running', offset: 1 / 3, offsetPattern: 'zigzag', focalWall: 'north' });
  assert.ok(wallVals(zz.layout, 'west').length >= 2);
  // alternate always collapses to exactly 2 values regardless of the offset denominator
  const alt = computeLayout({ room: { width: 120, height: 144 }, tile: { width: 12, height: 12 }, grout: 0.125, pattern: 'running', offset: 0.42, offsetPattern: 'alternate', focalWall: 'north' });
  assert.equal(wallVals(alt.layout, 'west').length, 2, 'a plain two-row bond only ever sees two cut widths');
  return 'offsetPattern threads through computeLayout for drift/alternate/zigzag, opposite walls still equal in every case';
});

test('odd running-bond offsets stay symmetric and fast (not just nice fractions)', 'offsets 10%..48% x 3 rooms, 12x24 tile', () => {
  // offsetFraction() snaps 0.5, 1/3, etc. exactly, but a setter can dial in
  // any percentage. An offset like 0.42 reduces to 21/50, which could blow up
  // the shift search (it tries 2q candidate shifts per span) or leave the
  // symmetric-wall invariant unchecked for the untidy fractions.
  const t0 = Date.now();
  let n = 0;
  for (const offset of [0.1, 0.15, 0.2, 0.25, 0.28, 0.3, 0.35, 0.4, 0.42, 0.45, 0.48]) {
    for (const [w, h] of [[110, 97], [144, 120], [73.5, 61.25]]) {
      const r = computeLayout({ room: { width: w, height: h }, tile: { width: 12, height: 24 }, grout: 0.125, pattern: 'running', offset, focalWall: 'north' });
      assertOppositeWallsEqual(r);
      n++;
    }
  }
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, `offset sweep took ${ms}ms, too slow for odd denominators`);
  return `${n} layouts across 11 offsets including 0.42 (21/50), all symmetric, ${ms}ms`;
});

// ---------------------------------------------------------------------------
// Optimizing for the easiest layout with the fewest cut tiles
// ---------------------------------------------------------------------------

test('ease report counts what makes a layout hard', '120x144 room, 12x24 tile, stack', () => {
  const r = computeLayout({ room: { width: 120, height: 144 }, tile: { width: 12, height: 24 }, grout: 3 / 16, pattern: 'stack' });
  const e = r.layout.ease;
  assert.equal(e.cutTiles, r.layout.counts.cut, 'cutTiles tracks counts.cut');
  assert.equal(e.fullTiles, r.layout.counts.full);
  assert.equal(e.hardCuts, r.layout.counts.corner + r.layout.counts.obstacle);
  assert.equal(e.slivers, 0, 'no sliver in the reference room');
  assert.equal(e.cutSizes, 2, 'two saw settings: one per axis');
  closeTo(e.smallestCut, r.layout.smallestCut.inches, 1e-9);
  // every orientation carries one, so they can be compared directly
  assert.ok(r.orientations.parallel.ease && r.orientations.perpendicular.ease);
  return `slivers ${e.slivers}, ${e.cutTiles} cuts in ${e.cutSizes} sizes, smallest ${formatInches(e.smallestCut)}, waste ${e.wastePct.toFixed(1)}%`;
});

test('easeVerdict weighs slivers, then warnings, then cuts, then saw settings', 'hand-built ease reports', () => {
  const base = { slivers: 0, defects: 0, cutTiles: 30, fullTiles: 40, smallestCut: 5, hardCuts: 4, cutSizes: 2, wastePct: 7 };
  // a sliver loses however good the rest looks
  assert.equal(easeVerdict({ ...base, slivers: 1, cutTiles: 10 }, base).winner, 'b', 'sliver must lose');
  // so does a layout the engine warns about — never recommend what you flag
  assert.equal(easeVerdict({ ...base, defects: 1, cutTiles: 20 }, base).winner, 'b', 'a warned layout must lose');
  // a real cut-count gap wins: 30 against 44 is well past the 15% gate
  assert.equal(easeVerdict(base, { ...base, cutTiles: 44 }).winner, 'a');
  // two cuts out of thirty is noise, so it falls through to the later measures
  assert.equal(easeVerdict(base, { ...base, cutTiles: 32 }).winner, 'a');
  assert.equal(easeVerdict(base, { ...base, cutTiles: 32 }).reason.includes('marginally'), true);
  // three fewer cuts does not buy seven more saw settings — the herringbone case
  const tricky = easeVerdict({ ...base, cutTiles: 27, cutSizes: 9 }, base);
  assert.equal(tricky.winner, 'b', 'fewer cuts at nine sizes is not easier than more cuts at two');
  assert.ok(tricky.reason.includes('saw settings'), tricky.reason);
  // identical reports tie
  assert.equal(easeVerdict(base, { ...base }).winner, 'tie');
  return `sliver and warning both lose outright; 30 vs 44 cuts decides; 30 vs 32 does not; 27 cuts/9 sizes loses to 30 cuts/2 sizes`;
});

test('the optimizer never recommends a setup the app warns about', '10x12 room, 24x12 tile, 1/8" joint — the app\'s own defaults', () => {
  // a 50% offset on a 24" tile trips the lippage warning, and it is also the
  // layout with the fewest cuts: the ranking has to prefer the quiet one
  const input = { room: { width: 120, height: 144 }, tile: { width: 24, height: 12, rectified: true }, grout: 0.125, focalWall: 'north', pattern: 'running', offset: 0.5, offsetPattern: 'alternate' };
  const half = computeLayout(input);
  assert.ok(half.layout.warningCodes.includes('lippage'), 'the 50% offset really does trip lippage');
  assert.equal(half.layout.ease.defects, 1);

  const o = optimizeLayout(input, { patterns: ['stack', 'running', 'diagonal', 'herringbone'] });
  assert.equal(o.improved, true, 'the default is not the setup to recommend');
  assert.equal(o.best.ease.defects, 0, `recommended ${o.best.label} still trips ${JSON.stringify(o.best.warnings)}`);
  // and it wins on the strength of that, not despite having more cuts
  assert.ok(o.best.ease.cutTiles >= half.layout.counts.cut, 'the quiet setup here really does cut a little more');
  const applied = computeLayout({ ...input, pattern: o.best.pattern, offset: o.best.offset, offsetPattern: o.best.offsetPattern });
  assert.equal(applied.layout.warnings.length, 0, JSON.stringify(applied.layout.warnings));
  return `${o.current.label} (${half.layout.counts.cut} cuts, lippage) gives way to ${o.best.label} (${o.best.ease.cutTiles} cuts, no warning)`;
});

test('orientation is chosen on cut count, not on waste', '96" x 140" room, 6x24 plank, 1/8" joint, stack', () => {
  const r = computeLayout({ room: { width: 96, height: 140 }, tile: { width: 6, height: 24 }, grout: 0.125, pattern: 'stack' });
  const p = r.orientations.parallel, q = r.orientations.perpendicular;
  assert.equal(p.counts.cut, 44);
  assert.equal(q.counts.cut, 54);
  // perpendicular wastes less tile (4.3% against 8.2%) but cuts ten more
  // pieces; ten cuts of a man's day beat four percent of the tile bill
  assert.ok(q.waste.actualPct < p.waste.actualPct, 'perpendicular really is the lower-waste one');
  assert.equal(r.recommended, 'parallel', 'the ten fewer cuts must win');
  assert.ok(r.orientationNote.includes('fewer cut tiles'), r.orientationNote);
  return `${r.recommended}: ${p.counts.cut} cuts at ${p.waste.actualPct.toFixed(1)}% waste beats ${q.counts.cut} at ${q.waste.actualPct.toFixed(1)}%`;
});

test('optimizeLayout ranks the settings the user left free', '120x144, 12x24, 3/16 joint, running bond at 20% zigzag', () => {
  const input = { room: { width: 120, height: 144 }, tile: { width: 12, height: 24, rectified: true }, grout: 3 / 16, focalWall: 'north', pattern: 'running', offset: 0.2, offsetPattern: 'zigzag' };
  const o = optimizeLayout(input);
  assert.ok(o.ranked.length > 1, 'more than one variant');
  assert.equal(o.ranked[0], o.best, 'the winner heads the list');
  assert.equal(o.current.pattern, 'running');
  closeTo(o.current.offset, 0.2, 1e-9);
  assert.equal(o.current.offsetPattern, 'zigzag');
  assert.equal(o.improved, true, 'a 20% zigzag is not the easiest way to run this room');
  // every entry is a set of settings that can be handed straight back
  const applied = computeLayout({ ...input, pattern: o.best.pattern, offset: o.best.offset, offsetPattern: o.best.offsetPattern });
  assert.deepEqual(applied.layout.ease, o.best.ease, 'applying best reproduces the ease it promised');
  // and it is genuinely no worse than what the user had
  assert.ok(applied.layout.counts.cut <= o.current.ease.cutTiles);
  assert.ok(applied.layout.ease.cutSizes <= o.current.ease.cutSizes);
  return `${o.ranked.length} variants; best ${o.best.label} (${o.best.ease.cutTiles} cuts, ${o.best.ease.cutSizes} sizes) over ${o.current.label} (${o.current.ease.cutTiles} cuts, ${o.current.ease.cutSizes} sizes)`;
});

test('optimizeLayout drops variants that are the same layout twice', '12x12 tile, running bond; 50% is one layout, not three', () => {
  const input = { room: { width: 120, height: 144 }, tile: { width: 12, height: 12 }, grout: 0.125, pattern: 'running', offset: 0.5 };
  const o = optimizeLayout(input);
  const halves = o.ranked.filter(e => Math.abs(e.offset - 0.5) < 1e-9);
  assert.equal(halves.length, 1, `drift, alternate and zigzag coincide at 50%: ${JSON.stringify(halves.map(h => h.label))}`);
  assert.equal(halves[0].label, 'running bond, 50%', 'and it is not labelled with a course shape it does not have');
  // a third-module offset really is three different layouts
  const thirds = o.ranked.filter(e => Math.abs(e.offset - 1 / 3) < 1e-9);
  assert.equal(thirds.length, 3, JSON.stringify(thirds.map(t => t.label)));
  assert.deepEqual(o.ranked.filter(e => e.isCurrent).length, 1, 'exactly one entry is the current one');
  return `${o.ranked.length} distinct variants from 4 offsets x 3 shapes; 50% collapses to one, 33% stays three`;
});

test('optimizeLayout can compare patterns when asked, and refuses a bad trade', '120x144, 12x24: stack against running, diagonal and herringbone', () => {
  const input = { room: { width: 120, height: 144 }, tile: { width: 12, height: 24, rectified: true }, grout: 3 / 16, pattern: 'stack' };
  const o = optimizeLayout(input, { patterns: ['stack', 'running', 'diagonal', 'herringbone'] });
  const by = (label) => o.ranked.find(e => e.label === label);
  const herring = by('herringbone'), stack = by('stack bond');
  assert.ok(herring && stack);
  // herringbone cuts fewer pieces here, but at nine fence settings against two
  assert.ok(herring.ease.cutTiles < stack.ease.cutTiles, 'herringbone really does cut fewer');
  assert.ok(herring.ease.cutSizes > stack.ease.cutSizes + 2);
  assert.notEqual(o.best.label, 'herringbone', 'and must not be called the easiest for it');
  assert.ok(o.ranked.indexOf(by('45° diagonal')) > o.ranked.indexOf(stack), 'diagonal is the hardest of the four');
  return `best ${o.best.label}; herringbone ${herring.ease.cutTiles} cuts in ${herring.ease.cutSizes} sizes loses to stack ${stack.ease.cutTiles} in ${stack.ease.cutSizes}`;
});

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

function wrap(text, width) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const word of words) {
    if (cur && (cur + ' ' + word).length > width) { lines.push(cur); cur = word; }
    else cur = cur ? cur + ' ' + word : word;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

function printTable() {
  const cols = [
    { key: 'idx', title: '#', width: 3 },
    { key: 'name', title: 'case', width: 34 },
    { key: 'input', title: 'input', width: 34 },
    { key: 'result', title: 'result', width: 78 },
    { key: 'status', title: 'status', width: 6 },
  ];
  const line = cols.map(c => '-'.repeat(c.width)).join('-+-');
  console.log('\n' + cols.map(c => c.title.padEnd(c.width)).join(' | '));
  console.log(line);
  rows.forEach((row, i) => {
    const cellLines = cols.map(c => wrap(c.key === 'idx' ? i + 1 : row[c.key], c.width));
    const height = Math.max(...cellLines.map(l => l.length));
    for (let k = 0; k < height; k++) {
      console.log(cols.map((c, j) => (cellLines[j][k] || '').padEnd(c.width)).join(' | '));
    }
    console.log(line);
  });
  console.log(`\n${rows.length - failures} passed, ${failures} failed`);
}

printTable();
process.exit(failures ? 1 : 0);
