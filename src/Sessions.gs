// Sessions.gs — Session lifecycle and state: writing window, phase, what students and the dashboard see.
// All .gs files share one global scope in Apps Script.

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

// Writing and peer review have independent lifetimes:
//   - Writing is open while the session is active: is_active = TRUE and now < active_until.
//   - Peer review is open for submissions while peer_open = TRUE and now < peer_until
//     (blank peer_until = no deadline). This can outlast the session itself.
//   - After the deadline (peer_open still TRUE), the review is read-only: students who
//     completed their assigned reviews can still see the feedback they received.

/** Writing is open: session flagged active and not past active_until */
function isSessionActive(session) {
  if (!session) return false;
  if (!prBool(session.is_active)) return false;
  const until = prParseDate(session.active_until);
  return !!(until && !isNaN(until.getTime()) && new Date() < until);
}

/** Review deadline as a Date, or null if there is none */
function getPeerUntil_(session) {
  const d = session ? prParseDate(session.peer_until) : null;
  return (d && !isNaN(d.getTime())) ? d : null;
}

/** Peer review is accepting submissions */
function areReviewsOpen_(session) {
  if (!session || !prBool(session.peer_open)) return false;
  const until = getPeerUntil_(session);
  return !until || new Date() < until;
}

/** Parse an ISO deadline from the client: '' -> null (no deadline); invalid -> throws */
function parseDeadline_(iso) {
  if (iso === undefined || iso === null || String(iso).trim() === '') return null;
  const d = new Date(String(iso));
  if (isNaN(d.getTime())) throw new Error('Invalid review deadline.');
  return d;
}

// ===== Activity settings =====
// Each session has two settings, chosen at login via a preset:
//   submission_type: what students submit ('text'; 'sketch' is added in a later step)
//   peer_review:     whether the session can have a peer review phase
// Presets are what instructors see; the server only reasons about the two settings.
const PRESETS = {
  respond: { label: 'Quick response', submission_type: 'text', peer_review: false },
  peer:    { label: 'Peer review',    submission_type: 'text', peer_review: true  },
};
const DEFAULT_PRESET = 'respond';

/** A session's activity settings. Sessions created before settings existed have blank
 *  cells: they're treated as text with peer review allowed (how the app used to work). */
function getSessionSettings_(session) {
  const type = String((session && session.submission_type) || '').trim().toLowerCase() || 'text';
  const rawPeer = session ? session.peer_review : '';
  const peer = (rawPeer === '' || rawPeer === undefined || rawPeer === null) ? true : prBool(rawPeer);
  const preset = Object.keys(PRESETS).find(k => PRESETS[k].submission_type === type && PRESETS[k].peer_review === peer) || '';
  return { submission_type: type, peer_review: peer, preset, label: preset ? PRESETS[preset].label : 'Custom' };
}

// ===== Student view cache =====
// Student pages poll apiGetStudentView, so its result is cached briefly per instructor.
// Every instructor action that changes what students see clears the cache immediately.
const STUDENT_VIEW_CACHE_SECS = 10;
function studentViewCacheKey_(instructor_id) {
  return 'student_view_' + String(instructor_id || '').trim().toLowerCase();
}
function invalidateStudentView_(instructor_id) {
  CacheService.getScriptCache().remove(studentViewCacheKey_(instructor_id));
}

/** Phases: only 'writing' or 'review' */
function getPhaseForSession(session) {
  if (!session) return 'writing';
  const raw = String(session.phase || '').trim().toLowerCase();
  if (raw === 'review') return 'review';
  return 'writing';
}

// All functions here take a login token (from apiInstructorLogin) as their first argument.

/** Start (or reopen) a session with an activity preset ('respond' | 'peer').
 *  A session in its peer review phase keeps its settings, so a review isn't stranded. */
