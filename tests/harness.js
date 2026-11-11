// Fake Apps Script services + tiny assertion helpers for tests/test_*.js.
// tests/run.py concatenates: this file + all src/*.gs + one test file, then runs it.

// ---- In-memory spreadsheet ----
const __SHEETS = {};
function FakeSheet(name, rows) { this.name = name; this.data = rows; }
FakeSheet.prototype.getName = function () { return this.name; };
FakeSheet.prototype.getLastRow = function () { return this.data.length; };
FakeSheet.prototype.getLastColumn = function () { return this.data.length ? this.data[0].length : 0; };
FakeSheet.prototype.appendRow = function (r) { this.data.push(r.slice()); };
FakeSheet.prototype.getDataRange = function () { return this.getRange(1, 1, this.getLastRow(), this.getLastColumn()); };
FakeSheet.prototype.getRange = function (row, col, nr, nc) {
  const d = this.data; nr = nr || 1; nc = nc || 1;
  const width = () => (d[0] || []).length;
  return {
    getValues: () => {
      const res = [];
      for (let i = 0; i < nr; i++) { const r = []; for (let j = 0; j < nc; j++) { const v = (d[row - 1 + i] || [])[col - 1 + j]; r.push(v === undefined ? '' : v); } res.push(r); }
      return res;
    },
    setValues: (vals) => vals.forEach((v, i) => { d[row - 1 + i] = d[row - 1 + i] || new Array(width()).fill(''); v.forEach((x, j) => { d[row - 1 + i][col - 1 + j] = x; }); }),
    setValue: (v) => { d[row - 1] = d[row - 1] || new Array(width()).fill(''); d[row - 1][col - 1] = v; },
  };
};
/** Replace all sheets: setSheets({ Sessions: [[header...], [row...]], ... }) */
function setSheets(spec) {
  Object.keys(__SHEETS).forEach(k => delete __SHEETS[k]);
  Object.keys(spec).forEach(k => { __SHEETS[k] = new FakeSheet(k, spec[k].map(r => r.slice())); });
}
function sheetRows(name) { return __SHEETS[name].data; }
/** Rows as objects keyed by header */
function sheetObjects(name) {
  const [h, ...rows] = __SHEETS[name].data;
  return rows.map(r => { const o = {}; h.forEach((k, i) => o[k] = r[i] === undefined ? '' : r[i]); return o; });
}

const SpreadsheetApp = { getActive: () => ({ getSheetByName: n => __SHEETS[n] || null }), flush: () => {} };
const LockService = { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) };
const __cache = new Map();
const CacheService = { getScriptCache: () => ({
  get: k => (__cache.has(k) ? __cache.get(k) : null),
  put: (k, v) => { __cache.set(k, String(v)); },
  remove: k => { __cache.delete(k); },
}) };
let __uuidN = 0;
const Utilities = {
  getUuid: () => `${(++__uuidN).toString(16).padStart(8, '0')}-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`,
  DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
  computeDigest: (alg, s) => {           // deterministic stand-in for SHA-256 (tests only)
    let h = 2166136261; const outB = [];
    for (let k = 0; k < 32; k++) { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i) + k; h = Math.imul(h, 16777619); } outB.push(h & 255); }
    return outB;
  },
  base64Encode: bytes => bytes.map(b => (b & 255).toString(16).padStart(2, '0')).join(''),
};
const Logger = { log: () => {} };
// Real base64 for figure bytes (node and gjs alike). The digest stand-in above keeps its own
// encoding: only byte arrays from a blob (marked __b64) are base64-encoded for real.
const __B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function __b64dec(str) {
  const clean = String(str).replace(/=+$/, ''), out = [];
  let bits = 0, acc = 0;
  for (const ch of clean) { acc = (acc << 6) | __B64.indexOf(ch); bits += 6; if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); } }
  return out;
}
function __b64enc(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    out += __B64[(n >> 18) & 63] + __B64[(n >> 12) & 63] + (i + 1 < bytes.length ? __B64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? __B64[n & 63] : '=');
  }
  return out;
}
Utilities.base64Decode = __b64dec;
Utilities.base64Encode = (orig => bytes => (bytes && bytes.__b64) ? __b64enc(bytes) : orig(bytes))(Utilities.base64Encode);
Utilities.formatDate = d => d.toISOString();
Utilities.newBlob = (bytes, type, name) => ({ bytes, type, name, getBytes: () => Object.assign(bytes.slice(), { __b64: true }), getContentType: () => type });
const Session = { getScriptTimeZone: () => 'Europe/London' };
const __props = new Map();
const PropertiesService = { getScriptProperties: () => ({
  getProperty: k => (__props.has(k) ? __props.get(k) : null), setProperty: (k, v) => { __props.set(k, String(v)); },
}) };
// A tiny fake Drive: folders and files with parents. Files outside StatChat's folder can exist.
const __drive = new Map();
let __driveN = 0;
function __iter(list) { let i = 0; return { hasNext: () => i < list.length, next: () => list[i++] }; }
function __driveItem(kind, name, parent, blob) {
  const id = kind + '_' + String(++__driveN).padStart(12, '0');
  const item = {
    kind, name, parent, blob, trashed: false,
    getId: () => id, getName: () => name, isTrashed: () => item.trashed,
    getParents: () => __iter(parent ? [__drive.get(parent)] : []),
    getBlob: () => blob,
    createFolder: n => __driveItem('folder', n, id),
    createFile: b => __driveItem('file', b.name, id, b),
    getFoldersByName: n => __iter([...__drive.values()].filter(x => x.kind === 'folder' && x.parent === id && x.name === n)),
  };
  __drive.set(id, item);
  return item;
}
const __driveRoot = __driveItem('folder', 'My Drive', null);
const DriveApp = {
  createFolder: n => __driveRoot.createFolder(n),
  getFolderById: id => { const f = __drive.get(id); if (!f || f.kind !== 'folder') throw new Error('No folder'); return f; },
  getFileById: id => { const f = __drive.get(id); if (!f || f.kind !== 'file') throw new Error('No file'); return f; },
};

// ---- Helpers ----
const H = hours => new Date(Date.now() + hours * 3600e3);
let __fails = 0, __count = 0;
function eq(name, got, want) {
  __count++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) __fails++;
  out((ok ? '  PASS ' : '  FAIL ') + name + (ok ? '' : `\n         got:  ${JSON.stringify(got)}\n         want: ${JSON.stringify(want)}`));
}
function throws(name, fn, re) {
  __count++;
  try { fn(); __fails++; out('  FAIL ' + name + ' (no error thrown)'); }
  catch (e) {
    const ok = re.test(e.message); if (!ok) __fails++;
    out((ok ? '  PASS ' : '  FAIL ') + name + (ok ? '' : '  (error: ' + e.message + ')'));
  }
}
function finish() { out(__fails ? `RESULT: FAIL (${__fails} of ${__count} failed)` : `RESULT: PASS (${__count} checks)`); }
