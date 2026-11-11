'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../analysis.js');
const { loadFixture, withAttr } = require('./helpers.js');

const PATH = 'HDD-01/HDD-01-ST3500820AS_9QM3N9GS_2026-11-11_1618.json';
const seen = []; // every finding produced, for the length check at the end

function driveOf(json) {
  return A.groupDrives([A.parseScan(json, PATH)])[0];
}
function assess(json) {
  const a = A.assessDrive(driveOf(json));
  a.findings.forEach((f) => seen.push(f));
  return a;
}
function clean() { return withAttr(loadFixture(), 10, { raw: { value: 0, string: '0' } }); }
function codes(a, severity) {
  return a.findings.filter((f) => !severity || f.severity === severity).map((f) => f.code);
}
function twoScans(patchPrev, patchLatest) {
  const prev = loadFixture(); patchPrev(prev);
  prev.local_time.time_t -= 86400;
  const latest = loadFixture(); patchLatest(latest);
  const d = A.groupDrives([
    A.parseScan(prev, 'HDD-01/prev.json'),
    A.parseScan(latest, 'HDD-01/latest.json')
  ])[0];
  const a = A.assessDrive(d);
  a.findings.forEach((f) => seen.push(f));
  return a;
}

test('HDD-01 is WATCH, health 90', () => {
  const a = assess(loadFixture());
  assert.equal(a.verdict, 'watch');
  assert.equal(a.health, 90);
  assert.equal(a.band, 'good');
  const spin = a.findings.find((f) => f.code === 'spin-retry');
  assert.equal(spin.severity, 'watch');
  assert.equal(spin.short, 'Spin retries 16');
  const notes = codes(a, 'note');
  ['model-warning', 'selftest-interrupted', 'sat12', 'temp-warm'].forEach((c) => assert.ok(notes.includes(c), c));
  assert.ok(!codes(a).includes('near-threshold'));
  a.findings.forEach((f) => assert.ok(!/Raw_Read|Seek_Error|Hardware_ECC|attribute (1|7|195)\b/i.test(f.short + f.detail)));
});

test('clean drive is KEEP 100', () => {
  const a = assess(clean());
  assert.equal(a.verdict, 'keep');
  assert.equal(a.health, 100);
  assert.equal(a.band, 'good');
});

test('pending sector retires', () => {
  const a = assess(withAttr(clean(), 197, { raw: { value: 2, string: '2' } }));
  assert.equal(a.verdict, 'retire');
  assert.ok(a.health <= 39);
  assert.equal(a.band, 'poor');
});

test('realloc bands', () => {
  const w = assess(withAttr(loadFixture(), 5, { raw: { value: 40, string: '40' } }));
  assert.equal(w.verdict, 'watch');
  assert.equal(w.health, 70);
  const r = assess(withAttr(loadFixture(), 5, { raw: { value: 150, string: '150' } }));
  assert.equal(r.verdict, 'retire');
  assert.ok(codes(r, 'retire').includes('realloc-high'));
});

test('smart failed clamps to 10', () => {
  const j = loadFixture(); j.smart_status.passed = false;
  const a = assess(j);
  assert.equal(a.verdict, 'retire');
  assert.ok(a.health <= 10);
});

test('failed self-test', () => {
  const j = clean();
  j.ata_smart_self_test_log.standard.table[0].status = { value: 121, string: 'Completed: read failure' };
  const a = assess(j);
  assert.equal(a.verdict, 'retire');
  assert.ok(a.health <= 10);
  assert.ok(codes(a, 'retire').includes('selftest-failed'));
});

test('failing-now attribute clamps to 10', () => {
  const a = assess(withAttr(clean(), 3, { when_failed: 'now' }));
  assert.equal(a.verdict, 'retire');
  assert.ok(a.health <= 10);
});

test('an older failed test that is not the most recent does not retire', () => {
  const j = clean();
  j.ata_smart_self_test_log.standard.table[3].status = { value: 121, string: 'Completed: read failure' };
  assert.equal(assess(j).verdict, 'keep');
});

