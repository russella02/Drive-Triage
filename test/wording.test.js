'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../analysis.js');
const { loadFixture, withAttr } = require('./helpers.js');

const HDD01 = 'HDD-01/HDD-01-ST3500820AS_9QM3N9GS_2026-11-11_1618.json';

function assess(json) {
  return A.assessDrive(A.groupDrives([A.parseScan(json, HDD01)])[0]);
}
function upperShare(text) {
  const letters = text.replace(/[^A-Za-z]/g, '');
  return letters.length ? letters.replace(/[^A-Z]/g, '').length / letters.length : 0;
}

test('model warning reads as plain sentence-case English', () => {
  const f = assess(loadFixture()).findings.find((x) => x.code === 'model-warning');
  assert.ok(f, 'model-warning finding present');
  assert.ok(!/following web pages/i.test(f.detail), f.detail);
  assert.ok(!/:\s*$/.test(f.detail), 'no dangling colon');
  assert.ok(upperShare(f.detail) < 0.3, 'not mostly upper case: ' + f.detail);
  assert.ok(f.detail.includes('Seagate Barracuda 7200.11'), f.detail);
  assert.ok(/may or may not be affected/.test(f.detail), f.detail);
});

test('raw smartctl warning text stays available on the scan', () => {
  const s = A.parseScan(loadFixture(), HDD01);
  assert.ok(s.warning.startsWith('There are known problems with these drives'));
});

test('finding text never uses "(s)" placeholders', () => {
  // attribute id -> raw value giving that count (188 is Seagate-packed: low word is the count)
  const ids = [5, 197, 198, 187, 10, 188, 199];
  [1, 16].forEach((n) => {
    ids.forEach((id) => {
      const json = withAttr(loadFixture(), id, { raw: { value: n, string: String(n) } });
      assess(json).findings.forEach((f) => {
        assert.ok(!/\(s\)/.test(f.short + ' ' + f.detail), 'attr ' + id + ' = ' + n + ': ' + f.short + ' / ' + f.detail);
      });
    });
  });
});

test('counts agree with their nouns and verbs', () => {
  const detail = (id, n, code) => assess(withAttr(loadFixture(), id, { raw: { value: n, string: String(n) } }))
    .findings.find((f) => f.code === code).detail;
  assert.match(detail(10, 1, 'spin-retry'), /\b1 extra attempt to\b/);
  assert.match(detail(10, 16, 'spin-retry'), /\b16 extra attempts to\b/);
  assert.match(detail(197, 1, 'pending'), /^1 sector is waiting\b/);
  assert.match(detail(197, 16, 'pending'), /^16 sectors are waiting\b/);
  assert.match(detail(5, 1, 'realloc'), /\b1 damaged sector for\b/);
  assert.match(detail(199, 1, 'crc'), /\b1 data transfer error\./);
  assert.match(detail(187, 16, 'reported-unc'), /\b16 read errors\b/);
});
