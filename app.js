'use strict';
/*
 * app.js - the Drive Triage page: theme, folder reading (read-only), drive list, datasheet detail.
 * Classic script, no dependencies. Uses window.SmartAnalysis from analysis.js.
 * Scan files are untrusted: every scan-derived string reaches the page through textContent
 * (createTextNode / textContent / setAttribute), never through innerHTML.
 */

const SA = window.SmartAnalysis;
const R = SA.RULES;
const THEME_KEY = 'drive-triage-theme';
const DB_NAME = 'drive-triage';
const DB_STORE = 'handles';
const DB_KEY = 'root';
const MAX_FILE_BYTES = 16 * 1024 * 1024; // a smartctl JSON is ~100 KB; anything huge is not a scan

const VERDICT_LABEL = { retire: 'Retire', watch: 'Watch', keep: 'Keep', unsupported: 'Not supported yet' };
const SEVERITY_LABEL = { retire: 'Retire', watch: 'Watch', note: 'Note' };
const OUTCOME_LABEL = { pass: 'Pass', fail: 'Fail', interrupted: 'Interrupted', running: 'Running', unknown: 'Unknown' };

const ui = {
  folder: document.getElementById('folder'),
  status: document.getElementById('status'),
  rescan: document.getElementById('rescan'),
  printAll: document.getElementById('print-all'),
  rail: document.getElementById('rail'),
  list: document.getElementById('drive-list'),
  main: document.getElementById('main'),
  input: document.getElementById('dir-input'),
  themeButtons: Array.from(document.querySelectorAll('[data-theme-choice]'))
};

const state = {
  entries: null,       // [{ drive, assessment }] once a folder has been read
  scanCount: 0,
  skipped: 0,
  jsonCount: 0,
  selectedKey: null,
  root: null,          // FileSystemDirectoryHandle in use
  savedHandle: null,   // handle remembered from a previous visit
  rootName: '',
  loading: false,
  scanGen: 0          // bumps on every folder read; an older read that finishes late is dropped
};

const hasPicker = typeof window.showDirectoryPicker === 'function';

// ------------------------------------------------------------------ labels (Task 4)
// One 2in x 1in label per drive, built with textContent only (scan data is untrusted).
// Lines that are too wide shrink 0.25pt at a time down to 6pt, then truncate with an ellipsis.
const LABEL_MIN_PT = 6;
const LABEL_STEP_PT = 0.25;

function buildLabel(L) {
  const line = (cls, text) => {
    const el = document.createElement('div');
    el.className = 'label-line ' + cls;
    el.dataset.fit = '1';
    el.textContent = text;
    return el;
  };
  const label = document.createElement('section');
  label.className = 'label';
  const head = document.createElement('div');
  head.className = 'label-head';
  const health = document.createElement('div');
  health.className = 'label-health';
  health.textContent = L.health;
  head.append(line('label-name', L.name), health);
  label.append(head, line('label-l2', L.line2), line('label-l3', L.line3),
    line('label-l4', L.line4), line('label-l5', L.line5));
  return label;
}

function fitLabel(label) {
  label.querySelectorAll('[data-fit]').forEach((el) => {
    let pt = Math.round(parseFloat(getComputedStyle(el).fontSize) * 0.75 * 4) / 4;
    while (el.scrollWidth > el.clientWidth && pt - LABEL_STEP_PT >= LABEL_MIN_PT) {
      pt -= LABEL_STEP_PT;
      el.style.fontSize = pt + 'pt';
    }
  });
}

function clearPrintArea() {
  const area = document.getElementById('print-area');
  if (area) area.textContent = '';
  document.documentElement.classList.remove('printing-labels');
  const page = document.getElementById('label-page-size');
  if (page) page.remove();
}

function printLabels(entries) {
  const area = document.getElementById('print-area');
  if (!area || !entries || !entries.length) return;
  area.textContent = '';
  entries.forEach((e) => area.appendChild(buildLabel(SA.labelLines(e.drive, e.assessment))));
  // Measure at print size: off-screen, but laid out like the printed page.
  area.classList.add('measuring');
  Array.from(area.children).forEach(fitLabel);
  area.classList.remove('measuring');
  document.documentElement.classList.add('printing-labels');
  // @page cannot be scoped by a class, so the 2in x 1in sheet size exists only while labels print.
  if (!document.getElementById('label-page-size')) {
    const page = document.createElement('style');
    page.id = 'label-page-size';
    page.textContent = '@page { size: 2in 1in; margin: 0; }';
    document.head.appendChild(page);
  }
  window.print();
}
window.addEventListener('afterprint', clearPrintArea);

// ------------------------------------------------------------------------- DOM
// h('p', { class: 'x', text: 'y' }, child, 'text', [more]) - strings become text nodes.
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    Object.keys(props).forEach((k) => {
      const v = props[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = String(v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    });
  }
  appendKids(el, kids);
  return el;
}
function appendKids(el, kids) {
  kids.forEach((c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) appendKids(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  });
}
const SVGNS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, text) {
  const el = document.createElementNS(SVGNS, tag);
  Object.keys(attrs || {}).forEach((k) => el.setAttribute(k, attrs[k]));
  if (text !== undefined) el.textContent = text;
  return el;
}
function chip(kind, text, extra) {
  return h('span', { class: 'chip ' + kind + (extra ? ' ' + extra : ''), text });
}
function joinDot(parts) {
  const out = [];
  parts.filter((p) => p !== null && p !== undefined && p !== '').forEach((p, i) => {
    if (i) out.push(' · ');
    out.push(p);
  });
  return out;
}

