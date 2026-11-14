'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');

test('index.html redirects to the app page, which exists', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const m = html.match(/http-equiv="refresh"\s+content="0;\s*url=([^"]+)"/i);
  assert.ok(m, 'index.html has a meta refresh');
  assert.equal(m[1], 'Drive-Triage.html');
  assert.ok(fs.existsSync(path.join(root, m[1])));
});

test('README does not mention local-only files', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  for (const s of ['docs/superpowers', 'DESIGN.md', 'PRODUCT.md', '.impeccable']) {
    assert.ok(!readme.includes(s), `README mentions ${s}`);
  }
});
