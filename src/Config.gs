// Config.gs — Sheet names, locking, sheet/table helpers and settings.
// All .gs files share one global scope in Apps Script.

const SHEET_RESPONSES   = 'Responses';

const SHEET_SESSIONS    = 'Sessions';

const SHEET_INSTRUCTORS = 'Instructors';

const SHEET_SETTINGS    = 'Settings';

const SHEET_PROFANITY   = 'ProfanityList';

const SHEET_PEER_FEEDBACK    = 'PeerFeedback';

const SHEET_PEER_ASSIGNMENTS = 'PeerAssignments';

/** Run fn while holding the script lock so concurrent writers can't collide
 *  (e.g. two students getting the same response_id). */
function withScriptLock_(fn) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (e) {
    throw new Error('The server is busy. Please try again in a moment.');
  }
  try {
    return fn();
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}

function getSheetByName(name) {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error(`Missing sheet: ${name}`);
  return sh;
}

function getResponsesSheet() { return getSheetByName(SHEET_RESPONSES); }

function getHeaderMap(sh) {
  const lastCol = sh.getLastColumn();
  if (lastCol < 1) throw new Error(`No header found on sheet "${sh.getName()}"`);
  const header = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  const colIndex = (name) => {
    const i = header.indexOf(name);
    if (i === -1) throw new Error(`Header "${name}" not found on "${sh.getName()}"`);
    return i + 1; // 1-based for Range
  };
  return { header, colIndex };
}

/** Safely read header + rows even when there are 0 data rows */
function readTable(sh) {
  const lastCol = sh.getLastColumn();
  const header = lastCol ? sh.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  const dataRows = Math.max(sh.getLastRow() - 1, 0);
  const rows = (dataRows > 0 && lastCol > 0)
    ? sh.getRange(2, 1, dataRows, lastCol).getValues()
    : [];
  return { header, rows };
}

function getPeerFeedbackSheet(){ return getSheetByName(SHEET_PEER_FEEDBACK); }

function getPeerAssignmentsSheet(){ return getSheetByName(SHEET_PEER_ASSIGNMENTS); }

/** Get a required column index (throws if missing) */
function idxRequired(header, name) {
  const i = header.indexOf(name);
  if (i === -1) throw new Error(`Missing column: ${name} in sheet.`);
  return i;
}

/** Set a value only if the column exists */
function setIfExists(sh, baseRow, header, name, value) {
  const i = header.indexOf(name);
  if (i >= 0) sh.getRange(baseRow, i + 1).setValue(value);
}

function getSettingsKV() {
  const sh = getSheetByName(SHEET_SETTINGS);
  const n = Math.max(sh.getLastRow() - 1, 0);
  const values = n ? sh.getRange(2, 1, n, 2).getValues() : [];
  const obj = {};
  values.forEach(([k, v]) => { if (k) obj[String(k).trim()] = String(v).trim(); });
  return obj;
}

function getSettings() {
  const obj = getSettingsKV();
  obj.max_words = Number(obj.max_words || 200);
  obj.min_chars = Number(obj.min_chars || 0);
  obj.profanity_action = obj.profanity_action || 'mask'; // mask | flag | block
  return obj;
}

function prParseDate(v) { try { return v instanceof Date ? v : (v ? new Date(v) : null); } catch(e){ return null; } }

function prBool(v) { return String(v || '').toLowerCase() === 'true'; }

/** Case/whitespace-insensitive ID comparison (session IDs are typed by instructors) */
function sameId_(a, b) {
  return String(a == null ? '' : a).trim().toLowerCase() === String(b == null ? '' : b).trim().toLowerCase();
}

/************ Peer feedback utilities ************/

/**
 * Ensure a column exists in a header row; if missing, append it.
 * Returns the 1-based column index of that header.
 */
function ensureHeaderColumn_(sheet, headerName) {
  const hdrRange = sheet.getRange(1, 1, 1, sheet.getLastColumn());
  const headers = hdrRange.getValues()[0].map(String);
  let idx = headers.indexOf(headerName);
  if (idx === -1) {
    // Append a new header cell at the end
    idx = headers.length;
    sheet.getRange(1, idx + 1).setValue(headerName);
  }
  return idx + 1; // 1-based
}

/**
 * Read a sheet into an array of objects keyed by the header row.
 */
function readSheetObjects_(sheet) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];

  const range = sheet.getRange(1, 1, lastRow, lastCol);
  const values = range.getValues();

  const headers = values[0].map(h => String(h || '').trim());
  const rows = values.slice(1);

  return rows.map((rowVals, i) => {
    const obj = {};
    headers.forEach((h, j) => {
      obj[h] = rowVals[j];
    });
    // Keep rowIndex (2-based, since data starts at row 2)
    obj.__rowIndex = i + 2;
    return obj;
  });
}