// ------------------------------------------------------------------- formatting
const pad = (n) => String(n).padStart(2, '0');
function fmtInt(n) { return Number(n).toLocaleString('en-US'); }
function plural(n, one, many) { return fmtInt(n) + ' ' + (n === 1 ? one : (many || one + 's')); }
function fmtDate(t) {
  if (t === null || t === undefined) return 'unknown date';
  const d = new Date(t * 1000);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function fmtClock(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function fmtDateTime(t) {
  if (t === null || t === undefined) return 'unknown date';
  return fmtDate(t) + ' ' + fmtClock(new Date(t * 1000));
}
function fmtYears(hours) { return (Math.round(hours / 8766 * 10) / 10).toFixed(1); }
function fmtSpan(min) {
  if (min < 60) return min + ' min';
  const hrs = Math.floor(min / 60);
  const m = min % 60;
  return m ? hrs + ' h ' + m + ' min' : hrs + ' h';
}
function topFinding(a) {
  return a.findings.find((f) => f.severity === 'retire' || f.severity === 'watch') || null;
}
function entryByKey(key) {
  return (state.entries || []).find((e) => e.drive.key === key) || null;
}

// ------------------------------------------------------------------------ theme
const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
function readThemePref() {
  try {
    const p = localStorage.getItem(THEME_KEY);
    return p === 'light' || p === 'dark' ? p : 'system';
  } catch (e) {
    return 'system';
  }
}
function saveThemePref(pref) {
  try {
    if (pref === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch (e) { /* storage blocked: the choice lasts for this visit only */ }
}
function applyTheme(pref) {
  const dark = pref === 'dark' || (pref === 'system' && !!darkQuery && darkQuery.matches);
  const root = document.documentElement;
  // swap colours instantly: hover/selection transitions must not animate a theme change
  root.classList.add('theme-swap');
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-swap')));
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme-pref', pref);
  ui.themeButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeChoice === pref)));
}

// -------------------------------------------------------------------- IndexedDB
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}
async function idbRequest(mode, fn) {
  const db = await idbOpen();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, mode);
      const req = fn(tx.objectStore(DB_STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
}
async function loadSavedHandle() {
  try {
    return (await withTimeout(idbRequest('readonly', (s) => s.get(DB_KEY)), 2000)) || null;
  } catch (e) {
    return null;
  }
}
async function saveHandle(handle) {
  try { await idbRequest('readwrite', (s) => s.put(handle, DB_KEY)); } catch (e) { /* next visit starts fresh */ }
}

// ------------------------------------------------------------- folder reading
async function walk(dir, prefix, out, counter, stale) {
  for await (const [name, handle] of dir.entries()) {
    if (stale()) return; // a newer folder read has started
    if (handle.kind === 'directory') {
      try {
        await walk(handle, prefix + name + '/', out, counter, stale);
      } catch (e) {
        counter.unreadable++;
      }
      continue;
    }
    if (!/\.json$/i.test(name)) continue;
    try {
      const file = await handle.getFile();
      if (file.size > MAX_FILE_BYTES) { counter.unreadable++; continue; }
      out.push({ relPath: prefix + name, text: await file.text() });
    } catch (e) {
      counter.unreadable++; // e.g. a cloud-only file that could not be fetched
    }
  }
}

async function chooseFolder() {
  if (!hasPicker) {
    ui.input.value = '';
    ui.input.click();
    return;
  }
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: 'drive-triage', mode: 'read' });
  } catch (e) {
    if (e && e.name === 'AbortError') return; // the user closed the picker
    renderIntro('error', { error: e });
    return;
  }
  state.root = handle;
  state.savedHandle = handle;
  state.rootName = handle.name;
  state.selectedKey = null;
  state.entries = null; // a different folder: do not show the old one's drives under the new name
  saveHandle(handle);
  await scanRoot();
}

async function reopenSaved() {
  const handle = state.savedHandle;
  if (!handle) { chooseFolder(); return; }
  let perm;
  try {
    perm = await handle.requestPermission({ mode: 'read' });
  } catch (e) {
    renderIntro('error', { error: e });
    return;
  }
  if (perm !== 'granted') {
    renderIntro('reopen', { denied: true });
    return;
  }
  state.root = handle;
  state.rootName = handle.name;
  await scanRoot();
}

async function scanRoot() {
  if (!state.root) return;
  const gen = ++state.scanGen;
  const stale = () => gen !== state.scanGen;
  setLoading(true);
  const files = [];
  const counter = { unreadable: 0 };
  try {
    await walk(state.root, '', files, counter, stale);
  } catch (e) {
    if (stale()) return;
    setLoading(false);
    renderIntro('error', { error: e });
    return;
  }
  if (stale()) return;
  setLoading(false);
  ingest(files, counter.unreadable);
}

async function readPickedFiles(fileList) {
  const list = Array.from(fileList || []);
  if (!list.length) return;
  const rel = (f) => String(f.webkitRelativePath || f.name);
  const gen = ++state.scanGen;
  state.root = null;
  state.rootName = rel(list[0]).split('/')[0] || 'Selected folder';
  state.selectedKey = null;
  state.entries = null;
  setLoading(true);
  const files = [];
  let unreadable = 0;
  for (const f of list) {
    if (gen !== state.scanGen) return; // a newer folder read has started
    if (!/\.json$/i.test(f.name)) continue;
    if (f.size > MAX_FILE_BYTES) { unreadable++; continue; }
    try {
      // webkitRelativePath starts with the chosen folder's own name; drop it so paths match the picker.
      files.push({ relPath: rel(f).split('/').slice(1).join('/') || f.name, text: await f.text() });
    } catch (e) {
      unreadable++;
    }
  }
  if (gen !== state.scanGen) return;
  setLoading(false);
  ingest(files, unreadable);
}

function ingest(files, unreadable) {
  try {
    showResults(files, unreadable);
  } catch (e) {
    // an unexpected scan shape must not leave the page stuck on "Reading..."
    setLoading(false);
    state.entries = null;
    renderIntro('error', { error: e });
  }
}

function showResults(files, unreadable) {
  const res = SA.analyzeFiles(files);
  state.entries = res.drives;
  state.scanCount = res.scanCount;
  state.skipped = res.skipped + (unreadable || 0);
  state.jsonCount = files.length + (unreadable || 0);
  updateStatus();
  if (!state.entries.length) {
    renderIntro('empty');
    return;
  }
  if (!entryByKey(state.selectedKey)) state.selectedKey = state.entries[0].drive.key;
  renderLoaded();
}

function setLoading(on) {
  state.loading = on;
  ui.rescan.disabled = on;
  ui.rescan.textContent = on ? 'Reading…' : 'Rescan';
  ui.main.setAttribute('aria-busy', String(on));
  if (on) {
    ui.status.textContent = 'Reading ' + (state.rootName || 'folder') + '…';
    if (!state.entries) renderIntro('loading');
  }
}

function updateStatus() {
  const n = state.entries ? state.entries.length : 0;
  ui.status.textContent = plural(state.scanCount, 'scan') + ' · ' + plural(n, 'drive') + ' · '
    + plural(state.skipped, 'file') + ' skipped';
}

function rescan() {
  if (state.root) scanRoot();
  else chooseFolder(); // the fallback file input has to be picked again to see new files
}

