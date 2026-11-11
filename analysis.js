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
  // ------------------------------------------------------------------- RULES
  // Every threshold from the spec lives here so it is easy to tune.
  const RULES = {
    reallocRetire: 100,          // attr 5 above this retires; 1..this is a watch
    cmdTimeoutWatch: 5,          // attr 188 (decoded) above this is a watch
    nearThresholdGap: 10,        // normalized value within this of a (non-zero) threshold
    nearThresholdMaxValue: 100,  // ...and strictly below this (healthy drives sit at 100)
    nearThresholdSkipIds: [190, 194],
    tempLifetimeWatch: 55,
    tempCurrentWatch: 50,
    tempLifetimeNote: 50,
    oldHours: 50000,
    staleLongTestHours: 168,
    growthAttrs: [5, 197, 198, 187],
    shortMax: 24,                // sticker label length limit
    deduct: {
      reallocPerSectors: 2, reallocCap: 40,
      pendingEach: 10, pendingCap: 50,
      offlineEach: 10, offlineCap: 50,
      reportedEach: 5, reportedCap: 40,
      spinRetry: 10,
      cmdTimeout: 5,
      grew: 15,
      failedPastEach: 5, failedPastCap: 10,
      nearThresholdEach: 10, nearThresholdCap: 20,
      ageFreeHours: 20000, agePerHours: 3000, ageCap: 15,
      tempHot: 5,
      noLongTest: 5
    },
    retireMaxScore: 39,
    failureMaxScore: 10,
    bandGood: 80,
    bandFair: 50
  };

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
    if (num(statusValue) === null) return 'unknown'; // missing status: neither a pass nor a failure
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

  // ----------------------------------------------------------------- assessDrive
  // "prefix N" when it fits the sticker limit, otherwise the number-free fallback.
  // A number is never cut short: a wrong count on a label is worse than no count.
  function withNum(prefix, n, fallback) {
    const s = prefix + ' ' + n;
    return s.length <= RULES.shortMax ? s : fallback;
  }

  function years(hours) { return Math.round(hours / 8766 * 10) / 10; }

  function assessDrive(drive) {
    const scan = drive.latest;
    if (!scan.supported) {
      return {
        verdict: 'unsupported', health: null, band: null,
        findings: [{
          severity: 'note', code: 'unsupported', short: 'Not supported yet',
          detail: 'This scan is not from a SATA/ATA drive with a SMART attribute table, so this app cannot judge it yet.'
        }]
      };
    }

    const D = RULES.deduct;
    const found = { retire: [], watch: [], note: [] }; // each list keeps rule order
    let deduction = 0;
    let hardFailure = false; // SMART failed / attribute failing now / failed self-test
    function add(severity, code, short, detail) {
      found[severity].push({ severity, code, short, detail });
    }
    const count = (id) => { const n = attrCount(scan, id); return n === null ? 0 : n; };
    const attrIds = Object.keys(scan.attrs).map(Number).sort((a, b) => a - b);

    const tests = scan.selfTests || [];
    const isExtended = (x) => /extended/i.test(String(x.type || ''));
    const outcomes = tests.map((x) => selfTestOutcome(x.statusValue));
    const hasExtended = tests.some(isExtended);

    // ---- RETIRE
    if (scan.smartPassed === false) {
      hardFailure = true;
      add('retire', 'smart-failed', 'SMART health FAILED',
        'The drive itself reports that its overall SMART health check has failed. Treat it as unreliable and do not trust it with data.');
    }
    const failingNow = attrIds.map((id) => scan.attrs[id]).filter((a) => a.whenFailed === 'now');
    if (failingNow.length) {
      hardFailure = true;
      add('retire', 'failing-now', 'Attribute failing now',
        'The drive flags ' + failingNow.map((a) => a.name || ('attribute ' + a.id)).join(', ')
        + ' as having failed its limit. That is the drive warning that it is wearing out.');
    }
    if (outcomes.length && outcomes[0] === 'fail') {
      hardFailure = true;
      add('retire', 'selftest-failed', 'Last self-test failed',
        'The most recent self-test ended in an error (' + (tests[0].statusString || 'unknown error')
        + '). The drive found a fault when it tested itself.');
    }
    const pending = count(197);
    if (pending > 0) {
      deduction += Math.min(D.pendingCap, pending * D.pendingEach);
      add('retire', 'pending', withNum('Pending sectors', pending, 'Pending sectors'),
        pending + ' sector(s) are waiting to be re-read or remapped. They could not be read reliably, so data stored there may already be damaged.');
    }
    const offline = count(198);
    if (offline > 0) {
      deduction += Math.min(D.offlineCap, offline * D.offlineEach);
      add('retire', 'offline-unc', withNum('Offline unc.', offline, 'Offline unc.'),
        offline + ' sector(s) could not be read even when the drive tested itself in the background. That data is likely lost.');
    }
    const reported = count(187);
    if (reported > 0) {
      deduction += Math.min(D.reportedCap, reported * D.reportedEach);
      add('retire', 'reported-unc', withNum('Uncorrectable', reported, 'Uncorrectable'),
        'The drive reported ' + reported + ' read error(s) it could not fix, so some data could not be returned to the computer.');
    }
    const realloc = count(5);
    if (realloc > 0) deduction += Math.min(D.reallocCap, Math.floor(realloc / D.reallocPerSectors));
    if (realloc > RULES.reallocRetire) {
      add('retire', 'realloc-high', withNum('Reallocated', realloc, 'Reallocated'),
        'The drive has already swapped out ' + realloc + ' damaged sectors for spares. That many means the surface is deteriorating.');
    }

    const prev = drive.previous;
    if (prev && prev.supported) {
      const labels = { 5: 'Realloc', 197: 'Pending', 198: 'Offline', 187: 'Uncorrect' };
      let grew = false;
      RULES.growthAttrs.forEach((id) => {
        const a = attrCount(prev, id);
        const b = attrCount(scan, id);
        if (a === null || b === null || b <= a) return;
        grew = true;
        let s = labels[id] + ' ' + a + '→' + b + ' since last';
        if (s.length > RULES.shortMax) s = labels[id] + ' +' + (b - a) + ' since last';
        if (s.length > RULES.shortMax) s = labels[id] + ' grew';
        add('retire', 'grew', s,
          'The bad-sector count for ' + labels[id].toLowerCase() + ' went from ' + a + ' to ' + b
          + ' since the previous scan. A count that keeps climbing means the drive is actively getting worse.');
      });
      if (grew) deduction += D.grew;
    }

    // ---- WATCH
    if (realloc >= 1 && realloc <= RULES.reallocRetire) {
      add('watch', 'realloc', withNum('Reallocated', realloc, 'Reallocated'),
        'The drive has swapped out ' + realloc + ' damaged sector(s) for spares. A few can be normal, but keep an eye on whether the number grows.');
    }
    const spin = count(10);
    if (spin > 0) {
      deduction += D.spinRetry;
      add('watch', 'spin-retry', withNum('Spin retries', spin, 'Spin retries'),
        'The drive needed ' + spin + ' extra attempt(s) to get its platters up to speed, which can point to a weakening motor or bearings.');
    }
    const timeouts = count(188);
    if (timeouts > RULES.cmdTimeoutWatch) {
      deduction += D.cmdTimeout;
      add('watch', 'cmd-timeout', withNum('Cmd timeouts', timeouts, 'Cmd timeouts'),
        'The drive stopped responding to the computer ' + timeouts + ' times. This is often a power or cable fault but can be a failing drive.');
    }
    // Refined near-threshold rule: healthy Seagates sit at value 100 with thresholds 97/99, so a
    // value of 100 never counts; temperature attributes are judged separately.
    const near = attrIds.map((id) => scan.attrs[id]).filter((a) =>
      RULES.nearThresholdSkipIds.indexOf(a.id) < 0
      && a.thresh > 0 && a.value > a.thresh
      && a.value - a.thresh <= RULES.nearThresholdGap
      && a.value < RULES.nearThresholdMaxValue);
    if (near.length) {
      deduction += Math.min(D.nearThresholdCap, near.length * D.nearThresholdEach);
      add('watch', 'near-threshold', near.length === 1 ? 'Near its limit' : near.length + ' attributes near limit',
        near.map((a) => a.name || ('attribute ' + a.id)).join(', ')
        + (near.length === 1 ? ' has' : ' have') + ' almost used up the margin the maker allows before the drive counts as failing.');
    }
    // "past": the normalized value touched its threshold once but is not failing now.
    const failedPast = attrIds.map((id) => scan.attrs[id]).filter((a) => a.whenFailed === 'past');
    const pastNonTemp = failedPast.filter((a) => RULES.nearThresholdSkipIds.indexOf(a.id) < 0);
    failedPast.forEach((a) => {
      const isTemp = RULES.nearThresholdSkipIds.indexOf(a.id) >= 0;
      add(isTemp ? 'note' : 'watch', 'failed-past', 'Attr ' + a.id + ' failed in past',
        (a.name || ('Attribute ' + a.id)) + ' dropped to its failure limit at some point in the past but is not failing now.'
        + (isTemp ? ' Heat is judged separately.' : ' Keep an eye on whether it happens again.'));
    });
    if (pastNonTemp.length) deduction += Math.min(D.failedPastCap, pastNonTemp.length * D.failedPastEach);
    const t = scan.temp || {};
    const lifeHot = t.lifetimeMax !== null && t.lifetimeMax >= RULES.tempLifetimeWatch;
    const nowHot = t.current !== null && t.current >= RULES.tempCurrentWatch;
    if (lifeHot || nowHot) {
      if (lifeHot) deduction += D.tempHot;
      add('watch', 'temp-hot', 'Runs hot',
        'The drive has reached ' + (lifeHot ? t.lifetimeMax : t.current) + ' °C'
        + (nowHot ? ' and is currently at ' + t.current + ' °C' : '')
        + '. Heat shortens a drive’s life.');
    }
    const hours = scan.powerOnHours;
    if (hours !== null && hours > D.ageFreeHours) {
      deduction += Math.min(D.ageCap, Math.floor((hours - D.ageFreeHours) / D.agePerHours));
    }
    if (hours !== null && hours >= RULES.oldHours) {
      add('watch', 'old', 'Old: ' + years(hours) + ' years on',
        'The drive has been powered on for ' + hours.toLocaleString('en-US') + ' hours (about '
        + years(hours) + ' years of running). Drives this old fail more often.');
    }
    if (!hasExtended && tests.length === 0 && scan.satNeeds16) {
      // empty log + sat,12 scan: the log may just be unreadable, so do not claim none was ever run
    } else if (!hasExtended) {
      deduction += D.noLongTest;
      add('watch', 'no-long-test', 'No long self-test yet',
        'No extended (long) self-test appears in the log. That is the thorough surface check, so the drive has never been fully examined.');
    } else if (hours !== null) {
      // newest extended test that passed; an unknown or failed one does not count
      const i = tests.findIndex((x, k) => isExtended(x) && outcomes[k] === 'pass' && typeof x.hours === 'number');
      if (i >= 0 && hours - tests[i].hours > RULES.staleLongTestHours) {
        add('watch', 'stale-long-test', 'Long test is out of date',
          'The last passing extended self-test was ' + (hours - tests[i].hours).toLocaleString('en-US')
          + ' power-on hours before this scan, so recent wear has not been checked. Run a new one.');
      }
    }

    // ---- NOTE
    if (scan.warning) add('note', 'model-warning', 'Known model problem', scan.warning);
    const crc = count(199);
    if (crc > 0) {
      add('note', 'crc', withNum('Cable errors', crc, 'Cable errors'),
        'The connection saw ' + crc + ' data transfer error(s). That is usually a bad cable or port rather than the drive itself.');
    }
    if (outcomes.indexOf('interrupted') >= 0) {
      add('note', 'selftest-interrupted', 'Self-test cut short',
        'At least one self-test in the log was interrupted or aborted before it finished, so it tells us nothing about the drive.');
    }
    if (scan.satNeeds16) {
      add('note', 'sat12', 'Re-scan with sat,16',
        'This scan used a 12-byte USB command mode and could not read every log. Scanning again with -d sat,16 may show more.');
    }
    if (!lifeHot && !nowHot && t.lifetimeMax !== null && t.lifetimeMax >= RULES.tempLifetimeNote) {
      add('note', 'temp-warm', 'Got warm: ' + t.lifetimeMax + ' °C',
        'The drive has reached ' + t.lifetimeMax + ' °C at some point. That is warm but not yet harmful; check airflow.');
    }

    const findings = found.retire.concat(found.watch, found.note);
    const verdict = found.retire.length ? 'retire' : found.watch.length ? 'watch' : 'keep';

    let health = 100 - deduction;
    if (verdict === 'retire') health = Math.min(health, RULES.retireMaxScore);
    if (hardFailure) health = Math.min(health, RULES.failureMaxScore);
    health = Math.max(0, Math.floor(health));
    const band = health >= RULES.bandGood ? 'good' : health >= RULES.bandFair ? 'fair' : 'poor';
    return { verdict, health, band, findings };
  }

  // ---------------------------------------------------------------- analyzeFiles
  // files: [{ relPath, text }] read from the chosen folder (untrusted text).
  // Returns drives worst first, the number of unique scans (serial + model + time), and how many
  // files were skipped because they were not JSON or not a smartctl scan.
  const VERDICT_ORDER = { retire: 0, watch: 1, keep: 2, unsupported: 3 };

  function analyzeFiles(files) {
    const scans = [];
    let skipped = 0;
    (files || []).forEach((f) => {
      let json;
      try {
        json = JSON.parse(String(f.text).replace(/^﻿/, ''));
      } catch (e) {
        skipped++;
        return;
      }
      const s = parseScan(json, f.relPath);
      if (!s) { skipped++; return; }
      scans.push(s);
    });
    // groupDrives already keeps one scan per serial + model + time.
    const drives = groupDrives(scans).map((drive) => ({ drive, assessment: assessDrive(drive) }));
    const scanCount = drives.reduce((n, e) => n + e.drive.scans.length, 0);
    const health = (e) => (e.assessment.health === null ? 101 : e.assessment.health);
    drives.sort((a, b) =>
      (VERDICT_ORDER[a.assessment.verdict] - VERDICT_ORDER[b.assessment.verdict])
      || (health(a) - health(b))
      || String(a.drive.name).localeCompare(String(b.drive.name), 'en', { numeric: true })
      || (a.drive.key < b.drive.key ? -1 : a.drive.key > b.drive.key ? 1 : 0));
    return { drives, scanCount, skipped };
  }

  const api = { parseScan, attrCount, selfTestOutcome, formatCapacity, groupDrives, RULES, assessDrive, analyzeFiles };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else window.SmartAnalysis = api;
})();