function apiStartSession(token, session_id, duration_mins, preset){
  const instructor_id = requireInstructor_(token);
  const inst = getInstructorById_(instructor_id);
  if (!inst) throw new Error('Instructor not found.');
  if (!String(session_id || '').trim()) throw new Error('Enter a session ID.');
  const presetKey = String(preset || DEFAULT_PRESET).trim().toLowerCase();
  if (!PRESETS[presetKey]) throw new Error('Unknown activity type: ' + preset);
  const chosen = PRESETS[presetKey];

  const sh = getSheetByName(SHEET_SESSIONS);
  ensureHeaderColumn_(sh, 'submission_type');
  ensureHeaderColumn_(sh, 'peer_review');
  const { header: hdr, rows } = readTable(sh);

  // Required columns only (these must exist in your sheet)
  const idCol    = idxRequired(hdr, 'session_id');
  const instCol  = idxRequired(hdr, 'instructor_id');

  const rowIndex = rows.findIndex(r =>
    String(r[idCol]).trim().toLowerCase() === String(session_id).trim().toLowerCase() &&
    String(r[instCol]) === String(instructor_id)
  );

  const now = new Date();
  // Writing duration chosen at login: 1 minute to 24 hours, default 60
  const mins = Math.min(24 * 60, Math.max(1, parseInt(duration_mins, 10) || 60));
  const until = new Date(now.getTime() + mins * 60 * 1000);
  const initialPhase = 'writing';
  let phase = initialPhase;
  let settingsKept = false;
  const applySettings = (base) => {
    setIfExists(sh, base, hdr, 'submission_type', chosen.submission_type);
    setIfExists(sh, base, hdr, 'peer_review', chosen.peer_review ? 'TRUE' : 'FALSE');
  };

  if (rowIndex >= 0) {
    const base = 2 + rowIndex;
    const existing = rows[rowIndex];

    // Keep the current phase if the session is still live (e.g. instructor reloaded the
    // dashboard mid-class) or has peer review open (instructor coming back after class to
    // read reviews; use "Back to writing" to leave review). Otherwise this is a fresh run
    // of a reused session ID: reset to writing.
    const peerOpenCol = hdr.indexOf('peer_open');
    const peerOpen = peerOpenCol >= 0 && String(existing[peerOpenCol]).toLowerCase() === 'true';
    const actCol   = hdr.indexOf('is_active');
    const untilCol = hdr.indexOf('active_until');
    const phaseCol = hdr.indexOf('phase');
    const prevUntil = untilCol >= 0 ? prParseDate(existing[untilCol]) : null;
    const stillLive = actCol >= 0 &&
      String(existing[actCol]).toLowerCase() === 'true' &&
      prevUntil && !isNaN(prevUntil.getTime()) && now < prevUntil;

    setIfExists(sh, base, hdr, 'is_open', 'TRUE');
    setIfExists(sh, base, hdr, 'is_active', 'TRUE');
    setIfExists(sh, base, hdr, 'active_until', until);
    setIfExists(sh, base, hdr, 'archived', 'FALSE');
    setIfExists(sh, base, hdr, 'is_poll_mode', 'FALSE');

    if (stillLive || peerOpen) {
      phase = (phaseCol >= 0 && String(existing[phaseCol]).trim().toLowerCase() === 'review') ? 'review' : 'writing';
    } else {
      phase = initialPhase;
      setIfExists(sh, base, hdr, 'created_at', now);
      setIfExists(sh, base, hdr, 'phase', initialPhase);
      setIfExists(sh, base, hdr, 'peer_open', 'FALSE');
      setIfExists(sh, base, hdr, 'is_review_mode', 'FALSE');
    }
    // Apply the chosen activity, except mid-review (switching then would strand the review)
    if (phase === 'review') settingsKept = true; else applySettings(base);
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
        case 'peer_open':     return 'FALSE';
        case 'is_review_mode':return 'FALSE';
        case 'is_poll_mode':  return 'FALSE';
        case 'submission_type': return chosen.submission_type;
        case 'peer_review':   return chosen.peer_review ? 'TRUE' : 'FALSE';
        default:              return '';
      }
    });
    sh.appendRow(row);
  }
  invalidateStudentView_(instructor_id);
  const settings = getSessionSettings_(getSession(session_id));
  return { ok:true, session_id, active_until: until.toISOString(), phase, settings, settings_kept: settingsKept };
}

/** Set phase: writing | review. Returning to writing ends peer review. */
function apiSetPhase(token, session_id, phase) {
  const instructor_id = requireInstructor_(token);
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
  if (phase === 'review' && !getSessionSettings_(getSession(session_id)).peer_review) {
    throw new Error('Peer review is not enabled for this session.');
  }

  setIfExists(sh, base, hdr, 'phase', phase);
  // Align legacy flags only if present
  setIfExists(sh, base, hdr, 'is_poll_mode', 'FALSE');
  setIfExists(sh, base, hdr, 'is_review_mode', phase === 'review' ? 'TRUE' : 'FALSE');
  // Returning to writing closes peer review, so students no longer fall back into it
  if (phase === 'writing') setIfExists(sh, base, hdr, 'peer_open', 'FALSE');

  invalidateStudentView_(instructor_id);
  return { ok:true, phase };
}

/** Stop session early: closes writing. Peer review (if open) continues until its deadline. */
function apiStopSession(token, session_id) {
  const instructor_id = requireInstructor_(token);
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
  invalidateStudentView_(instructor_id);
  return { ok:true };
}

