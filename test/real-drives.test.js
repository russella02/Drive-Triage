'use strict';
// Real scans from the owner's drives, kept as regression fixtures.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const A = require('../analysis.js');

function load(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

test('Toshiba packed Command_Timeout raw decodes to its low counter', () => {
  const scan = A.parseScan(JSON.parse(load('toshiba-dt01aca050.json')), 'TOSHIBA_DT01ACA050_74BPAVVAS_2026-11-11_1731.json');
  // raw 12386304 = 0x00BD0000: three 16-bit counters, the first (timeouts) is 0
  assert.equal(scan.attrs[188].raw, 12386304);
  assert.equal(A.attrCount(scan, 188), 0);
});

test('Toshiba DT01ACA050 is not flagged for command timeouts', () => {
  const r = A.analyzeFiles([{ relPath: 'TOSHIBA_DT01ACA050_74BPAVVAS_2026-11-11_1731.json', text: load('toshiba-dt01aca050.json') }]);
  const { assessment } = r.drives[0];
  assert.ok(!assessment.findings.some((f) => f.code === 'cmd-timeout'));
  assert.equal(assessment.verdict, 'keep');
  assert.equal(assessment.health, 99); // only the age deduction: floor((24486-20000)/3000) = 1
});

test('an unpacked small Command_Timeout raw is used as-is on any vendor', () => {
  const json = JSON.parse(load('toshiba-dt01aca050.json'));
  const a188 = json.ata_smart_attributes.table.find((a) => a.id === 188);
  a188.raw.value = 7;
  a188.raw.string = '7';
  const scan = A.parseScan(json, 'x.json');
  assert.equal(A.attrCount(scan, 188), 7);
});