// ----------------------------------------------------------------- intro states
function renderIntro(kind, opts) {
  opts = opts || {};
  disconnectCurve();
  const name = state.rootName;
  ui.rail.hidden = true;
  ui.rescan.hidden = true;
  ui.printAll.hidden = true;
  ui.folder.hidden = !name || kind === 'reopen' || kind === 'first';
  ui.folder.textContent = name;
  if (kind !== 'loading' && kind !== 'empty') ui.status.textContent = '';

  const chooseBtn = (label, cls) => h('button', { type: 'button', class: 'btn ' + cls, onclick: chooseFolder }, label);
  const readOnly = h('p', { class: 'intro-note', text: 'Read-only: Drive Triage never changes, moves or deletes your scan files.' });
  let head;
  let body = [];
  let actions = [];
  let after = [];
  let notice = null;

  if (kind === 'first') {
    head = 'Choose your scan folder';
    body = [
      'Pick the folder where you save GSmartControl scans as JSON, ideally with one subfolder per drive. '
        + 'Drive Triage reads every .json file inside it, groups the scans by drive, and lists the drives that need attention first.'
    ];
    actions = [chooseBtn('Choose folder', 'fill')];
    after = [readOnly, h('div', { class: 'intro-tree', 'aria-label': 'Example folder layout', role: 'img',
      text: 'Hard Drive Tests/\n  HDD-01/\n    HDD-01-<model>_<serial>_<date>_<time>.json\n  HDD-02/\n    …' })];
  } else if (kind === 'reopen') {
    head = 'Reopen ' + name;
    body = [
      'This is the folder you used last time. Your browser asks for permission once per visit before Drive Triage can read it again.'
    ];
    if (opts.denied) body.push('Permission was not given, so nothing was read. Reopen and choose Allow, or pick another folder.');
    actions = [
      h('button', { type: 'button', class: 'btn fill', onclick: reopenSaved }, 'Reopen ' + name),
      chooseBtn('Choose a different folder', 'ghost')
    ];
    after = [readOnly];
  } else if (kind === 'loading') {
    head = 'Reading ' + (name || 'folder') + '…';
    body = ['Collecting the JSON scans in this folder and its subfolders.'];
  } else if (kind === 'empty') {
    head = 'No scans in ' + name;
    body = [
      state.jsonCount
        ? 'Drive Triage found ' + plural(state.jsonCount, '.json file') + ' here, but none is a smartctl scan.'
        : 'There are no .json files in this folder or its subfolders.',
      'Save each drive’s scan as JSON from GSmartControl, or run smartctl -x --json=o <device> (add -d sat,16 for a USB bridge), into this folder, one subfolder per drive, then rescan.'
    ];
    actions = [
      h('button', { type: 'button', class: 'btn fill', onclick: rescan }, 'Rescan'),
      chooseBtn('Choose a different folder', 'ghost')
    ];
  } else {
    head = 'Could not read ' + (name || 'the folder');
    const reason = opts.error && opts.error.name === 'NotAllowedError'
      ? 'The browser did not allow access to the folder.'
      : 'The browser reported: ' + String((opts.error && (opts.error.message || opts.error.name)) || 'unknown error');
    body = ['Nothing was changed. Choose the folder again to retry.'];
    notice = h('p', { class: 'intro-error', role: 'alert' }, h('b', { text: 'Error. ' }), reason);
    actions = [chooseBtn('Choose folder', 'fill')];
  }

  const section = h('section', { class: 'intro', 'aria-labelledby': 'intro-head' },
    h('h2', { class: 'intro-head', id: 'intro-head', text: head }),
    body.map((t) => h('p', { class: 'intro-text', text: t })),
    notice,
    actions.length ? h('div', { class: 'intro-actions' }, actions) : null,
    after);
  ui.main.replaceChildren(section);
}

// ------------------------------------------------------------------- drive list
function renderLoaded() {
  ui.rail.hidden = false;
  ui.rescan.hidden = false;
  ui.printAll.hidden = false;
  ui.folder.hidden = false;
  ui.folder.textContent = state.rootName;
  ui.list.replaceChildren(...state.entries.map(driveRow));
  select(state.selectedKey);
}

function unsupportedReason(scan) {
  return scan.protocol === 'ATA'
    ? 'SMART attributes not readable (SMART off or bridge not passing commands)'
    : 'NVMe, SAS or other non-ATA drive';
}

function driveRow(entry, i) {
  const d = entry.drive;
  const a = entry.assessment;
  const top = topFinding(a);
  const reason = a.verdict === 'unsupported' ? unsupportedReason(d.latest)
    : top ? top.short : 'No problems found';
  const meta = joinDot([SA.formatCapacity(d.latest.capacityBytes), plural(d.scans.length, 'scan'), 'last ' + fmtDate(d.latest.time)]);
  const health = a.health === null ? '—' : String(a.health);
  return h('li', {
    id: 'drive-' + i,
    class: 'drive',
    role: 'option',
    'aria-selected': 'false',
    'data-key': d.key,
    'aria-label': d.name + ', ' + VERDICT_LABEL[a.verdict] + (a.health === null ? '' : ', health ' + a.health) + ', ' + reason,
    onclick: () => select(d.key)
  },
  h('span', { class: 'drive-id', text: d.name }),
  h('span', { class: 'drive-health' + (a.health === null ? ' none' : ''), text: health }),
  h('span', { class: 'drive-model', text: d.model || 'unknown model' }),
  chip(a.verdict, VERDICT_LABEL[a.verdict]),
  h('span', { class: 'drive-reason', text: reason }),
  h('span', { class: 'drive-meta' }, meta));
}

function select(key) {
  const entry = entryByKey(key);
  if (!entry) return;
  state.selectedKey = key;
  let active = null;
  Array.from(ui.list.children).forEach((li) => {
    const on = li.getAttribute('data-key') === key;
    li.setAttribute('aria-selected', String(on));
    if (on) active = li;
  });
  if (active) {
    ui.list.setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView({ block: 'nearest' });
  }
  renderDetail(entry);
}

function onListKey(ev) {
  if (!state.entries || !state.entries.length || ev.ctrlKey || ev.altKey || ev.metaKey) return;
  const n = state.entries.length;
  let i = state.entries.findIndex((e) => e.drive.key === state.selectedKey);
  if (ev.key === 'ArrowDown') i = Math.min(n - 1, i + 1);
  else if (ev.key === 'ArrowUp') i = Math.max(0, i - 1);
  else if (ev.key === 'Home') i = 0;
  else if (ev.key === 'End') i = n - 1;
  else return;
  ev.preventDefault();
  select(state.entries[i].drive.key);
}

// ----------------------------------------------------------------- drive detail
function renderDetail(entry) {
  disconnectCurve();
  const a = entry.assessment;
  const s = entry.drive.latest;
  const parts = [masthead(entry)];
  if (a.verdict === 'unsupported') {
    parts.push(unsupportedSection(a), rawSection(s));
  } else {
    parts.push(
      curveSection(s),
      h('div', { class: 'sec cols' }, findingsBlock(a), limitsBlock(s, a)),
      historySection(entry.drive),
      selfTestSection(s),
      attributesSection(s),
      rawSection(s));
  }
  ui.main.replaceChildren(...parts);
}

