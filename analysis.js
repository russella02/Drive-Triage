'use strict';
/*
 * analysis.js - pure logic for HDD SMART Viewer (no DOM, no dependencies).
 * Classic script: works via <script src> from file:// (exposes window.SmartAnalysis)
 * and via require() under Node (module.exports).
 *
 * Global rule: Seagate raw values of attributes 1, 7 and 195 are vendor-packed
 * and are never used for judgement; attrCount() decodes the ones that are usable.
 */
(function () {
  // ---------------------------------------------------------------- helpers
  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function num(x) { return typeof x === 'number' && isFinite(x) ? x : null; }

  // ------------------------------------------------------------ parse pieces
  function vendorOf(family, model) {
    if (typeof family === 'string' && family.trim()) return family.trim().split(/\s+/)[0];
    const m = String(model || '').trim().toUpperCase();
    if (m.startsWith('ST')) return 'Seagate';
    if (m.startsWith('WDC') || m.startsWith('WD')) return 'Western Digital';
    if (m.startsWith('HGST') || m.startsWith('HUS') || m.startsWith('HDS')) return 'HGST';
    if (m.startsWith('TOSHIBA') || m.startsWith('DT') || m.startsWith('MG')) return 'Toshiba';
    if (m.startsWith('SAMSUNG') || m.startsWith('HD')) return 'Samsung';
    return '';
  }

  function driveNameOf(relPath, model, serial) {
    const parts = String(relPath || '').split(/[\\/]+/).filter(Boolean);
    if (parts.length > 1) return parts[0];
    const file = parts[0] || '';
    if (model) {
      const i = file.indexOf('-' + model);
      if (i > 0) return file.slice(0, i);
    }
    return serial;
  }

  function warningOf(lines) {
    const start = lines.findIndex((l) => l.startsWith('==> WARNING:'));
    if (start < 0) return null;
    const out = [];
    for (let i = start; i < lines.length && lines[i].trim() !== ''; i++) {
      let l = lines[i];
      if (i === start) l = l.replace(/^==> WARNING:\s*/, '');
      l = l.replace(/\S*https?:\/\/\S*/gi, '').replace(/\s+/g, ' ').trim();
      if (l) out.push(l);
    }
    return out.length ? out.join(' ') : null;
  }

  // smartctl already emits ata_sct_temperature_history.table in chronological order
  // (oldest -> newest; "index" is just the raw ring-buffer write position), so it must NOT be
  // rotated again. Verified on the HDD-01 fixture: the table ends at the current temperature.
  // Empty slots (no sample) come through as null.
  function tempHistoryOf(h) {
    if (!isObj(h) || !Array.isArray(h.table)) return [];
    return h.table.map(num);
  }

  // ------------------------------------------------------------------ parseScan
  function parseScan(json, relPath) {
    if (!isObj(json) || !isObj(json.smartctl)) return null;
    const serial = json.serial_number;
    if (serial === undefined || serial === null || String(serial).trim() === '') return null;

    const model = json.model_name || '';
    const family = json.model_family || '';
    const outputLines = Array.isArray(json.smartctl.output) ? json.smartctl.output.map(String) : [];

    const table = isObj(json.ata_smart_attributes) && Array.isArray(json.ata_smart_attributes.table)
      ? json.ata_smart_attributes.table : null;
    const supported = isObj(json.device) && json.device.protocol === 'ATA' && table !== null;

    const attrs = {};
    (table || []).forEach((a) => {
      if (!isObj(a) || typeof a.id !== 'number') return;
      const raw = isObj(a.raw) ? a.raw : {};
      attrs[a.id] = {
        id: a.id,
        name: a.name,
        value: a.value,
        worst: a.worst,
        thresh: a.thresh,
        whenFailed: a.when_failed || '',
        raw: raw.value,
        rawString: raw.string
      };
    });

    let powerOnHours = null;
    if (isObj(json.power_on_time) && num(json.power_on_time.hours) !== null) powerOnHours = json.power_on_time.hours;
    else if (attrs[9] && num(attrs[9].raw) !== null) powerOnHours = attrs[9].raw;

    const t = isObj(json.temperature) ? json.temperature : {};

    // smartctl lists the self-test log newest first; selfTests keeps that order (index 0 = newest).
    const st = isObj(json.ata_smart_self_test_log) && isObj(json.ata_smart_self_test_log.standard)
      && Array.isArray(json.ata_smart_self_test_log.standard.table)
      ? json.ata_smart_self_test_log.standard.table : [];
    const selfTests = st.map((e) => ({
      type: e.type && e.type.string,
      statusValue: e.status && e.status.value,
      statusString: e.status && e.status.string,
      hours: e.lifetime_hours
    }));

    return {
      serial: String(serial),
      model,
      family,
      vendor: vendorOf(family, model),
      firmware: json.firmware_version || '',
      capacityBytes: isObj(json.user_capacity) ? num(json.user_capacity.bytes) : null,
      time: isObj(json.local_time) ? num(json.local_time.time_t) : null,
      relPath,
      driveName: driveNameOf(relPath, model, String(serial)),
      supported,
      attrs,
      smartPassed: isObj(json.smart_status) && typeof json.smart_status.passed === 'boolean'
        ? json.smart_status.passed : null,
      powerOnHours,
      temp: { current: num(t.current), lifetimeMax: num(t.lifetime_max) },
      tempHistory: tempHistoryOf(json.ata_sct_temperature_history),
      selfTests,
      warning: warningOf(outputLines),
      satNeeds16: outputLines.some((l) => l.indexOf('require SAT ATA PASS-THROUGH (16)') >= 0),
      rawOutput: outputLines.join('\n')
    };
  }

  // ------------------------------------------------------------------ decoders
  function attrCount(scan, id) {
    const a = scan && scan.attrs && scan.attrs[id];
    if (!a || num(a.raw) === null) return null;
    // Modulo instead of & so raw values above 2^32 do not overflow.
    if (id === 188 && scan.vendor === 'Seagate') return a.raw % 0x10000;
    if (id === 190 || id === 194) return a.raw % 0x100;
    return a.raw;
  }

  function selfTestOutcome(statusValue) {
    const n = statusValue >> 4;
    if (n === 0) return 'pass';
    if (n === 1 || n === 2) return 'interrupted';
    if (n >= 3 && n <= 8) return 'fail';
    if (n === 15) return 'running';
    return 'fail'; // reserved codes: treat as not-a-pass
  }

  function formatCapacity(bytes) {
    if (num(bytes) === null) return '';
    const trim = (x, d) => String(Number(x.toFixed(d)));
    if (bytes >= 1e12) return trim(bytes / 1e12, 1) + ' TB';
    if (bytes >= 1e9) return trim(bytes / 1e9, 0) + ' GB';
    return trim(bytes / 1e6, 0) + ' MB';
  }

  // --------------------------------------------------------------- groupDrives
  function groupDrives(scans) {
    const byKey = new Map();
    scans.forEach((s) => {
      const key = s.serial + '|' + s.model;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(s);
    });
    const drives = [];
    byKey.forEach((list, key) => {
      const sorted = list.slice().sort((a, b) =>
        (a.time - b.time) || (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
      const dedup = [];
      sorted.forEach((s) => {
        if (!dedup.length || dedup[dedup.length - 1].time !== s.time) dedup.push(s);
      });
      const latest = dedup[dedup.length - 1];
      drives.push({
        key,
        name: latest.driveName,
        serial: latest.serial,
        model: latest.model,
        scans: dedup,
        latest,
        previous: dedup.length > 1 ? dedup[dedup.length - 2] : null
      });
    });
    return drives.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  const api = { parseScan, attrCount, selfTestOutcome, formatCapacity, groupDrives };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else window.SmartAnalysis = api;
})();
