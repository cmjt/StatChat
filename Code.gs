/**
 * Student + Instructor Web App (clean build)
 * - Instructor: login with ID + password; start/stop sessions with timer.
 * - Student: submits Name/ID + Response (+Confidence). Session inferred via instructor’s active session.
 * - Storage: Google Sheets tabs per schema.
 * 
 * 2026-01-14 changes:
 *  - Sessions header lookups made tolerant and aligned to your headers:
 *    session_id, instructor_id, is_open, is_active, active_until, phase, poll_window_mins, created_at, archived, history_window_mins
 *  - Phases limited to 'writing' and 'review'. Poll is a dashboard visualization toggle (first-word chart).
 *  - Writing submissions disabled during 'review' phase.
 *  - Peer review assignments: self + 2 others (n=3).
 *  - Debug APIs for headers and counts.
 */

// ===== CONFIG =====
const SHEET_RESPONSES   = 'Responses';
const SHEET_SESSIONS    = 'Sessions';
const SHEET_INSTRUCTORS = 'Instructors';
const SHEET_SETTINGS    = 'Settings';      // optional key-value
const SHEET_PROFANITY   = 'ProfanityList'; // optional; one term per row
const SHEET_PEER_FEEDBACK    = 'PeerFeedback';
const SHEET_PEER_ASSIGNMENTS = 'PeerAssignments';

// ===== PING =====
function pingServer() { return { ok: true, msg: 'pong' }; }
function ping() { return 'pong'; }

// ===== SHEET HELPERS =====
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

/** Safe header index: returns -1 if missing (no throw) */
function idxOrMinus1(header, name) { return header.indexOf(name); }
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

// ===== SETTINGS (optional key-value pairs) =====
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

// ===== PROFANITY (optional) =====
function getProfanityList() {
  const sh = getSheetByName(SHEET_PROFANITY);
  const n = Math.max(sh.getLastRow(), 1);
  const values = sh.getRange(1, 1, n, 1).getValues();
  return values.map(r => String(r[0] || '').trim()).filter(Boolean);
}
function maskProfanity(text, profList) {
  if (!text) return text;
  let output = text;
  profList.forEach(term => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'gi');
    output = output.replace(re, '•••');
  });
  return output;
}
function hasProfanity(text, profList) {
  if (!text) return false;
  const t = text.toLowerCase();
  return profList.some(term => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    return re.test(t);
  });
}

// ===== ID & NORMALIZATION =====
function nextResponseId(sh) {
  const { colIndex } = getHeaderMap(sh);
  const idCol = colIndex('response_id');
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return 1;
  const ids = sh.getRange(2, idCol, lastRow - 1, 1).getValues().flat();
  const nums = ids.map(v => Number(v)).filter(n => !isNaN(n));
  const max = nums.length ? Math.max(...nums) : 0;
  return max + 1;
}
function normalizePollValue(text) {
  if (!text) return '';
  return String(text).trim().toLowerCase().replace(/\s+/g, ' ');
}

// ===== INSTRUCTORS & SESSIONS =====
function getInstructorById(instructor_id) {
  const sh = getSheetByName(SHEET_INSTRUCTORS);
  const { header: hdr, rows } = readTable(sh);
  const idCol = hdr.indexOf('instructor_id');
  if (idCol === -1) throw new Error('Missing column instructor_id in Instructors.');
  for (const r of rows) {
    if (String(r[idCol]) === String(instructor_id)) {
      const rec = {}; hdr.forEach((h,i)=>rec[h]=r[i]);
      return rec;
    }
  }
  return null;
}
function getSession(session_id) {
  const sh = getSheetByName(SHEET_SESSIONS);
  const { header: hdr, rows } = readTable(sh);
  const idCol = hdr.indexOf('session_id');
  if (idCol === -1) throw new Error('Missing column session_id in Sessions.');
  const target = String(session_id).trim().toLowerCase();
  for (const r of rows) {
    const rec = {}; hdr.forEach((h,i)=>rec[h]=r[i]);
    if (String(rec.session_id).trim().toLowerCase() === target) return rec;
  }
  return null;
}
function apiGetSignedInIdentity() {
  const email = Session.getActiveUser().getEmail();
  if (!email) {
    return {
      ok: false,
      code: 'NO_EMAIL',
      error: 'We couldn’t detect your University Google sign-in. Switch to your @aucklanduni.ac.nz account and reload.'
    };
  }
  if (!/@aucklanduni\.ac\.nz$/i.test(email)) {
    return {
      ok: false,
      code: 'WRONG_DOMAIN',
      error: 'You are signed into Google with a non-UoA account. Please switch to @aucklanduni.ac.nz and reload.'
    };
  }
  const upi = email.replace(/@.*$/, '');
  return { ok: true, email, upi };
}
``

function isSessionActive(session) {
  if (!session) return false;
  const open   = String(session.is_open).toLowerCase() === 'true';
  const active = String(session.is_active).toLowerCase() === 'true';
  const until  = session.active_until instanceof Date ? session.active_until : new Date(session.active_until);
  return open && active && until && (new Date() < until);
}
/** Phases: only 'writing' or 'review' */
function getPhaseForSession(session) {
  if (!session) return 'writing';
  const raw = String(session.phase || '').trim().toLowerCase();
  if (raw === 'review') return 'review';
  return 'writing';
}

// ===== Peer review small helpers (NEW) =====
function prParseDate(v) { try { return v instanceof Date ? v : (v ? new Date(v) : null); } catch(e){ return null; } }
function prBool(v) { return String(v || '').toLowerCase() === 'true'; }
/** Read peer review config for a session from Sessions (if present) */
function getPeerConfigForSession(session_id) {
  const sh = getSheetByName(SHEET_SESSIONS);
  const { header: hdr, rows } = readTable(sh);
  const idCol = hdr.indexOf('session_id');
  if (idCol === -1) throw new Error('Missing column: session_id in Sessions.');
  const idx = rows.findIndex(r => String(r[idCol]).trim().toLowerCase() === String(session_id).trim().toLowerCase());
  if (idx === -1) return null;
  const rec = {}; hdr.forEach((h,i)=> rec[h] = rows[idx][i]);

  if (!prBool(rec.peer_open)) return null;

  const openedAt = prParseDate(rec.peer_opened_at) || new Date();
  const windowMins = Math.max(1, parseInt(rec.peer_window_mins,10) || 5);
  const required = Math.max(1, parseInt(rec.peer_required_reviews,10) || 2);

  return { opened_at: openedAt, window_mins: windowMins, required_reviews: required };
}