function masthead(entry) {
  const d = entry.drive;
  const a = entry.assessment;
  const s = d.latest;
  const mono = (t) => h('span', { class: 'mono', text: t });
  // each field is a no-wrap group, so narrow screens break lines only between fields
  const field = (...kids) => h('span', { class: 'nw' }, kids);
  const cap = SA.formatCapacity(s.capacityBytes);
  const sub = h('p', { class: 'mast-sub' }, joinDot([
    s.model ? field(mono(s.model)) : null,
    s.family ? field(s.family) : null,
    cap ? field(cap) : null,
    s.firmware ? field('FW ', mono(s.firmware)) : null
  ]));
  const score = h('div', { class: 'score' },
    h('p', { class: 'score-line' },
      h('span', { class: 'vh', text: 'Health ' }),
      a.health === null ? null : h('span', { class: 'score-n', text: String(a.health) }),
      h('span', { class: 'score-band', text: a.band || 'No health score' })),
    a.health === null ? null : h('p', { class: 'score-note', text: 'An estimate from SMART data, not a prediction.' }));
  const top = topFinding(a);
  let lead = null;
  if (top) {
    const others = a.findings.filter((f) => f !== top && f.severity !== 'note').length;
    lead = h('p', { class: 'mast-lead' },
      h('b', { text: top.short + '.' }), ' ', top.detail,
      others ? ' ' + plural(others, 'more finding') + ' below.' : null);
  }
  return h('header', { class: 'mast' },
    h('div', { class: 'mast-name' },
      h('h2', { class: 'mast-id', text: d.name }),
      sub),
    score,
    chip(a.verdict, VERDICT_LABEL[a.verdict], 'big'),
    a.verdict === 'unsupported' ? null
      : h('button', { type: 'button', class: 'btn ghost', onclick: () => printLabels([entry]) }, 'Print label'),
    lead);
}

function sectionHead(title, aside) {
  return h('div', { class: 'sec-head' }, h('h3', { class: 'sc', text: title }), aside || null);
}

function unsupportedSection(a) {
  return h('section', { class: 'sec' },
    h('div', { class: 'unsupported-note' },
      h('p', { text: a.findings[0].detail }),
      h('p', { text: 'The raw smartctl output is below.' })));
}

// ------------------------------------------------------------- findings, limits
function findingsBlock(a) {
  const items = a.findings.length
    ? a.findings.map((f) => h('li', null,
      chip(f.severity === 'note' ? 'note' : f.severity, SEVERITY_LABEL[f.severity]),
      h('div', null, h('b', { text: f.short }), ' — ', f.detail)))
    : [h('li', null, chip('keep', 'Keep'), h('div', { class: 'none', text: 'No problems found. Every check passed.' }))];
  return h('section', { 'aria-labelledby': 'h-findings' },
    h('div', { class: 'sec-head' }, h('h3', { class: 'sc', id: 'h-findings', text: 'Findings' })),
    h('ul', { class: 'findings' }, items));
}

const SEVERITY_RANK = { retire: 3, watch: 2, note: 1, none: 0 };

function limitRows(s, a) {
  const pick = (codes, grewLabel) => a.findings.filter((f) => codes.indexOf(f.code) >= 0
    || (grewLabel && f.code === 'grew' && f.short.indexOf(grewLabel) === 0));
  const count = (id) => SA.attrCount(s, id);
  const countText = (id) => { const n = count(id); return n === null ? null : fmtInt(n); };
  const t = s.temp || {};
  const temp = t.current === null && t.lifetimeMax === null ? null
    : [t.current === null ? null : t.current + ' °C now', t.lifetimeMax === null ? null : t.lifetimeMax + ' °C max'].filter(Boolean).join(', ');
  const tests = s.selfTests || [];
  const li = tests.findIndex((x) => /extended/i.test(String(x.type || '')));
  let longTest;
  if (li >= 0) {
    const x = tests[li];
    longTest = OUTCOME_LABEL[SA.selfTestOutcome(x.statusValue)] + (typeof x.hours === 'number' ? ' at ' + fmtInt(x.hours) + ' h' : '');
  } else {
    longTest = tests.length === 0 && s.satNeeds16 ? 'log unreadable' : 'none in log';
  }
  return [
    { name: 'SMART overall check', value: s.smartPassed === null ? null : s.smartPassed ? 'Passed' : 'Failed',
      limit: 'must pass', f: pick(['smart-failed', 'failing-now']) },
    { name: 'Reallocated sectors', value: countText(5),
      limit: 'watch 1+, retire ' + (R.reallocRetire + 1) + '+', f: pick(['realloc', 'realloc-high'], 'Realloc') },
    { name: 'Pending sectors', value: countText(197), limit: 'retire above 0', f: pick(['pending'], 'Pending') },
    { name: 'Offline uncorrectable', value: countText(198), limit: 'retire above 0', f: pick(['offline-unc'], 'Offline') },
    { name: 'Reported uncorrectable', value: countText(187), limit: 'retire above 0', f: pick(['reported-unc'], 'Uncorrect') },
    { name: 'Spin retries', value: countText(10), limit: 'watch above 0', f: pick(['spin-retry']) },
    { name: 'Command timeouts', value: countText(188), limit: 'watch above ' + R.cmdTimeoutWatch, f: pick(['cmd-timeout']) },
    { name: 'Temperature', value: temp,
      limit: 'watch at ' + R.tempCurrentWatch + ' °C now, ' + R.tempLifetimeWatch + ' max', f: pick(['temp-hot', 'temp-warm']) },
    { name: 'Power-on hours', value: s.powerOnHours === null ? null : fmtInt(s.powerOnHours) + ' h (' + fmtYears(s.powerOnHours) + ' yr)',
      limit: 'watch at ' + fmtInt(R.oldHours) + ' h', f: pick(['old']) },
    { name: 'Last long self-test', value: longTest,
      limit: 'watch if none or ' + R.staleLongTestHours + '+ h old', f: pick(['no-long-test', 'stale-long-test']) }
  ];
}