/** Find the Sessions row for (session_id, instructor_id). Returns {sh, hdr, rows, rowIdx, base}. */
function findOwnedSessionRow_(instructor_id, session_id) {
  const sh = getSheetByName(SHEET_SESSIONS);
  const { header: hdr, rows } = readTable(sh);
  const idCol   = idxRequired(hdr, 'session_id');
  const instCol = idxRequired(hdr, 'instructor_id');
  const rowIdx = rows.findIndex(r =>
    String(r[idCol]).trim().toLowerCase() === String(session_id).trim().toLowerCase() &&
    String(r[instCol]).trim() === String(instructor_id)
  );
  if (rowIdx === -1) throw new Error('Session not found for instructor.');
  return { sh, hdr, rows, rowIdx, base: 2 + rowIdx };
}

/** Extend (or reopen) writing for a session by `mins` minutes from now or from its current end */
function apiExtendSession(token, session_id, mins) {
  const instructor_id = requireInstructor_(token);
  const m = Math.max(1, parseInt(mins, 10) || 30);
  const { sh, hdr, rows, rowIdx, base } = findOwnedSessionRow_(instructor_id, session_id);
  const untilCol = hdr.indexOf('active_until');
  const actCol   = hdr.indexOf('is_active');
  const now = new Date();
  const cur = untilCol >= 0 ? prParseDate(rows[rowIdx][untilCol]) : null;
  const stillActive = actCol >= 0 && String(rows[rowIdx][actCol]).toLowerCase() === 'true';
  const from = (stillActive && cur && !isNaN(cur.getTime()) && cur > now) ? cur : now;
  const until = new Date(from.getTime() + m * 60 * 1000);
  setIfExists(sh, base, hdr, 'is_open', 'TRUE');
  setIfExists(sh, base, hdr, 'is_active', 'TRUE');
  setIfExists(sh, base, hdr, 'active_until', until);
  invalidateStudentView_(instructor_id);
  return { ok:true, active_until: until.toISOString() };
}

/** Full state of one session, for the dashboard */
function apiGetSessionState(token, session_id) {
  const instructor_id = requireInstructor_(token);
  const session = requireSessionOwner_(instructor_id, session_id);
  const activeUntil = prParseDate(session.active_until);
  const peerUntil = getPeerUntil_(session);
  return {
    ok: true,
    session_id: String(session.session_id),
    phase: getPhaseForSession(session),
    writing_open: isSessionActive(session),
    active_until: (activeUntil && !isNaN(activeUntil.getTime())) ? activeUntil.toISOString() : '',
    peer_open: prBool(session.peer_open),
    reviews_open: areReviewsOpen_(session),
    peer_until: peerUntil ? peerUntil.toISOString() : '',
    settings: getSessionSettings_(session)
  };
}

/**
 * What the student page should show for an instructor link (?inst=...):
 *   1. The instructor's live session (writing open), in its current phase; otherwise
 *   2. their most recently opened peer review (peer_open = TRUE), open or past its deadline;
 *   3. otherwise nothing.
 * Returns { ok, session_id, phase: 'writing'|'review'|'', writing_open, reviews_open, peer_until,
 *           settings: { submission_type, peer_review, preset, label } }.
 * Polled by student pages, so results are cached briefly (see STUDENT_VIEW_CACHE_SECS).
 */
function apiGetStudentView(instructor_id) {
  if (!instructor_id) return studentViewNone_();
  const cache = CacheService.getScriptCache();
  const key = studentViewCacheKey_(instructor_id);
  const hit = cache.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  const result = computeStudentView_(instructor_id);
  cache.put(key, JSON.stringify(result), STUDENT_VIEW_CACHE_SECS);
  return result;
}
function studentViewNone_() {
  return { ok:true, session_id:'', phase:'', writing_open:false, reviews_open:false, peer_until:'', settings:null };
}
function computeStudentView_(instructor_id) {
  const none = studentViewNone_();

  const sh = getSheetByName(SHEET_SESSIONS);
  const { header: hdr, rows } = readTable(sh);
  const mine = rows
    .map(r => { const rec = {}; hdr.forEach((h, i) => rec[h] = r[i]); return rec; })
    .filter(s => String(s.instructor_id).trim() === String(instructor_id).trim() && s.session_id !== '');

  const view = (s) => {
    const pu = getPeerUntil_(s);
    return {
      ok: true,
      session_id: String(s.session_id),
      phase: getPhaseForSession(s),
      writing_open: isSessionActive(s),
      reviews_open: areReviewsOpen_(s),
      peer_until: pu ? pu.toISOString() : '',
      settings: getSessionSettings_(s)
    };
  };
  const time = (v) => { const d = prParseDate(v); return (d && !isNaN(d.getTime())) ? d.getTime() : 0; };

  const live = mine.filter(isSessionActive).sort((a, b) => time(b.active_until) - time(a.active_until));
  if (live.length) return view(live[0]);

  const peer = mine.filter(s => prBool(s.peer_open)).sort((a, b) => time(b.peer_opened_at) - time(a.peer_opened_at));
  if (peer.length) return Object.assign(view(peer[0]), { phase: 'review' });

  return none;
}