// ===== RESPONSES I/O =====
function writeResponse(payload) {
  const sh = getResponsesSheet();
  const { header } = getHeaderMap(sh);
  const id = nextResponseId(sh);
  const now = new Date();
  const row = header.map(h => {
    switch (h) {
      case 'response_id': return id;
      case 'timestamp':   return now;
      default:            return payload[h] !== undefined ? payload[h] : '';
    }
  });
  sh.appendRow(row);
  return id;
}
function updateResponseModeration(response_id, updates) {
  const sh = getResponsesSheet();
  const { header, colIndex } = getHeaderMap(sh);
  const idColZero = colIndex('response_id') - 1;
  const last = sh.getLastRow();
  if (last < 2) return false;
  const ids = sh.getRange(2, idColZero + 1, last - 1, 1).getValues().flat();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i]) === String(response_id)) {
      const rowIdx = 2 + i;
      Object.keys(updates).forEach(key => {
        const col = header.indexOf(key);
        if (col >= 0) sh.getRange(rowIdx, col + 1).setValue(updates[key]);
      });
      return true;
    }
  }
  return false;
}
function listResponses(session_id) {
  const sh = getResponsesSheet();
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const data = sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 0), sh.getLastColumn()).getValues();
  const target = String(session_id).trim().toLowerCase();
  return data.map(row => {
    const rec = {};
    headers.forEach((h, i) => rec[h] = row[i]);
    return rec;
  }).filter(r => String(r.session_id).trim().toLowerCase() === target);
}

// ===== AUTH HELPERS (NEW) =====
/** Return signed-in user's email (Workspace only) or '' if unavailable */
function getAuthedEmail() {
  try {
    const em = Session.getActiveUser().getEmail();
    return (typeof em === 'string') ? em : '';
  } catch (e) {
    return '';
  }
}
/** Enforce domain. Throws if not in allowed domain. */
function requireDomainEmailOrThrow(allowedDomain) {
  const email = getAuthedEmail();
  if (!email || !email.toLowerCase().endsWith('@' + allowedDomain.toLowerCase())) {
    throw new Error('Unauthorized. Please use your institutional Google account.');
  }
  return email;
}