function limitsBlock(s, a) {
  const rows = limitRows(s, a).map((r) => {
    const worst = r.f.reduce((w, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[w] ? f.severity : w), 'none');
    const status = worst === 'none'
      ? (r.value === null ? h('span', { class: 'muted', text: '—' }) : chip('ok', 'OK'))
      : chip(worst, SEVERITY_LABEL[worst]);
    return h('tr', { class: worst === 'retire' || worst === 'watch' ? 'flag' : null },
      h('td', { text: r.name }),
      r.value === null ? h('td', { class: 'muted', text: 'not reported' }) : h('td', { class: 'v', text: r.value }),
      h('td', { class: 'limit', text: r.limit }),
      h('td', null, status));
  });
  return h('section', { 'aria-labelledby': 'h-limits' },
    h('div', { class: 'sec-head' }, h('h3', { class: 'sc', id: 'h-limits', text: 'Limits' })),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'limits' },
        h('thead', null, h('tr', null, h('th', { text: 'Measure' }), h('th', { text: 'Value' }), h('th', { text: 'Drive Triage limit' }), h('th', { text: 'Status' }))),
        h('tbody', null, rows))));
}

// ----------------------------------------------------------------------- history
function historySection(d) {
  const scans = d.scans; // oldest -> newest
  const rows = scans.map((scan, i) => {
    const prev = i ? scans[i - 1] : null;
    const health = SA.assessDrive({ key: d.key, name: d.name, serial: d.serial, model: d.model,
      scans: scans.slice(0, i + 1), latest: scan, previous: prev }).health;
    return { scan, prev, health };
  });
  let prevHealth = null;
  rows.forEach((r) => { r.prevHealth = prevHealth; prevHealth = r.health; });

  const cell = (now, before) => {
    if (now === null || now === undefined) return h('td', { class: 'num muted', text: '—' });
    if (before === null || before === undefined || before === now) return h('td', { class: 'num', text: fmtInt(now) });
    return h('td', { class: 'num changed' },
      h('del', null, h('span', { class: 'vh', text: 'was ' }), fmtInt(before)),
      h('span', { class: 'now' }, h('span', { class: 'vh', text: ', now ' }), fmtInt(now)));
  };
  const cnt = (scan, id) => (scan ? SA.attrCount(scan, id) : null);
  const body = rows.slice().reverse().map((r) => h('tr', null,
    h('td', { class: 'v', text: fmtDateTime(r.scan.time) }),
    h('td', { class: 'num', text: r.scan.powerOnHours === null ? '—' : fmtInt(r.scan.powerOnHours) }),
    cell(cnt(r.scan, 5), cnt(r.prev, 5)),
    cell(cnt(r.scan, 197), cnt(r.prev, 197)),
    cell(cnt(r.scan, 198), cnt(r.prev, 198)),
    cell(cnt(r.scan, 187), cnt(r.prev, 187)),
    cell(r.health, r.prevHealth)));
  const note = scans.length === 1
    ? 'First scan — nothing to compare yet.'
    : 'Newest first. A struck-through number is the value from the scan before.';
  return h('section', { class: 'sec', 'aria-labelledby': 'h-history' },
    h('div', { class: 'sec-head' },
      h('h3', { class: 'sc', id: 'h-history', text: 'History' }),
      h('span', { class: 'sec-aside', text: plural(scans.length, 'scan') })),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'history' },
        h('thead', null, h('tr', null,
          h('th', { text: 'Scanned' }), h('th', { class: 'num', text: 'Power-on hours' }),
          h('th', { class: 'num', text: 'Reallocated' }), h('th', { class: 'num', text: 'Pending' }),
          h('th', { class: 'num', text: 'Offline unc.' }), h('th', { class: 'num', text: 'Reported unc.' }),
          h('th', { class: 'num', text: 'Health' }))),
        h('tbody', null, body))),
    h('p', { class: 'table-note', text: note }));
}

// --------------------------------------------------------------------- self-tests
function selfTestSection(s) {
  const tests = s.selfTests || [];
  let content;
  if (!tests.length) {
    content = h('p', { class: 'table-note', text: s.satNeeds16
      ? 'The self-test log could not be read in this scan. Scanning again with smartctl -x --json=o -d sat,16 <device> may show it.'
      : 'No self-tests in the log yet.' });
  } else {
    const rows = tests.map((x) => {
      const o = SA.selfTestOutcome(x.statusValue);
      return h('tr', { class: o === 'fail' ? 'flag' : null },
        h('td', { text: x.type || 'Unknown type' }),
        h('td', null, chip(o === 'fail' ? 'retire' : 'note', OUTCOME_LABEL[o])),
        h('td', { class: 'num', text: typeof x.hours === 'number' ? fmtInt(x.hours) : '—' }),
        h('td', { class: 'muted', text: x.statusString || '' }));
    });
    content = h('div', { class: 'table-wrap' },
      h('table', { class: 'selftests' },
        h('thead', null, h('tr', null, h('th', { text: 'Test' }), h('th', { text: 'Result' }),
          h('th', { class: 'num', text: 'At power-on hours' }), h('th', { text: 'Drive’s message' }))),
        h('tbody', null, rows)));
  }
  return h('section', { class: 'sec', 'aria-labelledby': 'h-selftests' },
    h('div', { class: 'sec-head' },
      h('h3', { class: 'sc', id: 'h-selftests', text: 'Self-tests' }),
      tests.length ? h('span', { class: 'sec-aside', text: 'Newest first' }) : null),
    content);
}

// --------------------------------------------------------------------- attributes
const SEAGATE_PACKED = [1, 7, 195];

function attributesSection(s) {
  const ids = Object.keys(s.attrs).map(Number).sort((x, y) => x - y);
  const seagate = s.vendor === 'Seagate';
  const rows = ids.map((id) => {
    const at = s.attrs[id];
    const raw = typeof at.raw === 'number' ? at.raw : null;
    const packed = seagate && SEAGATE_PACKED.indexOf(id) >= 0;
    let decoded = '';
    if (packed) decoded = 'vendor-packed, not used';
    else if (raw !== null && id === 188) {
      const w = [raw % 65536, Math.floor(raw / 65536) % 65536, Math.floor(raw / 4294967296) % 65536];
      decoded = plural(w[0], 'timeout') + ' (counters ' + w.join(' · ') + ')';
    } else if (raw !== null && (id === 190 || id === 194)) decoded = (raw % 256) + ' °C';
    const failed = at.whenFailed === 'now' ? chip('retire', 'Now')
      : at.whenFailed === 'past' ? chip('watch', 'Past') : h('span', { class: 'muted', text: '—' });
    const show = (v) => (typeof v === 'number' ? String(v) : '—');
    return h('tr', { class: at.whenFailed ? 'flag' : null },
      h('td', { class: 'num', text: String(id) }),
      h('td', { text: String(at.name || 'Attribute ' + id).replace(/_/g, ' ') }),
      h('td', { class: 'num', text: show(at.value) }),
      h('td', { class: 'num', text: show(at.worst) }),
      h('td', { class: 'num', text: show(at.thresh) }),
      h('td', { class: 'num v' + (packed ? ' muted' : ''), text: raw === null ? String(at.rawString || '—') : String(raw) }),
      h('td', { class: packed ? 'muted' : null, text: decoded }),
      h('td', null, failed));
  });
  return h('section', { class: 'sec', 'aria-labelledby': 'h-attrs' },
    h('div', { class: 'sec-head' },
      h('h3', { class: 'sc', id: 'h-attrs', text: 'Attributes' }),
      h('span', { class: 'sec-aside', text: plural(ids.length, 'attribute') })),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'attrs' },
        h('thead', null, h('tr', null,
          h('th', { class: 'num', text: 'ID' }), h('th', { text: 'Attribute' }),
          h('th', { class: 'num', text: 'Value' }), h('th', { class: 'num', text: 'Worst' }),
          h('th', { class: 'num', text: 'Threshold' }), h('th', { class: 'num', text: 'Raw' }),
          h('th', { text: 'Decoded' }), h('th', { text: 'Failed' }))),
        h('tbody', null, rows))),
    h('p', { class: 'table-note', text: 'Value, Worst and Threshold are the drive’s own normalized scores: higher is better, and a value at or below its threshold counts as failing. Raw is the drive’s counter behind the score.' }));
}

