'use strict';
// Drive list sort orders (the rail's Sort control).
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../analysis.js');

function entry(name, verdict, health, extra) {
  const x = extra || {};
  return {
    drive: {
      key: name + '|' + (x.model || 'M'),
      name,
      model: x.model || 'M',
      latest: { time: x.time === undefined ? 1000 : x.time, capacityBytes: x.cap === undefined ? 500e9 : x.cap }
    },
    assessment: { verdict, health }
  };
}
const names = (list) => list.map((e) => e.drive.name);

const SET = [
  entry('B2', 'keep', 100, { model: 'Toshiba', time: 3000, cap: 500e9 }),
  entry('A10', 'watch', 90, { model: 'Seagate', time: 1000, cap: 1e12 }),
  entry('A9', 'keep', 94, { model: 'Samsung', time: 5000, cap: 250e9 }),
  entry('C1', 'unsupported', null, { model: 'NVMe', time: null, cap: null }),
  entry('D4', 'retire', 8, { model: 'WDC', time: 2000, cap: 2e12 })
];

test('sort modes are listed with labels, worst first is the default', () => {
  assert.equal(A.SORT_MODES[0].id, 'worst');
  assert.equal(A.DEFAULT_SORT, 'worst');
  for (const m of A.SORT_MODES) assert.ok(m.label, m.id);
  assert.deepEqual(A.SORT_MODES.map((m) => m.id), ['worst', 'best', 'name', 'model', 'capacity', 'newest']);
});

test('worst first: verdict, then lowest health', () => {
  assert.deepEqual(names(A.sortDrives(SET, 'worst')), ['D4', 'A10', 'A9', 'B2', 'C1']);
});

test('best first: highest health first, unsupported still last', () => {
  assert.deepEqual(names(A.sortDrives(SET, 'best')), ['B2', 'A9', 'A10', 'D4', 'C1']);
});

test('name: serial A-Z with numbers in order', () => {
  assert.deepEqual(names(A.sortDrives(SET, 'name')), ['A9', 'A10', 'B2', 'C1', 'D4']);
});

test('model: A-Z, then serial', () => {
  const list = SET.concat([entry('A1', 'keep', 100, { model: 'Samsung' })]);
  assert.deepEqual(names(A.sortDrives(list, 'model')), ['C1', 'A1', 'A9', 'A10', 'B2', 'D4']);
});

test('capacity: largest first, unknown last', () => {
  assert.deepEqual(names(A.sortDrives(SET, 'capacity')), ['D4', 'A10', 'B2', 'A9', 'C1']);
});

test('last scanned: newest first, unknown last', () => {
  assert.deepEqual(names(A.sortDrives(SET, 'newest')), ['A9', 'B2', 'D4', 'A10', 'C1']);
});

test('ties fall back to serial', () => {
  const list = [entry('Z1', 'keep', 100), entry('Y1', 'keep', 100), entry('X1', 'keep', 100)];
  assert.deepEqual(names(A.sortDrives(list, 'capacity')), ['X1', 'Y1', 'Z1']);
});

test('unknown mode falls back to worst first; input is not mutated', () => {
  const before = names(SET);
  assert.deepEqual(names(A.sortDrives(SET, 'bogus')), names(A.sortDrives(SET, 'worst')));
  assert.deepEqual(names(SET), before);
});
