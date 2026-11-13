'use strict';
// Final whole-branch review fixes: extended self-test log, sample interval, long-test rule,
// malformed files, temperature wording, vendor prefixes, unsupported wording.
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../analysis.js');
const { loadFixture, withAttr } = require('./helpers.js');

const HDD01 = 'HDD-01/HDD-01-ST3500820AS_9QM3N9GS_2026-11-11_1618.json';

function driveOf(json) { return A.groupDrives([A.parseScan(json, HDD01)])[0]; }
function run(json) {
  const drive = driveOf(json);
  const a = A.assessDrive(drive);
  return { drive, a, codes: a.findings.map((f) => f.code), label: A.labelLines(drive, a) };
}
// GSmartControl runs --log=xselftest: the log lands under "extended" and sat,16 reads it.
function extendedLog(json) {
  json.ata_smart_self_test_log = { extended: json.ata_smart_self_test_log.standard };
  json.smartctl.output = json.smartctl.output.filter((l) => l.indexOf('PASS-THROUGH') < 0);
  return json;
}

// ---- 1. extended self-test log
test('extended self-test log is read: HDD-01 stays WATCH 90 with Long PASS', () => {
  const j = extendedLog(loadFixture());
  const r = run(j);
  assert.equal(r.drive.latest.selfTests.length, 4);
  assert.equal(r.drive.latest.satNeeds16, false);
  assert.equal(r.a.verdict, 'watch');
  assert.equal(r.a.health, 90);
  assert.ok(!r.codes.includes('no-long-test'));
  assert.match(r.label.line5, /Long PASS$/);
});

test('a failed extended test in the extended log retires the drive', () => {
  const j = extendedLog(loadFixture());
  const e = j.ata_smart_self_test_log.extended.table[0];
  e.status = { value: 121, string: 'Completed: read failure', passed: false };
  const r = run(j);
  assert.equal(r.a.verdict, 'retire');
  assert.ok(r.a.health <= 10, String(r.a.health));
  assert.ok(r.codes.includes('selftest-failed'));
  assert.match(r.label.line5, /Long FAIL$/);
});

test('extended log is preferred over the standard log when both exist', () => {
  const j = loadFixture();
  const std = j.ata_smart_self_test_log.standard;
  j.ata_smart_self_test_log.extended = { table: [std.table[0]] };
  assert.equal(A.parseScan(j, HDD01).selfTests.length, 1);
});

// ---- 2. SCT temperature sample interval
test('temperature logging interval is parsed, default 1 minute', () => {
  assert.equal(A.parseScan(loadFixture(), HDD01).tempIntervalMinutes, 1);
  const five = loadFixture();
  five.ata_sct_temperature_history.logging_interval_minutes = 5;
  assert.equal(A.parseScan(five, HDD01).tempIntervalMinutes, 5);
  const none = loadFixture();
  delete none.ata_sct_temperature_history;
  assert.equal(A.parseScan(none, HDD01).tempIntervalMinutes, 1);
  const bad = loadFixture();
  bad.ata_sct_temperature_history.logging_interval_minutes = 0;
  assert.equal(A.parseScan(bad, HDD01).tempIntervalMinutes, 1);
});

// ---- 4. no-long-test needs a COMPLETED extended test
test('an interrupted extended test does not count as a long test', () => {
  const j = withAttr(loadFixture(), 10, { raw: { value: 0, string: '0' } });
  j.ata_smart_self_test_log.standard.table = [{
    type: { value: 2, string: 'Extended offline' },
    status: { value: 33, string: 'Interrupted (host reset)', passed: false },
    lifetime_hours: 3793
  }];
  const r = run(j);
  assert.equal(r.a.verdict, 'watch');
  assert.ok(r.codes.includes('no-long-test'));
  assert.equal(r.a.health, 95);
});

test('an empty log on a sat,12 scan is still not called "no long test"', () => {
  const j = withAttr(loadFixture(), 10, { raw: { value: 0, string: '0' } });
  j.ata_smart_self_test_log.standard.table = [];
  const r = run(j);
  assert.ok(!r.codes.includes('no-long-test'));
  assert.equal(r.a.verdict, 'keep');
});

