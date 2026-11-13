'use strict';
const fs = require('fs');
const path = require('path');

// Fresh deep clone of the HDD-01 fixture on every call (tests mutate it freely).
function loadFixture() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'hdd01.json'), 'utf8'));
}

// Patch one SMART attribute (by id) in a smartctl JSON object; returns the same json.
// `patch` may contain value/worst/thresh/when_failed and raw:{value,string}.
function withAttr(json, id, patch) {
  const row = json.ata_smart_attributes.table.find((a) => a.id === id);
  if (!row) throw new Error('attribute ' + id + ' not in fixture');
  const { raw, ...rest } = patch;
  Object.assign(row, rest);
  if (raw) row.raw = Object.assign({}, row.raw, raw);
  return json;
}

module.exports = { loadFixture, withAttr };