test('growth since last scan', () => {
  const a = twoScans(
    (j) => withAttr(j, 5, { raw: { value: 0, string: '0' } }),
    (j) => withAttr(j, 5, { raw: { value: 3, string: '3' } })
  );
  const g = a.findings.find((f) => f.code === 'grew');
  assert.ok(g);
  assert.equal(g.short, 'Realloc 0→3 since last');
  assert.equal(a.verdict, 'retire');
});

test('no growth when counts are equal', () => {
  const a = twoScans(
    (j) => withAttr(j, 5, { raw: { value: 3, string: '3' } }),
    (j) => withAttr(j, 5, { raw: { value: 3, string: '3' } })
  );
  assert.ok(!codes(a).includes('grew'));
  assert.equal(a.verdict, 'watch');
});

test('old drive', () => {
  const j = clean(); j.power_on_time.hours = 50000;
  // keep the extended test recent so the stale rule stays quiet
  j.ata_smart_self_test_log.standard.table.forEach((e) => { e.lifetime_hours += 50000 - 3793; });
  const a = assess(j);
  assert.ok(a.findings.some((f) => f.code === 'old' && f.severity === 'watch'));
  assert.equal(a.health, 90);
});

test('no extended test', () => {
  const j = clean();
  j.ata_smart_self_test_log.standard.table = j.ata_smart_self_test_log.standard.table
    .filter((e) => !/Extended/i.test(e.type.string));
  const a = assess(j);
  assert.ok(a.findings.some((f) => f.code === 'no-long-test' && f.severity === 'watch'));
  assert.equal(a.health, 95);
});

test('stale extended test is a watch with no health deduction', () => {
  const j = clean(); j.power_on_time.hours = 3793 + 169;
  const a = assess(j);
  assert.ok(codes(a, 'watch').includes('stale-long-test'));
  assert.equal(a.health, 100);
  const j2 = clean(); j2.power_on_time.hours = 3793 + 168;
  assert.ok(!codes(assess(j2)).includes('stale-long-test'));
});

test('crc is a note', () => {
  const a = assess(withAttr(clean(), 199, { raw: { value: 4, string: '4' } }));
  assert.ok(codes(a, 'note').includes('crc'));
  assert.equal(a.verdict, 'keep');
  assert.equal(a.health, 100);
});

test('near-threshold: refined rule', () => {
  // value 100 never fires (healthy Seagates sit at 100 with thresholds 97/99)
  assert.ok(!codes(assess(clean())).includes('near-threshold'));
  const a = assess(withAttr(clean(), 12, { value: 95, thresh: 90 }));
  assert.ok(codes(a, 'watch').includes('near-threshold'));
  assert.equal(a.verdict, 'watch');
  assert.equal(a.health, 90);
  assert.ok(!codes(assess(withAttr(clean(), 12, { value: 80, thresh: 0 }))).includes('near-threshold'));
  assert.ok(!codes(assess(withAttr(clean(), 12, { value: 100, thresh: 99 }))).includes('near-threshold'));
  assert.ok(!codes(assess(withAttr(clean(), 190, { value: 50, thresh: 45 }))).includes('near-threshold'));
  assert.ok(!codes(assess(withAttr(clean(), 194, { value: 50, thresh: 45 }))).includes('near-threshold'));
  assert.ok(codes(assess(withAttr(clean(), 12, { value: 55, thresh: 45 }))).includes('near-threshold'));
  assert.ok(!codes(assess(withAttr(clean(), 12, { value: 56, thresh: 45 }))).includes('near-threshold'));
  assert.ok(!codes(assess(withAttr(clean(), 12, { value: 45, thresh: 45 }))).includes('near-threshold'));
});

test('near-threshold deduction caps at 20', () => {
  let j = clean();
  [4, 12, 184, 3].forEach((id) => { j = withAttr(j, id, { value: 90, thresh: 85 }); });
  assert.equal(assess(j).health, 80);
});