// ---- 5. one malformed file does not abort the folder
test('a malformed scan is skipped and the rest of the folder still loads', () => {
  const bad = loadFixture();
  bad.serial_number = 'BROKEN1';
  bad.ata_smart_self_test_log.standard.table.push(null);
  const r = A.analyzeFiles([
    { relPath: HDD01, text: JSON.stringify(loadFixture()) },
    { relPath: 'HDD-09/bad.json', text: JSON.stringify(bad) }
  ]);
  assert.equal(r.scanCount, 1);
  assert.equal(r.skipped, 1);
  assert.equal(r.drives[0].drive.name, '9QM3N9GS');
});

// ---- 6. temperature wording names only the condition that fired
function tempDetail(current, max) {
  const j = loadFixture();
  j.temperature = { current, lifetime_max: max };
  return run(j).a.findings.find((f) => f.code === 'temp-hot').detail;
}
test('temp-hot wording does not repeat a number', () => {
  const nowOnly = tempDetail(51, 51);
  assert.equal(nowOnly.split('51 °C').length - 1, 1, nowOnly);
  assert.match(nowOnly, /currently at 51 °C/);
  const lifeOnly = tempDetail(40, 57);
  assert.match(lifeOnly, /57 °C/);
  assert.ok(!/currently/.test(lifeOnly), lifeOnly);
  const both = tempDetail(52, 57);
  assert.match(both, /57 °C/);
  assert.match(both, /currently at 52 °C/);
});

// ---- 9. vendor prefixes
function vendor(model, family) {
  const j = loadFixture();
  j.model_name = model;
  if (family === undefined) delete j.model_family; else j.model_family = family;
  return A.parseScan(j, HDD01).vendor;
}
test('model-prefix vendors: HD + digit is Samsung, Hitachi HDT/HDP are not', () => {
  assert.equal(vendor('HD103SJ'), 'Samsung');
  assert.equal(vendor('SAMSUNG HD502HJ'), 'Samsung');
  assert.equal(vendor('HDS721010CLA332'), 'HGST');
  assert.notEqual(vendor('HDT721010SLA360'), 'Samsung');
  assert.notEqual(vendor('HDP725050GLA360'), 'Samsung');
});
test('Western Digital family match is anchored to a word', () => {
  assert.equal(vendor('WDC WD10EZEX-08WN4A0', 'Western Digital Blue'), 'Western Digital');
  assert.equal(vendor('XYZ123', 'Lowdown Storage Drives'), '');
});

// ---- 10. unsupported wording by protocol
test('unsupported reason depends on the device protocol', () => {
  const nv = loadFixture();
  nv.device.protocol = 'NVMe';
  delete nv.ata_smart_attributes;
  const n = run(nv);
  assert.equal(n.a.verdict, 'unsupported');
  assert.equal(n.drive.latest.protocol, 'NVMe');
  assert.match(n.a.findings[0].detail, /NVMe/);

  const ata = loadFixture();
  delete ata.ata_smart_attributes;
  const t = run(ata);
  assert.equal(t.a.verdict, 'unsupported');
  assert.match(t.a.findings[0].detail, /SMART attributes/);
  assert.match(t.a.findings[0].detail, /bridge/);
  t.a.findings.forEach((f) => assert.ok(f.short.length <= A.RULES.shortMax));
});

// ---- security review: device.protocol is untrusted text, keep it to known values
test('device protocol is limited to known values before it reaches any text', () => {
  const nv = loadFixture();
  nv.device.protocol = 'nvme';
  delete nv.ata_smart_attributes;
  const n = run(nv);
  assert.equal(n.drive.latest.protocol, 'NVMe');
  assert.match(n.a.findings[0].detail, /NVMe/);

  const evil = loadFixture();
  evil.device.protocol = 'Click here: evil.example';
  delete evil.ata_smart_attributes;
  const e = run(evil);
  assert.equal(e.drive.latest.protocol, '');
  assert.ok(!/evil|Click/.test(e.a.findings[0].detail), e.a.findings[0].detail);
  assert.match(e.a.findings[0].detail, /a non-ATA drive/);
});