// ===== WEB ROUTES =====
function doGet(e) {
  const pageRaw = (e && e.parameter && e.parameter.page) ? String(e.parameter.page) : 'student';
  const page = pageRaw.toLowerCase();

  if (page === 'student') {
    // NEW: enforce domain & capture email
    const email = requireDomainEmailOrThrow('aucklanduni.ac.nz');

    const t = HtmlService.createTemplateFromFile('student');
    t.inst = (e && e.parameter && e.parameter.inst) ? String(e.parameter.inst) : '';
    t.exec = ScriptApp.getService().getUrl();
    // legacy (safe to keep; ignored by Google-login flow)
    t.canvas_id = (e && e.parameter && e.parameter.canvas_id) ? String(e.parameter.canvas_id) : '';
    // NEW: pass authed email to template
    t.email = String(email || '');

    return t.evaluate()
      .setTitle('Class Response')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  if (page === 'dashboard') {
    const t = HtmlService.createTemplateFromFile('dashboard');
    return t.evaluate()
      .setTitle('Instructor Dashboard')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  if (page === 'review') {
    return HtmlService.createHtmlOutputFromFile('student_review')
      .setTitle('Peer Review')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  return HtmlService.createHtmlOutput('<p>Invalid page</p>')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== STUDENT API =====

/** Student submission: disabled during review; poll no longer enforced */
function apiSubmitResponse(session_id, payload) {
  const session = getSession(session_id);
  if (!session) throw new Error('Session not found.');
  if (!isSessionActive(session)) throw new Error('No active session. Please try again later.');

  const phase = getPhaseForSession(session); // writing | review
  if (phase === 'review') throw new Error('Writing is disabled during peer review.');

  const settings = getSettings();
  const text = String(payload.response_text_original || '').trim();
  const words = text.split(/\s+/).filter(Boolean);

  if (settings.max_words && words.length > settings.max_words) {
    throw new Error(`Please keep to ${settings.max_words} words.`);
  }
  if (text.length < settings.min_chars) {
    throw new Error('Response too short.');
  }

  // Profanity handling
  const profList = getProfanityList();
  const hasProf = hasProfanity(text, profList);
  let response_text_masked = text;
  let profanity_flag = 'NONE';
  const action = (settings.profanity_action || 'mask').toLowerCase();
  if (hasProf) {
    if (action === 'block') {
      throw new Error('Your response contains disallowed terms.');
    } else if (action === 'mask') {
      response_text_masked = maskProfanity(text, profList);
      profanity_flag = 'MASKED';
    } else {
      profanity_flag = 'FLAGGED';
    }
  }

  // Poll flags deprecated: always false
  const rowPayload = {
    session_id,
    unique_id: String(payload.unique_id || ''),
    response_text_original: text,
    response_text_edited: (profanity_flag === 'MASKED') ? response_text_masked : '',
    is_poll: 'FALSE',
    poll_value_normalized: '',
    is_hidden: 'FALSE',
    is_pinned: 'FALSE',
    order_weight: '',
    profanity_flag,
    confidence: Number(payload.confidence || '') || '',
    tags: '',
    phase_at_submit: phase  // stamp phase at submit time
  };

  const id = writeResponse(rowPayload);
  return { ok: true, response_id: id };
}

/** Legacy student API: disabled during review */
function submitResponse(response_text, unique_id, class_access_code_unused, session_id, instructor_id_unused, confidence) {
  const session = getSession(session_id);
  if (!session) return { ok:false, error:'Invalid session.' };
  if (!isSessionActive(session)) return { ok:false, error:'No active session. Please try again later.' };

  const phase = getPhaseForSession(session);
  if (phase === 'review') return { ok:false, error:'Writing is disabled during peer review.' };

  const settings = getSettings();
  const text = String(response_text || '').trim();
  const words = text.split(/\s+/).filter(Boolean);

  if (settings.max_words && words.length > settings.max_words) {
    return { ok:false, error:`Please keep to ${settings.max_words} words.` };
  }
  if (text.length < settings.min_chars) {
    return { ok:false, error:'Response too short.' };
  }

  const profList = getProfanityList();
  const hasProf = hasProfanity(text, profList);
  let response_text_masked = text;
  let profanity_flag = 'NONE';
  const action = (settings.profanity_action || 'mask').toLowerCase();
  if (hasProf) {
    if (action === 'block') {
      return { ok:false, error:'Your response contains disallowed terms.' };
    } else if (action === 'mask') {
      response_text_masked = maskProfanity(text, profList);
      profanity_flag = 'MASKED';
    } else {
      return { ok:true, response_id: writeResponse({
        session_id,
        unique_id: String(unique_id || ''),
        response_text_original: text,
        response_text_edited: '',
        is_poll: 'FALSE',
        poll_value_normalized: '',
        is_hidden: 'FALSE',
        is_pinned: 'FALSE',
        order_weight: '',
        profanity_flag: 'FLAGGED',
        confidence: Number(confidence || '') || '',
        tags: '',
        phase_at_submit: phase
      }) };
    }
  }

  const rowPayload = {
    session_id,
    unique_id: String(unique_id || ''),
    response_text_original: text,
    response_text_edited: (profanity_flag === 'MASKED') ? response_text_masked : '',
    is_poll: 'FALSE',
    poll_value_normalized: '',
    is_hidden: 'FALSE',
    is_pinned: 'FALSE',
    order_weight: '',
    profanity_flag,
    confidence: Number(confidence || '') || '',
    tags: '',
    phase_at_submit: phase
  };

  const id = writeResponse(rowPayload);
  return { ok:true, response_id:id };
}

// ===== INSTRUCTOR API =====

/** Login with instructor_id + password */
function apiInstructorLogin(instructor_id, password) {
  const sh = getSheetByName(SHEET_INSTRUCTORS);
  const { header: hdr, rows } = readTable(sh);

  const col = (name)=>{ const i = hdr.indexOf(name); if (i===-1) throw new Error(`Missing column: ${name}`); return i; };
  const idCol = col('instructor_id');
  const pwCol = col('password');
  const dnCol = hdr.indexOf('display_name');

  const match = rows.find(r => String(r[idCol]) === String(instructor_id) && String(r[pwCol]) === String(password));
  if (!match) throw new Error('Invalid instructor ID or password.');
  return { ok:true, instructor_id, display_name: dnCol>=0 ? String(match[dnCol]||'') : '' };
}

/** Start session (phase always 'writing' initially) */
function apiStartSession(instructor_id, session_id, duration_mins){
  const inst = getInstructorById(instructor_id);
  if (!inst) throw new Error('Instructor not found.');

  const sh = getSheetByName(SHEET_SESSIONS);
  const { header: hdr, rows } = readTable(sh);

  // Required columns only (these must exist in your sheet)
  const idCol    = idxRequired(hdr, 'session_id');
  const instCol  = idxRequired(hdr, 'instructor_id');

  const rowIndex = rows.findIndex(r =>
    String(r[idCol]).trim().toLowerCase() === String(session_id).trim().toLowerCase() &&
    String(r[instCol]) === String(instructor_id)
  );

  const now = new Date();
  const until = new Date(now.getTime() + Number(duration_mins) * 60 * 1000);
  const initialPhase = 'writing';

  if (rowIndex >= 0) {
    const base = 2 + rowIndex;
    setIfExists(sh, base, hdr, 'is_open', 'TRUE');
    setIfExists(sh, base, hdr, 'is_active', 'TRUE');
    setIfExists(sh, base, hdr, 'active_until', until);
    setIfExists(sh, base, hdr, 'created_at', now);
    setIfExists(sh, base, hdr, 'archived', 'FALSE');
    setIfExists(sh, base, hdr, 'phase', initialPhase);
    // Optional legacy flags—only set if present
    setIfExists(sh, base, hdr, 'is_review_mode', 'FALSE');
    setIfExists(sh, base, hdr, 'is_poll_mode', 'FALSE');
    // Optional extras: history_window_mins, poll_window_mins – left unchanged
  } else {
    // Build a row honoring available headers
    const row = hdr.map(h=>{
      switch(h){
        case 'session_id':    return session_id;
        case 'instructor_id': return instructor_id;
        case 'is_open':       return 'TRUE';
        case 'is_active':     return 'TRUE';
        case 'active_until':  return until;
        case 'created_at':    return now;
        case 'archived':      return 'FALSE';
        case 'phase':         return initialPhase;
        case 'is_review_mode':return 'FALSE';
        case 'is_poll_mode':  return 'FALSE';
        default:              return '';
      }
    });
    sh.appendRow(row);
  }
  return { ok:true, session_id, active_until: until.toISOString(), phase: initialPhase };
}

/** Set phase: writing | review (poll removed as a phase). 
 *  Optional: pass history_window_mins to persist to Sessions if the column exists.
 */
function apiSetPhase(instructor_id, session_id, phase, history_window_mins) {
  const phases = new Set(['writing','review']);
  phase = String(phase || '').trim().toLowerCase();
  if (!phases.has(phase)) throw new Error('Invalid phase. Use writing|review');

  const sh = getSheetByName(SHEET_SESSIONS);
  const { header: hdr, rows } = readTable(sh);

  const idCol   = idxRequired(hdr, 'session_id');
  const instCol = idxRequired(hdr, 'instructor_id');

  const idxRow = rows.findIndex(r =>
    String(r[idCol]).trim().toLowerCase() === String(session_id).trim().toLowerCase() &&
    String(r[instCol]) === String(instructor_id)
  );
  if (idxRow === -1) throw new Error('Session not found for instructor.');
  const base = 2 + idxRow;

  setIfExists(sh, base, hdr, 'phase', phase);
  // Align legacy flags only if present
  setIfExists(sh, base, hdr, 'is_poll_mode', 'FALSE');
  setIfExists(sh, base, hdr, 'is_review_mode', phase === 'review' ? 'TRUE' : 'FALSE');

  // Persist minutes if provided and column exists (lowercase: history_window_mins)
  if (history_window_mins != null) {
    setIfExists(sh, base, hdr, 'history_window_mins', Number(history_window_mins) || 0);
  }

  return { ok:true, phase };
}

/** Resolve active session for instructor (phase + history_window_mins tolerant) */
function apiGetActiveSessionForInstructor(instructor_id) {
  const sh = getSheetByName(SHEET_SESSIONS);
  const { header: hdr, rows } = readTable(sh);
  const now = new Date();

  const idCol    = idxRequired(hdr, 'session_id');
  const instCol  = idxRequired(hdr, 'instructor_id');
  const openCol  = idxRequired(hdr, 'is_open');
  const actCol   = idxRequired(hdr, 'is_active');
  const untilCol = idxRequired(hdr, 'active_until');
  const phaseCol = idxOrMinus1(hdr, 'phase');
  const histCol  = idxOrMinus1(hdr, 'history_window_mins'); // lowercase per your sheet

  const recs = rows.map(r=>{
    return {
      session_id:      r[idCol],
      instructor_id:   r[instCol],
      is_open:         String(r[openCol]),
      is_active:       String(r[actCol]),
      active_until:    r[untilCol],
      phase:           (phaseCol >= 0) ? String(r[phaseCol] || '') : 'writing',
      history_window_mins: (histCol >= 0) ? Number(r[histCol] || 0) : 0
    };
  });

  const active = recs.filter(rec =>
    String(rec.instructor_id) === String(instructor_id) &&
    rec.is_open.toLowerCase() === 'true' &&
    rec.is_active.toLowerCase() === 'true' &&
    rec.active_until && (now < (rec.active_until instanceof Date ? rec.active_until : new Date(rec.active_until)))
  );
  if (!active.length) return { ok:true, session_id:'', active:false };

  active.sort((a,b)=> new Date(b.active_until) - new Date(a.active_until));
  const top = active[0];

  return {
    ok:true,
    session_id: top.session_id,
    active_until: new Date(top.active_until).toISOString(),
    active:true,
    phase: String(top.phase || '').trim().toLowerCase() === 'review' ? 'review' : 'writing',
    history_window_mins: Number(top.history_window_mins || 0),
    // legacy flags (not used anymore)
    is_review_mode: String(top.phase || '').trim().toLowerCase() === 'review',
    is_poll_mode:   false
  };
}

/** Stop session early */
function apiStopSession(instructor_id, session_id) {
  const sh = getSheetByName(SHEET_SESSIONS);
  const { header: hdr, rows } = readTable(sh);

  const idCol   = idxRequired(hdr, 'session_id');
  const instCol = idxRequired(hdr, 'instructor_id');

  const idx = rows.findIndex(r =>
    String(r[idCol]).trim().toLowerCase() === String(session_id).trim().toLowerCase() &&
    String(r[instCol]) === String(instructor_id)
  );
  if (idx === -1) throw new Error('Session not found.');
  const base = 2 + idx;
  setIfExists(sh, base, hdr, 'is_open', 'FALSE');
  setIfExists(sh, base, hdr, 'is_active', 'FALSE');
  return { ok:true };
}

/** List responses by instructor + session (for dashboard) */
function apiListResponsesByInstructor(instructor_id, session_id) {
  const session = getSession(session_id);
  if (!session || String(session.instructor_id) !== String(instructor_id)) {
    throw new Error('Session not found or not owned by instructor.');
  }
  const sh = getResponsesSheet();
  const values = sh.getDataRange().getValues();
  if (!values || values.length < 2) return [];
  const header = values[0];
  const rows = values.slice(1);
  const idx = name => header.indexOf(name);

  return rows
    .filter(r => String(r[idx('session_id')]).trim().toLowerCase() === String(session_id).trim().toLowerCase())
    .map(r => ({
      response_id: String(r[idx('response_id')] || ''),
      response_text_original: String(r[idx('response_text_original')] || ''),
      response_text_edited: String(r[idx('response_text_edited')] || ''),
      timestamp: String(r[idx('timestamp')] || ''),
      is_hidden: String(r[idx('is_hidden')] || 'FALSE'),
      is_pinned: String(r[idx('is_pinned')] || 'FALSE'),
      is_poll: 'FALSE', // deprecated
      poll_value_normalized: '',
      order_weight: Number(r[idx('order_weight')] || 0),
      confidence: Number(r[idx('confidence')] || ''),
      tags: String(r[idx('tags')] || ''),
      pos_x: Number(r[idx('pos_x')] || 0),
      pos_y: Number(r[idx('pos_y')] || 0),
      phase_at_submit: idx('phase_at_submit') >= 0 ? String(r[idx('phase_at_submit')] || '') : ''
    }));
}

/** Update response fields (validate ownership via session mapping) */
function apiUpdateResponse(instructor_id, response_id, patch) {
  const sh = getResponsesSheet();
  const values = sh.getDataRange().getValues();
  if (!values || values.length < 2) throw new Error('No responses.');
  const header = values[0];
  const rows = values.slice(1);

  const idCol = header.indexOf('response_id');
  const sessCol = header.indexOf('session_id');
  if (idCol === -1 || sessCol === -1) throw new Error('Missing response_id or session_id columns.');

  const rIndex = rows.findIndex(r => String(r[idCol]) === String(response_id));
  if (rIndex === -1) throw new Error('Response not found');
  const row = rows[rIndex];
  const sessId = row[sessCol];

  const session = getSession(sessId);
  if (!session || String(session.instructor_id) !== String(instructor_id)) {
    throw new Error('Not authorized to modify this response.');
  }

  const allowed = ['response_text_edited', 'is_pinned', 'is_hidden', 'order_weight', 'tags', 'pos_x', 'pos_y'];
  allowed.forEach(k => {
    if (k in patch) {
      const col = header.indexOf(k);
      if (col >= 0) sh.getRange(2 + rIndex, col + 1).setValue(patch[k]);
    }
  });

  return { ok: true };
}

/** Export CSV for instructor + session */
function apiExportCSV(instructor_id, session_id) {
  const rows = apiListResponsesByInstructor(instructor_id, session_id);
  const headers = Object.keys(rows[0] || {
    response_id:'', session_id:'', timestamp:'', unique_id:'', response_text_original:'', response_text_edited:'',
    is_poll:'', poll_value_normalized:'', is_hidden:'', is_pinned:'', order_weight:'', profanity_flag:'', confidence:'', tags:'', phase_at_submit:''
  });
  const csv = [headers.join(',')].concat(
    rows.map(r => headers.map(h => {
      const v = r[h] === undefined ? '' : r[h];
      const s = String(v).replace(/"/g,'""');
      return `"${s}"`;
    }).join(','))
  ).join('\n');
  return csv;
}

// ===== PEER REVIEW API =====

/** Gate: has this reviewer submitted at least one response in this session? (non-hidden only) */
function apiHasSubmitted(session_id, unique_id){
  const sh = getResponsesSheet();
  const { header: hdr, rows } = readTable(sh);
  const sCol = hdr.indexOf('session_id');
  const uCol = hdr.indexOf('unique_id');
  const hidCol = hdr.indexOf('is_hidden');
  if (sCol === -1 || uCol === -1) throw new Error('Missing session_id or unique_id columns in Responses.');
  const targetS = String(session_id).trim().toLowerCase();
  const targetU = String(unique_id).trim();
  const has = rows.some(r =>
    String(r[sCol]).trim().toLowerCase() === targetS &&
    String(r[uCol]).trim() === targetU &&
    String(r[hidCol]||'FALSE').toLowerCase() !== 'true'
  );
  return { ok:true, has };
}

/** List feedback submitted by a reviewer (to gray out completed) */
function apiListFeedbackByReviewer(session_id, reviewer_id){
  const sh = getPeerFeedbackSheet();
  const { header: hdr, rows } = readTable(sh);
  const sCol = hdr.indexOf('session_id');
  const rCol = hdr.indexOf('response_id');
  const uCol = hdr.indexOf('reviewer_id');
  const hCol = hdr.indexOf('is_hidden');
  if ([sCol,rCol,uCol,hCol].some(i=>i===-1)) throw new Error('Missing columns in PeerFeedback.');
  const targetS = String(session_id).trim().toLowerCase();
  const targetU = String(reviewer_id||'').trim();
  const done = rows
    .filter(r => String(r[sCol]).trim().toLowerCase() === targetS &&
                 String(r[uCol]).trim() === String(reviewer_id) &&
                 String(r[hCol]||'FALSE').toLowerCase() !== 'true')
    .map(r => String(r[rCol]||''));
  return { ok:true, completed: done };
}


/** Return the visible text for a specific response (edited -> original), or error if hidden/missing */
function apiGetResponseText(session_id, response_id) {
  if (!session_id || !response_id) return { ok:false, error:'Missing session_id or response_id' };

  const shR = getResponsesSheet();
  const { header: hdr, rows } = readTable(shR);
  const idx = (name)=>{ const i = hdr.indexOf(name); if (i === -1) throw new Error(`Missing ${name} in Responses.`); return i; };
  const sCol = idx('session_id'),
        idCol = idx('response_id'),
        hidCol = idx('is_hidden'),
        txtECol = idx('response_text_edited'),
        txtOCol = idx('response_text_original');

  const targetS = String(session_id).trim().toLowerCase();
  const row = rows.find(r =>
    String(r[sCol]).trim().toLowerCase() === targetS &&
    String(r[idCol]).trim() === String(response_id).trim()
  );
  if (!row) return { ok:false, error:'Response not found' };
  if (String(row[hidCol]||'FALSE').toLowerCase() === 'true') return { ok:false, error:'Response is hidden' };

  const text = String(row[txtECol]||'') || String(row[txtOCol]||'');
  return { ok:true, response_id: String(response_id), text };
}

/*********************************
 * OPEN peer review (instructor) *
 *********************************/
function apiStartPeerReview(instructor_id, session_id, window_mins, reviews_per_student) {
  if (!instructor_id || !session_id) throw new Error('Missing instructor or session.');

  const sh = getSheetByName(SHEET_SESSIONS);
  const { header: hdr, rows } = readTable(sh);

  const idCol   = hdr.indexOf('session_id');
  const instCol = hdr.indexOf('instructor_id');
  if (idCol === -1 || instCol === -1) throw new Error('Missing session_id or instructor_id in Sessions.');

  const rowIdx = rows.findIndex(r =>
    String(r[idCol]).trim().toLowerCase() === String(session_id).trim().toLowerCase() &&
    String(r[instCol]).trim() === String(instructor_id)
  );
  if (rowIdx === -1) throw new Error('Session not found for instructor.');

  const base = 2 + rowIdx;
  const openedAt = new Date();
  const wm = Math.max(1, parseInt(window_mins,10) || 5);
  const k  = Math.max(1, parseInt(reviews_per_student,10) || 2);

  // Only set columns if they exist
  setIfExists(sh, base, hdr, 'phase', 'review');
  setIfExists(sh, base, hdr, 'peer_open', 'TRUE');
  setIfExists(sh, base, hdr, 'peer_opened_at', openedAt);
  setIfExists(sh, base, hdr, 'peer_window_mins', wm);
  setIfExists(sh, base, hdr, 'peer_required_reviews', k);

  return { ok:true, session_id, phase:'review', peer_open:true, window_mins: wm, reviews_per_student: k, opened_at: openedAt.toISOString() };
}

/**
 * If peer review is open for this instructor, return the most recently opened session_id.
 */
function apiGetOpenPeerSessionForInstructor(instructor_id) {
  if (!instructor_id) return { ok:false, error:'Missing instructor' };
  const sh = getSheetByName(SHEET_SESSIONS);
  const { header: hdr, rows } = readTable(sh);

  const instCol = hdr.indexOf('instructor_id');
  const openCol = hdr.indexOf('peer_open');
  const atCol   = hdr.indexOf('peer_opened_at');
  const idCol   = hdr.indexOf('session_id');
  if (instCol === -1 || openCol === -1 || idCol === -1) return { ok:true, open:false, session_id:'' };

  const mine = rows
    .map(r => ({ inst: r[instCol], open: String(r[openCol]||'').toLowerCase()==='true', at: prParseDate(r[atCol]), sid: String(r[idCol]||'') }))
    .filter(x => String(x.inst) === String(instructor_id) && x.open);

  if (!mine.length) return { ok:true, open:false, session_id:'' };
  mine.sort((a,b) => (b.at?.getTime()||0) - (a.at?.getTime()||0));
  return { ok:true, open:true, session_id: mine[0].sid, phase:'review' };
}

/** Assign peer targets for a reviewer: ensure self + others (default n_assign=3)
 *  UPDATED: respects peer window when peer_open is set; excludes hidden; avoids duplicates.
 */
function apiAssignPeerTargets(session_id, reviewer_id, n_assign) {
  n_assign = Number(n_assign||0); if (!n_assign) n_assign = 3; // default: self + 2 others

  // Responses sheet
  const shR = getResponsesSheet();
  const { header: hdr, rows } = readTable(shR);
  const idx = (name)=>{ const i = hdr.indexOf(name); if (i===-1) throw new Error(`Missing ${name} in Responses.`); return i; };
  const sCol = idx('session_id'), hidCol = idx('is_hidden'), uidCol = idx('unique_id'), idCol = idx('response_id'), tsCol = idx('timestamp');

  // Build candidate rows for this session (visible only)
  const all = rows
    .map(r => ({
      response_id: String(r[idCol]||''),
      session_id:  String(r[sCol]||''),
      is_hidden:   String(r[hidCol]||'FALSE'),
      author:      String(r[uidCol]||''),
      ts:          r[tsCol] instanceof Date ? r[tsCol] : new Date(r[tsCol])
    }))
    .filter(r => String(r.session_id).trim().toLowerCase() === String(session_id).trim().toLowerCase())
    .filter(r => String(r.is_hidden).toLowerCase() !== 'true');

  // If peer review is configured, restrict to window [opened_at - window_mins, opened_at]
  const cfg = getPeerConfigForSession(session_id);
  const candidates = (cfg)
    ? all.filter(r => r.ts && r.ts >= new Date(cfg.opened_at.getTime() - cfg.window_mins*60000) && r.ts <= cfg.opened_at)
    : all;

  // Require at least one own submission for eligibility
  const own = candidates.filter(r => r.author === String(reviewer_id||'').trim());
  if (!own.length) return { ok:true, assigned: [] };

  // pick latest own submission as mandatory self review
  own.sort((a,b)=> b.ts - a.ts);
  const selfId = own[0].response_id;

  // PeerAssignments sheet & existing assignments
  const shA = getPeerAssignmentsSheet();
  const { header: aHdr, rows: aRows } = readTable(shA);
  const aIdx = (name)=>{ const i=aHdr.indexOf(name); if (i===-1) throw new Error(`Missing ${name} in PeerAssignments.`); return i; };
  const aSCol=aIdx('session_id'), aUCol=aIdx('reviewer_id'), aRidCol=aIdx('response_id');

  const existing = aRows
    .filter(r => String(r[aSCol]).trim().toLowerCase() === String(session_id).trim().toLowerCase() &&
                 String(r[aUCol]).trim() === String(reviewer_id))
    .map(r => String(r[aRidCol]));

  let assigned = existing.slice();
  if (!assigned.includes(selfId)) assigned.unshift(selfId);
  assigned = assigned.slice(0, n_assign);
  if (assigned.length >= n_assign) return { ok:true, assigned };

  // Sample remaining from candidates (exclude self & already assigned)
  const remainingIds = candidates.map(r=>r.response_id).filter(id => id !== selfId && !assigned.includes(id));
  for (let i=remainingIds.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [remainingIds[i],remainingIds[j]]=[remainingIds[j],remainingIds[i]]; }
  const take = remainingIds.slice(0, Math.max(0, n_assign - assigned.length));
  const toAssign = assigned.concat(take).slice(0, n_assign);

  // Persist newly assigned (append rows) — [session_id, reviewer_id, response_id, assigned_at]
  const now = new Date();
  const rowsToAppend = [];
  take.forEach(id => rowsToAppend.push([session_id, String(reviewer_id), id, now]));
  if (!existing.includes(selfId)) rowsToAppend.unshift([session_id, String(reviewer_id), selfId, now]);

  if (rowsToAppend.length){
    const startRow = shA.getLastRow() + 1;
    shA.getRange(startRow, 1, rowsToAppend.length, rowsToAppend[0].length).setValues(rowsToAppend);
  }
  return { ok:true, assigned: toAssign };
}

/** Submit peer feedback (free form)
 *  UPDATED: allowed when session is active OR when peer_open is TRUE.
 */
function apiSubmitPeerFeedback(session_id, response_id, reviewer_id, feedback_text){
  const session = getSession(session_id);
  if (!session) throw new Error('Session not found.');

  // Allow if session active, OR peer review open
  const okToReview = isSessionActive(session) || prBool(session.peer_open);
  if (!okToReview) throw new Error('Peer review is not currently open.');

  const settings = getSettings();
  const text = String(feedback_text||'').trim();
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 10) throw new Error('Please write at least 10 words.');
  if (settings.max_words && words.length > settings.max_words){
    throw new Error(`Please keep to ${settings.max_words} words.`);
  }

  const profList = getProfanityList();
  const hasProf = hasProfanity(text, profList);
  let outText = text;
  if (hasProf && (settings.profanity_action||'mask').toLowerCase() === 'mask'){
    outText = maskProfanity(text, profList);
  } else if (hasProf && (settings.profanity_action||'mask').toLowerCase() === 'block'){
    throw new Error('Your feedback contains disallowed terms.');
  }

  const sh = getPeerFeedbackSheet();
  const { header: hdr } = readTable(sh);
  const idx = (name)=>{ const i=hdr.indexOf(name); if (i===-1) throw new Error(`Missing column ${name} in PeerFeedback.`); return i; };

  // feedback_id autoinc
  const last = sh.getLastRow();
  let nextId = 1;
  if (last >= 2){
    const ids = sh.getRange(2, idx('feedback_id')+1, last-1, 1).getValues().flat().map(Number).filter(n=>!isNaN(n));
    nextId = (ids.length ? Math.max(...ids) : 0) + 1;
  }

  const row = hdr.map(h => {
    switch(h){
      case 'feedback_id':  return nextId;
      case 'session_id':   return session_id;
      case 'response_id':  return response_id;
      case 'reviewer_id':  return String(reviewer_id||'');
      case 'feedback_text':return outText;
      case 'timestamp':    return new Date();
      case 'is_hidden':    return 'FALSE';
      default:             return '';
    }
  });
  sh.appendRow(row);
  return { ok:true, feedback_id: nextId };
}

/********************************
 * Anonymised CSV for students  *
 ********************************/
function apiGetPeerCsv(session_id) {
  if (!session_id) return { ok:false, error:'Missing session_id' };

  // Get assignment targets for this session
  const shA = getPeerAssignmentsSheet();
  const { header: aHdr, rows: aRows } = readTable(shA);
  const aIdx = (name)=>{ const i=aHdr.indexOf(name); if (i===-1) throw new Error(`Missing ${name} in PeerAssignments.`); return i; };
  const aSCol = aIdx('session_id'), aRidCol = aIdx('response_id');

  const targets = new Set(
    aRows.filter(r => String(r[aSCol]).trim().toLowerCase() === String(session_id).trim().toLowerCase())
         .map(r => String(r[aRidCol]||''))
         .filter(Boolean)
  );
  if (!targets.size) return { ok:false, error:'No peer review pool found.' };

  // Join to Responses to get text (prefer edited; exclude hidden)
  const shR = getResponsesSheet();
  const { header: rHdr, rows: rRows } = readTable(shR);
  const rIdx = (name)=>{ const i=rHdr.indexOf(name); if (i===-1) throw new Error(`Missing ${name} in Responses.`); return i; };
  const rIdCol = rIdx('response_id'), hidCol = rIdx('is_hidden'), txtECol = rIdx('response_text_edited'), txtOCol = rIdx('response_text_original');

  const lines = [['response_id','text']];
  rRows.forEach(r => {
    const rid = String(r[rIdCol]||'');
    if (!targets.has(rid)) return;
    const hidden = String(r[hidCol]||'FALSE').toLowerCase()==='true';
    if (hidden) return;
    const text = String(r[txtECol]||'') || String(r[txtOCol]||'');
    lines.push([rid, text.replace(/\r?\n/g,' ').trim()]);
  });

  if (lines.length <= 1) return { ok:false, error:'No visible items to export.' };

  const csv = lines.map(cols => cols.map(c => {
    const s = String(c||'');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
  }).join(',')).join('\n');

  const blob = Utilities.newBlob(csv, 'text/csv', 'peer_review_set.csv');
  const base64 = Utilities.base64Encode(blob.getBytes()); // standard base64 for data: URL
  return { ok:true, filename:'peer_review_set.csv', base64 };
}

/** List feedback items for a response */
function apiListFeedbackForResponse(session_id, response_id){
  const sh = getPeerFeedbackSheet();
  const { header: hdr, rows } = readTable(sh);
  const idx = (name)=>{ const i=hdr.indexOf(name); if (i===-1) throw new Error(`Missing ${name} in PeerFeedback.`); return i; };
  const sCol=idx('session_id'), rCol=idx('response_id'), hCol=idx('is_hidden'), tCol=idx('feedback_text');

  const targetS = String(session_id).trim().toLowerCase();
  return rows
    .filter(r => String(r[sCol]).trim().toLowerCase() === targetS &&
                 String(r[rCol]).trim() === String(response_id) &&
                 String(r[hCol]).toLowerCase() !== 'true')
    .map(r => ({ feedback_text: String(r[tCol]||'') }));
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

/**
 * apiListFeedbackSummary(instructor_id, session_id)
 * Returns {ok:true, byResponse: { [response_id]: {count, items:[{id,text,timestamp,quality}]} } }
 * Only includes items where is_hidden is not TRUE, and session_id matches.
 */
function apiListFeedbackSummary(instructor_id, session_id) {
  try {
    const ss = SpreadsheetApp.getActive();
    const sh = ss.getSheetByName('PeerFeedback');
    if (!sh) return { ok: false, error: 'PeerFeedback sheet not found' };

    // Make sure the quality column exists (create if missing)
    const qualityColIdx = ensureHeaderColumn_(sh, 'review_quality');

    const all = readSheetObjects_(sh);

    // Filter: match session_id, not hidden
    const rows = all.filter(r =>
      String(r.session_id || '').trim() === String(session_id).trim() &&
      String(r.is_hidden || '').toLowerCase() !== 'true'
    );

    // Build byResponse mapping
    const byResponse = {};
    rows.forEach(r => {
      const rid = String(r.response_id || '').trim();
      if (!rid) return;

      if (!byResponse[rid]) byResponse[rid] = { count: 0, items: [] };

      const ts = r.timestamp instanceof Date ? r.timestamp : (r.timestamp ? new Date(r.timestamp) : null);
      const iso = ts && !isNaN(ts.getTime()) ? ts.toISOString() : '';

      const item = {
        id: String(r.feedback_id || ''),            // if blank, client will fall back to timestamp
        text: String(r.feedback_text || ''),
        timestamp: iso,
        quality: String(r.review_quality || '')     // may be blank initially
      };

      byResponse[rid].items.push(item);
    });

    // Add counts
    Object.keys(byResponse).forEach(rid => {
      byResponse[rid].count = byResponse[rid].items.length;
    });

    return { ok: true, byResponse: byResponse };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

  /**
   * apiUpdateFeedbackQuality(instructor_id, session_id, response_id, feedback_key, quality)
   * Upserts the review_quality for a single review in PeerFeedback.
   * feedback_key can be:
   *   - feedback_id (preferred), or
   *   - timestamp (ISO) if you don’t have feedback_id on the client.
   */
  function apiUpdateFeedbackQuality(instructor_id, session_id, response_id, feedback_key, quality) {
    try {
      const ss = SpreadsheetApp.getActive();
      const sh = ss.getSheetByName('PeerFeedback');
      if (!sh) return { ok: false, error: 'PeerFeedback sheet not found' };

      // Ensure the review_quality column exists
      const reviewQualityCol = ensureHeaderColumn_(sh, 'review_quality');

      // Build header index map for quick lookup
      const headerRow = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
      const colIndex = (name) => headerRow.indexOf(name) + 1; // 1-based (0 if not found)

      const cFeedbackId = colIndex('feedback_id');
      const cSessionId  = colIndex('session_id');
      const cResponseId = colIndex('response_id');
      const cTimestamp  = colIndex('timestamp');

      if (!cSessionId || !cResponseId) {
        return { ok: false, error: 'PeerFeedback sheet missing required columns: session_id/response_id' };
      }

      const lastRow = sh.getLastRow();
      if (lastRow < 2) return { ok: false, error: 'No rows in PeerFeedback' };

      const rng = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn());
      const vals = rng.getValues();

      let targetRow = -1; // absolute row number (1-based)

      // Helper to match timestamp key
      const matchesTimestamp = (cellValue, key) => {
        try {
          const a = (cellValue instanceof Date) ? cellValue : (cellValue ? new Date(cellValue) : null);
          const b = key ? new Date(key) : null;
          if (!a || !b || isNaN(a.getTime()) || isNaN(b.getTime())) return false;
          return a.getTime() === b.getTime();
        } catch (_) { return false; }
      };

      // Iterate and find a matching row
      for (let i = 0; i < vals.length; i++) {
        const row = vals[i];

        const sessionOk  = String(row[cSessionId - 1]).trim()  === String(session_id).trim();
        const responseOk = String(row[cResponseId - 1]).trim() === String(response_id).trim();
        if (!sessionOk || !responseOk) continue;

        let keyOk = false;

        // First try: feedback_id == feedback_key (only if feedback_id column exists and key looks like id)
        if (cFeedbackId && feedback_key != null && feedback_key !== '') {
          const idOk = String(row[cFeedbackId - 1]).trim() === String(feedback_key).trim();
          if (idOk) keyOk = true;
        }

        // Fallback: timestamp == feedback_key (if no match by feedback_id)
        if (!keyOk && cTimestamp && feedback_key) {
          if (matchesTimestamp(row[cTimestamp - 1], feedback_key)) {
            keyOk = true;
          }
        }

        if (keyOk) {
          targetRow = i + 2; // +2 (range starts at row 2)
          break;
        }
      }

      if (targetRow === -1) {
        return { ok: false, error: 'Feedback row not found for the provided key' };
      }

      // Write quality
      sh.getRange(targetRow, reviewQualityCol).setValue(String(quality || ''));

      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  }
/** Return anonymized visible content for a session (non-hidden only) */
function apiGetAnonymizedContent(session_id){
  const shR = getResponsesSheet();
  const { header: hdr, rows } = readTable(shR);
  const idx = (name)=>{ const i=hdr.indexOf(name); if (i===-1) throw new Error(`Missing ${name} in Responses.`); return i; };

  const sCol=idx('session_id'), hidCol=idx('is_hidden'),
        txtOrigCol=idx('response_text_original'), txtEditCol=idx('response_text_edited'), idCol=idx('response_id');

  const targetS = String(session_id).trim().toLowerCase();
  const visible = rows
    .filter(r => String(r[sCol]).trim().toLowerCase() === targetS &&
                 String(r[hidCol]).toLowerCase() !== 'true')
    .map(r => ({
      response_id: String(r[idCol]||''),
      text: String(r[txtEditCol]||'') || String(r[txtOrigCol]||'')
    }));

  // Collect feedback per response
  const shF = getPeerFeedbackSheet();
  const { header: fHdr, rows: fRows } = readTable(shF);
  const fIdx = (name)=>{ const i=fHdr.indexOf(name); if (i===-1) throw new Error(`Missing ${name} in PeerFeedback.`); return i; };
  const fSCol=fIdx('session_id'), fRCol=fIdx('response_id'), fHCol=fIdx('is_hidden'), fTCol=fIdx('feedback_text');

  const targetVisible = visible.map(v => v.response_id);
  const feedbackMap = new Map();
  visible.forEach(v => feedbackMap.set(v.response_id, []));
  fRows.forEach(r => {
    const sess = String(r[fSCol]).trim().toLowerCase();
    const rid  = String(r[fRCol]).trim();
    if (sess !== targetS) return;
    if (!targetVisible.includes(rid)) return;
    if (String(r[fHCol]).toLowerCase() === 'true') return;
    const txt = String(r[fTCol]||'');
    feedbackMap.get(rid).push(txt);
  });

  return visible.map(v => ({
    response_id: v.response_id,
    text: v.text,
    feedbacks: feedbackMap.get(v.response_id) || []
  }));
}

// ===== DEBUG APIS =====

/** Inspect Sessions headers quickly */
function apiDebugSessionsHeaders(){
  const sh = getSheetByName(SHEET_SESSIONS);
  const { header } = readTable(sh);
  return { ok:true, headers: header };
}

/** Inspect active session & counts for troubleshooting */
function apiDebugSessionAndCounts(instructor_id, session_id){
  const info = apiGetActiveSessionForInstructor(instructor_id);
  let rows = [];
  try { rows = apiListResponsesByInstructor(instructor_id, session_id); } catch(e){ rows = []; }
  return {
    ok: true,
    active: info.active,
    phase: info.phase,
    session_id_resolved: info.session_id,
    input_session_id: session_id,
    counts: {
      total_for_session: Array.isArray(rows) ? rows.length : 0,
      visible_writing: Array.isArray(rows) ? rows.filter(r =>
        String(r.is_hidden).toLowerCase() !== 'true' &&
        String(r.phase_at_submit || '').toLowerCase() === 'writing'
      ).length : 0
    }
  };
}

/** Accept POSTs from Canvas and render the student page with pre-resolved canvas_id */
function doPost(e) {
  try {
    // NEW: enforce domain (if you still POST through Canvas/other launcher)
    const email = requireDomainEmailOrThrow('aucklanduni.ac.nz');

    const params = (e && e.parameter) ? e.parameter : {};

    // Page routing (default to student)
    const pageRaw = params.page ? String(params.page) : 'student';
    const page = pageRaw.toLowerCase();

    if (page === 'student') {
      const t = HtmlService.createTemplateFromFile('student');
      // Prefer posted values; otherwise blank (student.html will also try URL/getLocation fallbacks).
      t.inst = params.inst ? String(params.inst) : '';
      t.exec = ScriptApp.getService().getUrl();

      // Pick whichever field Canvas actually sent (legacy; safe to keep)
      const cid = params.canvas_id || params.custom_canvas_id || params.user_id || params.login_id || '';
      t.canvas_id = String(cid || '');

      // NEW: pass the authenticated email (preferred ID)
      t.email = String(email || '');

      return t.evaluate()
        .setTitle('Class Response')
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    }

    // For any other pages, just delegate to GET routing (keeps behavior consistent)
    return doGet(e);
  } catch (err) {
    return HtmlService.createHtmlOutput('<p>POST error: ' + String(err && err.message || err) + '</p>')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
}
