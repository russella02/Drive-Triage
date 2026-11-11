'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../analysis.js');
const { loadFixture, withAttr } = require('./helpers.js');

const HDD01 = 'HDD-01/HDD-01-ST3500820AS_9QM3N9GS_2026-11-11_1618.json';
const fixtureText = () => JSON.stringify(loadFixture());

test('skips bad files', () => {
  const r = A.analyzeFiles([
    { relPath: HDD01, text: fixtureText() },
    { relPath: 'junk.json', text: '{nope' },
    { relPath: 'other.json', text: '{"a":1}' }
  ]);
  assert.equal(r.scanCount, 1);
  assert.equal(r.skipped, 2);
  assert.equal(r.drives.length, 1);
  assert.equal(r.drives[0].drive.name, 'HDD-01');
  assert.equal(r.drives[0].assessment.verdict, 'watch');
  assert.equal(r.drives[0].assessment.health, 90);
});

test('dedups duplicate saves', () => {
  const text = fixtureText();
  const r = A.analyzeFiles([
    { relPath: HDD01, text },
    { relPath: 'HDD-01/HDD-01 copy.json', text }
  ]);
  assert.equal(r.scanCount, 1);
  assert.equal(r.skipped, 0);
  assert.equal(r.drives.length, 1);
  assert.equal(r.drives[0].drive.scans.length, 1);
});

test('counts every unique scan across drives', () => {
  const older = loadFixture();
  older.local_time.time_t -= 86400;
  const r = A.analyzeFiles([
    { relPath: HDD01, text: fixtureText() },
    { relPath: 'HDD-01/older.json', text: JSON.stringify(older) }
  ]);
  assert.equal(r.scanCount, 2);
  assert.equal(r.drives[0].drive.scans.length, 2);
});

test('sorts worst first', () => {
  const bad = withAttr(loadFixture(), 197, { raw: { value: 2, string: '2' } });
  bad.serial_number = 'BADSERIAL';
  const r = A.analyzeFiles([
    { relPath: HDD01, text: fixtureText() },
    { relPath: 'HDD-02/HDD-02-ST3500820AS_BADSERIAL.json', text: JSON.stringify(bad) }
  ]);
  assert.deepEqual(r.drives.map((e) => e.assessment.verdict), ['retire', 'watch']);
  assert.deepEqual(r.drives.map((e) => e.drive.name), ['HDD-02', 'HDD-01']);
});

test('sort order: retire, watch, keep, unsupported; then health; then name', () => {
  const keep = withAttr(loadFixture(), 10, { raw: { value: 0, string: '0' } });
  const keepB = JSON.parse(JSON.stringify(keep));
  keep.serial_number = 'K1';
  keepB.serial_number = 'K2';
  const watchOld = loadFixture();          // spin retries + very old: lower health than HDD-01
  watchOld.serial_number = 'W2';
  watchOld.power_on_time.hours = 60000;
  const nvme = loadFixture();
  nvme.serial_number = 'N1';
  nvme.device.protocol = 'NVMe';
  delete nvme.ata_smart_attributes;
  const r = A.analyzeFiles([
    { relPath: 'NVME-1/a.json', text: JSON.stringify(nvme) },
    { relPath: 'HDD-10/a.json', text: JSON.stringify(keepB) },
    { relPath: 'HDD-2/a.json', text: JSON.stringify(keep) },
    { relPath: HDD01, text: fixtureText() },
    { relPath: 'HDD-05/a.json', text: JSON.stringify(watchOld) }
  ]);
  assert.deepEqual(r.drives.map((e) => e.drive.name), ['HDD-05', 'HDD-01', 'HDD-2', 'HDD-10', 'NVME-1']);
  assert.equal(r.drives[4].assessment.verdict, 'unsupported');
});

test('tolerates a byte-order mark and empty input', () => {
  const r = A.analyzeFiles([{ relPath: HDD01, text: '﻿' + fixtureText() }]);
  assert.equal(r.scanCount, 1);
  assert.equal(r.skipped, 0);
  assert.deepEqual(A.analyzeFiles([]), { drives: [], scanCount: 0, skipped: 0 });
});