test('Seagate raw 1/7/195 are never judged by raw', () => {
  let j = clean();
  [1, 7, 195].forEach((id) => { j = withAttr(j, id, { raw: { value: 999999999999, string: 'x' } }); });
  assert.equal(assess(j).verdict, 'keep');
  // ...but normalized value vs threshold still counts
  const k = assess(withAttr(clean(), 7, { value: 35, thresh: 30 }));
  assert.ok(codes(k, 'watch').includes('near-threshold'));
});

test('command timeout uses the decoded low word', () => {
  // fixture raw 65537 has low word 1 -> fine (the full raw would be > 5)
  assert.equal(assess(clean()).verdict, 'keep');
  const a = assess(withAttr(clean(), 188, { raw: { value: 9, string: '9' } }));
  assert.ok(codes(a, 'watch').includes('cmd-timeout'));
  assert.equal(a.health, 95);
});

test('hot drive', () => {
  const j = clean(); j.temperature.lifetime_max = 55;
  const a = assess(j);
  assert.ok(codes(a, 'watch').includes('temp-hot'));
  assert.equal(a.health, 95);
  const k = clean(); k.temperature.current = 50;
  assert.ok(codes(assess(k), 'watch').includes('temp-hot'));
});

test('interrupted note disappears when no entry is interrupted', () => {
  const j = clean();
  j.ata_smart_self_test_log.standard.table[2].status = { value: 0, string: 'Completed without error' };
  assert.ok(!codes(assess(j)).includes('selftest-interrupted'));
});

test('unsupported drive', () => {
  const j = loadFixture(); j.device.protocol = 'NVMe';
  const a = assess(j);
  assert.equal(a.verdict, 'unsupported');
  assert.equal(a.health, null);
  assert.equal(a.band, null);
  assert.equal(a.findings.length, 1);
  assert.equal(a.findings[0].severity, 'note');
  assert.equal(a.findings[0].short, 'Not supported yet');
});

test('score is floored at 0', () => {
  const a = assess(withAttr(loadFixture(), 197, { raw: { value: 99, string: '99' } }));
  assert.ok(a.health >= 0 && a.health <= 39);
  assert.equal(a.band, 'poor');
});

test('findings are sorted retire, watch, note', () => {
  let j = withAttr(loadFixture(), 197, { raw: { value: 1, string: '1' } });
  j = withAttr(j, 199, { raw: { value: 2, string: '2' } });
  const rank = { retire: 0, watch: 1, note: 2 };
  const ranks = assess(j).findings.map((f) => rank[f.severity]);
  assert.ok(ranks.length > 2);
  assert.deepEqual(ranks, ranks.slice().sort((x, y) => x - y));
});

test('deterministic', () => {
  const d = driveOf(loadFixture());
  assert.deepEqual(A.assessDrive(d), A.assessDrive(d));
});

test('selfTestOutcome returns unknown for a non-numeric status', () => {
  assert.equal(A.selfTestOutcome(undefined), 'unknown');
  assert.equal(A.selfTestOutcome(null), 'unknown');
  assert.equal(A.selfTestOutcome('0'), 'unknown');
  assert.equal(A.selfTestOutcome(0), 'pass');
});

test('unknown self-test status is neither failure nor interruption', () => {
  const j = clean();
  delete j.ata_smart_self_test_log.standard.table[0].status;
  const a = assess(j);
  assert.ok(!codes(a).includes('selftest-failed'));
  assert.equal(a.verdict, 'keep');
});

test('RULES is exposed', () => {
  assert.equal(A.RULES.reallocRetire, 100);
  assert.equal(A.RULES.staleLongTestHours, 168);
});

test('every finding short is at most 24 characters and has a detail', () => {
  assert.ok(seen.length > 20);
  seen.forEach((f) => {
    assert.ok(f.short.length <= 24, f.code + ': ' + f.short);
    assert.ok(f.detail && f.detail.length > 10, f.code);
  });
});
