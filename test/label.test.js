'use strict';
// Label dates are local time; pin the zone before anything touches Date.
process.env.TZ = 'America/New_York';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../analysis.js');
const { loadFixture, withAttr } = require('./helpers.js');

const PATH = 'HDD-01/HDD-01-ST3500820AS_9QM3N9GS_2026-11-11_1618.json';

function labelOf(json, relPath) {
  const d = A.groupDrives([A.parseScan(json, relPath || PATH)])[0];
  return A.labelLines(d, A.assessDrive(d));
}

test('HDD-01 label', () => {
  assert.deepEqual(labelOf(loadFixture()), {
    name: 'HDD-01',
    health: '90%',
    line2: 'Seagate ST3500820AS  500 GB',
    line3: 'SN 9QM3N9GS',
    line4: '3,793 h (0.4 yr) · Realloc 0 · Pend 0',
    line5: '! Spin retries 16',
    line6: 'Scanned 2026-11-11 · Long PASS'
  });
});

test('no watch/retire finding: line 5 is the lifetime max temperature', () => {
  const l = labelOf(withAttr(loadFixture(), 10, { raw: { value: 0, string: '0' } }));
  assert.equal(l.line5, 'Max temp 53°C');
  assert.equal(l.health, '100%');
});

test('vendor is not repeated when the model already starts with it', () => {
  const j = loadFixture();
  j.model_name = 'Seagate ST3500820AS';
  assert.equal(labelOf(j).line2, 'Seagate ST3500820AS  500 GB');
  const k = loadFixture();
  k.model_name = 'WDC WD5000AAKS-00A7B0';
  k.model_family = 'Western Digital Caviar SE Serial ATA';
  const l2 = labelOf(k).line2;
  assert.ok(!/WDC.*WDC|Western Digital.*Western Digital/.test(l2), l2);
  assert.ok(l2.endsWith('  500 GB'), l2);
});

test('long result only counts a passed or failed extended test', () => {
  const j = loadFixture();
  j.ata_smart_self_test_log.standard.table = [];
  assert.match(labelOf(j).line6, /Long none$/);
  const f = loadFixture();
  f.ata_smart_self_test_log.standard.table = [
    { type: { string: 'Short offline' }, status: { value: 0 }, lifetime_hours: 5 },
    { type: { string: 'Extended offline' }, status: { value: 0x70 }, lifetime_hours: 4 }
  ];
  assert.match(labelOf(f).line6, /Long FAIL$/);
  const u = loadFixture();
  u.ata_smart_self_test_log.standard.table = [
    { type: { string: 'Extended offline' }, status: { value: 0x20 }, lifetime_hours: 4 }
  ];
  assert.match(labelOf(u).line6, /Long none$/);
});

test('an unsupported drive still gets a clean label', () => {
  const j = {
    smartctl: { version: [7, 4], output: [] },
    device: { protocol: 'NVMe', type: 'nvme' },
    model_name: 'Samsung SSD 970 EVO',
    serial_number: 'S4EVNX0M',
    user_capacity: { bytes: 500107862016 },
    local_time: { time_t: 1794000000 }
  };
  const l = labelOf(j, 'NVME-01/scan.json');
  assert.equal(l.health, '—');
  Object.keys(l).forEach((k) => assert.ok(typeof l[k] === 'string' && !/undefined|NaN|null/.test(l[k]), k + ': ' + l[k]));
  assert.equal(l.line5, 'Not supported yet');
  assert.equal(l.line4, 'Not supported yet');
});

test('Western Digital family with a WDC model: no "Western", no repeated vendor', () => {
  const k = loadFixture();
  k.model_name = 'WDC WD5000AAKS-00A7B0';
  k.model_family = 'Western Digital Caviar SE Serial ATA';
  assert.equal(labelOf(k).line2, 'WDC WD5000AAKS-00A7B0  500 GB');
  const m = loadFixture();
  m.model_name = 'WD5000AAKS';
  m.model_family = 'Western Digital Caviar SE';
  assert.equal(labelOf(m).line2, 'WD5000AAKS  500 GB');
});

test('a missing attribute 5 or 197 prints ? not 0', () => {
  const j = loadFixture();
  j.ata_smart_attributes.table = j.ata_smart_attributes.table.filter((a) => a.id !== 5);
  assert.match(labelOf(j).line4, /Realloc \? · Pend 0$/);
  const k = loadFixture();
  k.ata_smart_attributes.table = k.ata_smart_attributes.table.filter((a) => a.id !== 197);
  assert.match(labelOf(k).line4, /Realloc 0 · Pend \?$/);
});
