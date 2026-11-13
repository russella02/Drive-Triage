'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../analysis.js');
const { loadFixture } = require('./helpers.js');

const HDD01 = 'HDD-01/HDD-01-ST3500820AS_9QM3N9GS_2026-11-11_1618.json';

test('parses HDD-01', () => {
  const s = A.parseScan(loadFixture(), HDD01);
  assert.equal(s.serial, '9QM3N9GS');
  assert.equal(s.model, 'ST3500820AS');
  assert.equal(s.vendor, 'Seagate');
  assert.equal(s.driveName, '9QM3N9GS');
  assert.equal(s.time, 1794431755);
  assert.equal(s.powerOnHours, 3793);
  assert.deepEqual(s.temp, { current: 38, lifetimeMax: 53 });
  assert.equal(s.smartPassed, true);
  assert.equal(s.satNeeds16, true);
  assert.ok(s.warning.startsWith('There are known problems with these drives'));
  assert.ok(!/https?:/.test(s.warning));
  assert.equal(s.tempHistory.length, 128);
  assert.equal(s.tempHistory[127], 38);
  assert.equal(s.supported, true);
  assert.equal(s.capacityBytes, 500107862016);
  assert.equal(s.firmware, 'SD81');
  assert.equal(s.relPath, HDD01);
  assert.equal(s.selfTests.length, 4);
  assert.equal(s.selfTests[0].hours, 3793); // newest first
  assert.equal(s.attrs[188].rawString.length > 0, true);
  assert.equal(typeof s.rawOutput, 'string');
});

test('driveName is always the serial number, whatever the folder or file name', () => {
  for (const p of ['HDD-07/HDD-07-ST3500820AS_X_2026.json', 'HDD-07-ST3500820AS_X_2026.json', 'ST3500820AS_9QM3N9GS_2026-11-11_1618.json', 'whatever.json']) {
    assert.equal(A.parseScan(loadFixture(), p).driveName, '9QM3N9GS');
  }
});

test('decodes Seagate 188', () => {
  const s = A.parseScan(loadFixture(), HDD01);
  assert.equal(A.attrCount(s, 188), 1);
  assert.equal(A.attrCount(s, 194), 38);
  assert.equal(A.attrCount(s, 999), null);
});

test('selfTestOutcome', () => {
  assert.equal(A.selfTestOutcome(0), 'pass');
  assert.equal(A.selfTestOutcome(32), 'interrupted');
  assert.equal(A.selfTestOutcome(121), 'fail');
  assert.equal(A.selfTestOutcome(241), 'running');
});

test('formatCapacity', () => {
  assert.equal(A.formatCapacity(500107862016), '500 GB');
  assert.equal(A.formatCapacity(1000204886016), '1 TB');
  assert.equal(A.formatCapacity(1500301910016), '1.5 TB');
});

test('rejects non-smartctl json', () => {
  assert.equal(A.parseScan({ foo: 1 }, 'x.json'), null);
});

test('nvme is unsupported', () => {
  const j = loadFixture();
  j.device.protocol = 'NVMe';
  delete j.ata_smart_attributes;
  const s = A.parseScan(j, 'x.json');
  assert.equal(s.supported, false);
});

test('missing optional sections', () => {
  const j = loadFixture();
  delete j.ata_sct_temperature_history;
  delete j.ata_smart_self_test_log;
  delete j.temperature;
  const s = A.parseScan(j, 'x.json');
  assert.deepEqual(s.tempHistory, []);
  assert.deepEqual(s.selfTests, []);
});

test('powerOnHours falls back to attribute 9', () => {
  const j = loadFixture();
  delete j.power_on_time;
  const s = A.parseScan(j, 'x.json');
  assert.equal(s.powerOnHours, s.attrs[9] ? s.attrs[9].raw : null);
  j.ata_smart_attributes.table = j.ata_smart_attributes.table.filter((a) => a.id !== 9);
  assert.equal(A.parseScan(j, 'x.json').powerOnHours, null);
});

test('vendor from model prefix when no family', () => {
  const j = loadFixture();
  delete j.model_family;
  j.model_name = 'WDC WD10EZEX';
  assert.equal(A.parseScan(j, 'x.json').vendor, 'Western Digital');
});

test('groupDrives dedups and orders', () => {
  const mk = (serial, time) => {
    const j = loadFixture();
    j.serial_number = serial;
    j.local_time.time_t = time;
    return A.parseScan(j, serial + '/a.json');
  };
  const drives = A.groupDrives([mk('A', 300), mk('A', 100), mk('A', 300), mk('B', 50)]);
  assert.equal(drives.length, 2);
  const d = drives.find((x) => x.serial === 'A');
  assert.equal(d.scans.length, 2);
  assert.equal(d.latest.time, 300);
  assert.equal(d.previous.time, 100);
  assert.equal(d.key, 'A|ST3500820AS');
  assert.equal(drives.find((x) => x.serial === 'B').previous, null);
});