function rawSection(s) {
  return h('section', { class: 'sec' },
    h('details', { class: 'raw' },
      h('summary', null, 'Raw smartctl output ', h('span', { class: 'muted mono', text: '· ' + s.relPath })),
      h('pre', { text: s.rawOutput || '(this scan has no text output)' })));
}

// -------------------------------------------------------------------------- curve
// Null runs in the SCT log separated by MERGE_GAP or fewer readings form one band: [[start, end]].
const MERGE_GAP = 3;
function unreadBands(hist) {
  const bands = [];
  for (let i = 0; i < hist.length; i++) {
    if (hist[i] !== null) continue;
    let j = i;
    while (j + 1 < hist.length && hist[j + 1] === null) j++;
    const prev = bands[bands.length - 1];
    if (prev && i - prev[1] - 1 <= MERGE_GAP) prev[1] = j; else bands.push([i, j]);
    i = j;
  }
  return bands;
}

let curveObserver = null;
function disconnectCurve() {
  if (curveObserver) { curveObserver.disconnect(); curveObserver = null; }
}

function curveSection(s) {
  const hist = s.tempHistory || [];
  const known = hist.filter((v) => v !== null);
  const t = s.temp || {};
  const nowMax = [
    typeof t.current === 'number' ? 'Now ' + t.current + ' °C' : null,
    typeof t.lifetimeMax === 'number' ? 'lifetime max ' + t.lifetimeMax + ' °C' : null
  ].filter(Boolean).join(', ');
  if (!known.length) {
    return h('section', { class: 'sec', 'aria-labelledby': 'h-curve' },
      h('div', { class: 'sec-head' }, h('h3', { class: 'sc', id: 'h-curve', text: 'Temperature' })),
      h('div', { class: 'empty-plot' },
        h('p', { text: 'No temperature history in this scan.' }),
        h('p', { text: 'The drive keeps no SCT temperature log, or this scan could not read it.' + (nowMax ? ' ' + nowMax + '.' : '') })));
  }
  const iv = s.tempIntervalMinutes || 1; // minutes between SCT samples
  const span = (hist.length - 1) * iv;
  const readout = h('span', { class: 'sec-aside', 'aria-live': 'polite', text: 'Hover or use the arrow keys to read values' });
  const plot = h('div', {
    class: 'plot',
    tabindex: '0',
    role: 'group',
    'aria-roledescription': 'chart',
    'aria-label': 'Temperature over the ' + fmtSpan(span) + ' before this scan, ' + (iv === 1 ? 'one sample per minute' : 'one sample every ' + iv + ' minutes') + '. '
      + (nowMax ? nowMax + '. ' : '') + 'Use the Left and Right arrow keys to read each sample.'
  });
  const section = h('section', { class: 'sec', 'aria-labelledby': 'h-curve' },
    h('div', { class: 'sec-head' },
      h('h3', { class: 'sc', id: 'h-curve', text: 'Temperature, the ' + fmtSpan(span) + ' before this scan' }),
      readout),
    plot);
  mountCurve(plot, readout, s);
  return section;
}

function mountCurve(plot, liveRegion, s) {
  const hist = s.tempHistory;
  const n = hist.length;
  const tip = h('div', { class: 'readout', hidden: true, 'aria-hidden': 'true' });
  let geo = null;      // geometry of the last draw
  let index = null;    // sample under the crosshair
  let lastWidth = 0;

  const iv = s.tempIntervalMinutes || 1; // minutes between samples; the last sample is at the scan time
  const span = (n - 1) * iv;
  const sampleDate = (i) => (s.time === null ? null : new Date((s.time - (n - 1 - i) * iv * 60) * 1000));
  const describe = (i) => {
    const v = hist[i];
    const before = (n - 1 - i) * iv;
    const d = sampleDate(i);
    const when = (d ? fmtClock(d) + ', ' : '') + (before === 0 ? 'last logged sample' : fmtSpan(before) + ' before the scan');
    return { value: v === null ? 'sensor unread' : v + ' °C', when };
  };

  function draw(width) {
    const W = Math.max(280, Math.round(width));
    const H = W < 640 ? 220 : 272;
    const m = { l: 44, r: 14, t: 14, b: 26 };
    const pw = W - m.l - m.r;
    const ph = H - m.t - m.b;
    const known = hist.filter((v) => v !== null);
    const life = s.temp && typeof s.temp.lifetimeMax === 'number' ? s.temp.lifetimeMax : null;
    const watch = R.tempCurrentWatch; // the curve plots instantaneous temperature
    let lo = Math.min.apply(null, known);
    let hi = Math.max.apply(null, known.concat([watch], life === null ? [] : [life]));
    let y0 = Math.floor((lo - 3) / 5) * 5;
    const y1 = Math.ceil((hi + 3) / 5) * 5;
    if (y1 - y0 < 25) y0 = y1 - 25;
    const x = (i) => m.l + (n === 1 ? pw : i * pw / (n - 1));
    const y = (v) => m.t + (y1 - v) * ph / (y1 - y0);
    geo = { W, H, m, pw, ph, x, y };

    const root = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, width: String(W), height: String(H), 'aria-hidden': 'true', focusable: 'false' });

    // graph paper: minor cells under major lines (5 degrees, clock ticks); labels every 5 or 10 degrees
    const labelEvery = ph / ((y1 - y0) / 5) < 20 ? 10 : 5;
    const pxPerMin = span > 0 ? pw / span : pw;
    const step = [5, 10, 15, 30, 60, 120, 240, 480].find((st) => st * pxPerMin >= 90) || 480;
    const sub = [10, 6, 5, 4, 3, 2].find((k) => step % k === 0 && (step / k) * pxPerMin >= 12) || 1;
    const minorH = [];
    const gridH = [];
    for (let v = y0; v <= y1; v += 2.5) minorH.push('M' + m.l + ' ' + y(v).toFixed(1) + 'H' + (m.l + pw));
    for (let v = y0; v <= y1; v += 5) gridH.push('M' + m.l + ' ' + y(v).toFixed(1) + 'H' + (m.l + pw));
    for (let v = y0; v <= y1; v += 5) {
      if (v % labelEvery) continue;
      root.append(svg('text', { x: m.l - 8, y: (y(v) + 4).toFixed(1), 'text-anchor': 'end' }, v === y1 ? v + ' °C' : String(v)));
    }

    // time ticks on round clock minutes, at least ~90px apart, with minor lines between them.
    // Ticks are placed by time, not by sample, so any logging interval lands on the right minute.
    const gridV = [];
    const minorV = [];
    const minorStep = step / sub;
    // local wall-clock minutes of the last sample (or 0 = "the scan" when the scan time is unknown)
    const endMin = s.time === null ? 0 : Math.round(s.time / 60) - new Date(s.time * 1000).getTimezoneOffset();
    const startMin = endMin - span;
    const xt = (tm) => m.l + (span > 0 ? (tm - startMin) / span * pw : pw);
    for (let tm = Math.ceil(startMin / minorStep) * minorStep; tm <= endMin; tm += minorStep) {
      const xi = xt(tm);
      const onTick = ((tm % step) + step) % step === 0;
      if (!onTick) {
        minorV.push('M' + xi.toFixed(1) + ' ' + m.t + 'V' + (m.t + ph));
        continue;
      }
      gridV.push('M' + xi.toFixed(1) + ' ' + m.t + 'V' + (m.t + ph));
      if (xi > m.l + 18 && xi < m.l + pw - 18) {
        const dayMin = ((tm % 1440) + 1440) % 1440;
        const text = s.time === null ? '−' + fmtSpan(endMin - tm) : pad(Math.floor(dayMin / 60)) + ':' + pad(dayMin % 60);
        root.append(svg('text', { x: xi.toFixed(1), y: H - 6, 'text-anchor': 'middle' }, text));
      }
    }
    root.prepend(svg('path', { class: 'grid-minor', d: minorH.concat(minorV).join(''), fill: 'none' }),
      svg('path', { class: 'grid-major', d: gridH.concat(gridV).join(''), fill: 'none' }));
    root.append(svg('path', { class: 'grid-major', d: 'M' + m.l + ' ' + m.t + 'V' + (m.t + ph) + 'M' + (m.l + pw) + ' ' + m.t + 'V' + (m.t + ph), fill: 'none' }));

    // bands where the sensor was not read: null runs separated by MERGE_GAP or fewer readings
    // count as one band; readings inside a band are drawn as separate points, not a broken line
    const bands = unreadBands(hist);
    const inBand = new Array(n).fill(false);
    bands.forEach(([a, b]) => {
      for (let k = a; k <= b; k++) inBand[k] = true;
      const xa = x(Math.max(0, a - 1));
      const xb = x(Math.min(n - 1, b + 1));
      root.append(svg('rect', { class: 'gap', x: xa.toFixed(1), y: m.t, width: Math.max(2, xb - xa).toFixed(1), height: ph }));
      // a band with readings scattered through it is intermittent, not unread
      const mixed = hist.slice(a, b + 1).some((v) => v !== null);
      const text = mixed ? 'intermittent readings' : 'sensor unread';
      const cx = ((xa + xb) / 2).toFixed(1);
      const oneLine = xb - xa >= (mixed ? 132 : 84);
      const twoLines = !oneLine && mixed && xb - xa >= 80; // "intermittent" over "readings"
      if (!oneLine && !twoLines) return;
      // put the label where it crosses no reference line and no reading inside or beside the band
      const blockH = twoLines ? 28 : 14;
      const obstacles = [watch].concat(life === null ? [] : [life]).map(y)
        .concat(hist.slice(Math.max(0, a - 1), b + 2).filter((v) => v !== null).map(y));
      const clear = (top) => obstacles.every((oy) => oy < top - 4 || oy > top + blockH + 4);
      const top = [m.t + ph / 2 - blockH / 2, m.t + 6, m.t + ph - blockH - 6].find(clear);
      if (top === undefined) return;
      const label = svg('text', { class: 'gap-label', x: cx, y: (top + 11).toFixed(1), 'text-anchor': 'middle' });
      if (oneLine) label.textContent = text;
      else label.append(svg('tspan', { x: cx }, 'intermittent'), svg('tspan', { x: cx, dy: '14' }, 'readings'));
      root.append(label);
    });

    // reference lines
    if (life !== null && life >= y0 && life <= y1) {
      root.append(svg('path', { class: 'life-line', d: 'M' + m.l + ' ' + y(life).toFixed(1) + 'H' + (m.l + pw) }));
      // label above its line, unless the watch line sits just above it: then below
      const crowded = life <= watch && y(life) - y(watch) < 16;
      root.append(svg('text', { x: m.l + 8, y: (crowded ? y(life) + 15 : y(life) - 5).toFixed(1) }, 'lifetime max ' + life + ' °C'));
    }
    // watch label above its line, unless the lifetime-max line sits just above it: then below
    const watchCrowded = life !== null && life > watch && y(watch) - y(life) < 18;
    root.append(svg('path', { class: 'watch-line', d: 'M' + m.l + ' ' + y(watch).toFixed(1) + 'H' + (m.l + pw) }));
    root.append(svg('text', { class: 'watch-label', x: m.l + pw - 8, y: (watchCrowded ? y(watch) + 15 : y(watch) - 5).toFixed(1), 'text-anchor': 'end' }, watch + ' °C watch (current)'));

    // the trace, broken at bands; a reading inside a band or with no valid neighbour is a point mark
    // smaller marks on narrow plots so neighbouring readings do not smudge together
    const small = W < 640;
    const point = (i) => root.append(svg('circle', { class: small ? 'point small' : 'point', cx: x(i).toFixed(1), cy: y(hist[i]).toFixed(1), r: small ? 1.75 : 3 }));
    for (let i = 0; i < n; i++) {
      if (hist[i] === null) continue;
      if (inBand[i]) { point(i); continue; }
      let j = i;
      while (j + 1 < n && hist[j + 1] !== null && !inBand[j + 1]) j++;
      if (j === i) {
        point(i);
      } else {
        const d = [];
        for (let k = i; k <= j; k++) d.push((k === i ? 'M' : 'L') + x(k).toFixed(1) + ' ' + y(hist[k]).toFixed(1));
        root.append(svg('path', { class: 'trace', d: d.join('') }));
      }
      i = j;
    }

    // markers: minimum (ring) and the reading at the scan (filled)
    let last = n - 1;
    while (last >= 0 && hist[last] === null) last--;
    let minI = -1;
    hist.forEach((v, i) => { if (v !== null && (minI < 0 || v < hist[minI])) minI = i; });
    const label = (xi, yi, text, preferLeft) => {
      const left = preferLeft ? xi - 10 > m.l + 90 : xi + 100 > m.l + pw;
      root.append(svg('text', { class: 'mark-label', x: (left ? xi - 10 : xi + 10).toFixed(1), y: (yi - 8).toFixed(1), 'text-anchor': left ? 'end' : 'start' }, text));
    };
    if (minI >= 0 && hist[minI] < hist[last] && Math.abs(x(minI) - x(last)) > 4) {
      root.append(svg('circle', { class: 'ring', cx: x(minI).toFixed(1), cy: y(hist[minI]).toFixed(1), r: 4.5 }));
      if (Math.abs(x(minI) - x(last)) > 130) {
        root.append(svg('text', { class: 'mark-label', x: (x(minI) + 10).toFixed(1), y: (y(hist[minI]) + 4).toFixed(1) }, 'min ' + hist[minI] + ' °C'));
      }
    }
    root.append(svg('circle', { class: 'dot', cx: x(last).toFixed(1), cy: y(hist[last]).toFixed(1), r: 5 }));
    label(x(last), y(hist[last]), 'last logged ' + hist[last] + ' °C', true);

    // crosshair (drawn on demand) and the hit area for the pointer
    const cross = svg('g', { class: 'crosshair', visibility: 'hidden' });
    cross.append(svg('path', { class: 'cross', d: 'M0 ' + m.t + 'V' + (m.t + ph) }));
    cross.append(svg('circle', { class: 'cross-dot', cx: 0, cy: 0, r: 4.5 }));
    root.append(cross);
    const hit = svg('rect', { class: 'hit', x: m.l, y: m.t, width: pw, height: ph });
    root.append(hit);
    hit.addEventListener('pointermove', (ev) => {
      const box = root.getBoundingClientRect();
      const px = (ev.clientX - box.left) * (W / box.width);
      show(Math.round((px - m.l) / pw * (n - 1)), false);
    });
    hit.addEventListener('pointerleave', () => { if (document.activeElement !== plot) hide(); });

    plot.replaceChildren(root, tip);
    geo.cross = cross;
    if (index !== null) show(index, false);
  }

  function show(i, announce) {
    if (!geo || !n) return;
    index = Math.max(0, Math.min(n - 1, i));
    const { x, y, m, ph } = geo;
    const v = hist[index];
    const xi = x(index);
    geo.cross.setAttribute('visibility', 'visible');
    geo.cross.querySelector('path').setAttribute('d', 'M' + xi.toFixed(1) + ' ' + m.t + 'V' + (m.t + ph));
    const dot = geo.cross.querySelector('circle');
    dot.setAttribute('cx', xi.toFixed(1));
    dot.setAttribute('cy', (v === null ? m.t + ph / 2 : y(v)).toFixed(1));
    dot.setAttribute('visibility', v === null ? 'hidden' : 'visible');
    const info = describe(index);
    tip.replaceChildren(h('b', { text: info.value }), ' · ' + info.when);
    tip.hidden = false;
    const pad = 12; // .plot padding: the svg starts 12px in
    const w = tip.offsetWidth;
    const left = xi + pad + 12 + w <= plot.clientWidth ? xi + pad + 12 : xi + pad - 12 - w;
    tip.style.left = Math.max(0, left) + 'px';
    if (announce) liveRegion.textContent = info.value + ', ' + info.when;
  }
  function hide() {
    index = null;
    if (geo) geo.cross.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  }

  plot.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return; // leave browser shortcuts (Alt+Left = back) alone
    const big = ev.shiftKey ? 10 : 1;
    let i = index === null ? n - 1 : index;
    if (ev.key === 'ArrowLeft') i -= big;
    else if (ev.key === 'ArrowRight') i += big;
    else if (ev.key === 'Home') i = 0;
    else if (ev.key === 'End') i = n - 1;
    else if (ev.key === 'Escape') { hide(); return; }
    else return;
    ev.preventDefault();
    show(i, true);
  });
  plot.addEventListener('focus', () => { if (index === null) show(n - 1, true); });
  plot.addEventListener('blur', hide);

  let frame = 0;
  curveObserver = new ResizeObserver((list) => {
    const w = Math.floor(list[0].contentRect.width);
    if (!w || w === lastWidth) return;
    lastWidth = w;
    // draw on the next frame: redrawing inside the callback would resize the plot mid-observation
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => draw(lastWidth));
  });
  curveObserver.observe(plot);
}

// --------------------------------------------------------------------------- init
async function init() {
  applyTheme(readThemePref());
  ui.themeButtons.forEach((b) => b.addEventListener('click', () => {
    const pref = b.dataset.themeChoice;
    saveThemePref(pref);
    applyTheme(pref);
  }));
  if (darkQuery) {
    darkQuery.addEventListener('change', () => {
      if (document.documentElement.getAttribute('data-theme-pref') === 'system') applyTheme('system');
    });
  }
  ui.rescan.addEventListener('click', rescan);
  ui.folder.addEventListener('click', chooseFolder);
  ui.printAll.addEventListener('click', () => printLabels((state.entries || []).filter((e) => e.assessment.verdict !== 'unsupported')));
  ui.input.addEventListener('change', () => readPickedFiles(ui.input.files));
  ui.list.addEventListener('keydown', onListKey);

  if (!hasPicker) { renderIntro('first'); return; }
  const handle = await loadSavedHandle();
  if (state.entries || state.loading) return; // a folder was picked while we were looking
  if (!handle || typeof handle.queryPermission !== 'function') { renderIntro('first'); return; }
  state.savedHandle = handle;
  state.rootName = handle.name;
  let perm = 'prompt';
  try { perm = await handle.queryPermission({ mode: 'read' }); } catch (e) { /* ask instead */ }
  if (state.entries || state.loading) return;
  if (perm === 'granted') {
    state.root = handle;
    scanRoot();
  } else {
    renderIntro('reopen');
  }
}

init();
