// Sessions.gs — Session lifecycle and state: writing window, phase, what students and the dashboard see.
// All .gs files share one global scope in Apps Script.

/** Look up a session by ID. Pass instructor_id whenever it's known: session IDs aren't
 *  unique across instructors, so without it the first row with that ID is returned. */
function getSession(session_id, instructor_id) {
  const sh = getSheetByName(SHEET_SESSIONS);
  const { header: hdr, rows } = readTable(sh);
  const idCol = hdr.indexOf('session_id');
  if (idCol === -1) throw new Error('Missing column session_id in Sessions.');
  const target = String(session_id).trim().toLowerCase();
  const inst = (instructor_id === undefined || instructor_id === null) ? null : String(instructor_id).trim();
  for (const r of rows) {
    const rec = {}; hdr.forEach((h,i)=>rec[h]=r[i]);
    if (String(rec.session_id).trim().toLowerCase() !== target) continue;
    if (inst !== null && String(rec.instructor_id).trim() !== inst) continue;
    return rec;
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
// Each session has these settings, chosen at login:
//   submission_type: what students submit: any combination of 'text', 'math' (typed
//                    equations) and 'sketch' (a drawing), joined by '_' in that order, e.g.
//                    'text', 'math_sketch' or 'text_math_sketch'. Students submit at least
//                    one of the chosen parts.
//   peer_review:     whether the session can have a peer review phase
//   background:      what drawings are made on: 'blank', 'grid', 'axes' or 'image' (a figure
//                    from background_url, for students to annotate). Drawing types only.
//   background_url:  the figure's address when background is 'image', else ''
// PRESETS are the older single-choice names, still accepted by apiStartSession.
const SUBMISSION_PARTS = ['text', 'math', 'sketch'];
const SUBMISSION_PART_NAMES = { text: 'text', math: 'math', sketch: 'drawing' };
const SKETCH_BACKGROUNDS = ['blank', 'grid', 'axes', 'image'];
const SKETCH_IMAGE_URL_MAX = 2000;

/** A figure address made ready to show: a Google Drive share link becomes a direct image
 *  link; anything else must be a plain https:// address. Returns '' if it can't be used. */
function normalizeImageUrl_(raw) {
  const url = String(raw == null ? '' : raw).trim();
  if (!url || url.length > SKETCH_IMAGE_URL_MAX) return '';
  const drive = /^https:\/\/drive\.google\.com\/(?:file\/d\/([\w-]+)|(?:open|uc)\?(?:[^#]*&)?id=([\w-]+))/.exec(url);
  if (drive) return 'https://drive.google.com/thumbnail?id=' + (drive[1] || drive[2]) + '&sz=w1600';
  return /^https:\/\/[^\s"'<>\\`]+$/i.test(url) ? url : '';
}
const PRESETS = {
  respond: { label: 'Quick response', submission_type: 'text', peer_review: false },
  peer:    { label: 'Peer review',    submission_type: 'text', peer_review: true  },
};
const DEFAULT_PRESET = 'respond';

/** A submission type in its stored form ('text_math', ...), or '' if it isn't valid. Takes a
 *  string ('math_sketch', 'text,math') or an array of parts (['math', 'text']). */
function normalizeSubmissionType_(raw) {
  const list = Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(/[\s_,+]+/);
  const parts = list.map(p => String(p).trim().toLowerCase()).filter(Boolean);
  if (!parts.length || parts.some(p => SUBMISSION_PARTS.indexOf(p) === -1)) return '';
  return SUBMISSION_PARTS.filter(p => parts.indexOf(p) >= 0).join('_');
}

/** Which parts a submission type allows: { text, math, sketch }, or null if it isn't valid */
function submissionKind_(type) {
  const norm = normalizeSubmissionType_(type);
  if (!norm || norm !== String(type)) return null;
  const parts = norm.split('_');
  return { text: parts.indexOf('text') >= 0, math: parts.indexOf('math') >= 0, sketch: parts.indexOf('sketch') >= 0 };
}

/** Activity name shown to instructors and students, e.g. "Quick response", "Peer review · math"
 *  or "Quick response · text, math & drawing". Text alone adds nothing. */
function activityLabel_(submission_type, peer_review) {
  const names = submission_type.split('_').map(p => SUBMISSION_PART_NAMES[p]);
  const suffix = submission_type === 'text' ? ''
    : ' · ' + (names.length > 1 ? names.slice(0, -1).join(', ') + ' & ' + names[names.length - 1] : names[0]);
  return (peer_review ? 'Peer review' : 'Quick response') + suffix;
}

/** The activity chosen at login: a preset name ('respond' | 'peer') or
 *  { submission_type, peer_review, background }. Returns all three, or throws. */
function resolveActivity_(activity) {
  if (activity && typeof activity === 'object') {
    const raw = activity.submission_type === undefined || activity.submission_type === null || activity.submission_type === ''
      ? 'text' : activity.submission_type;
    const type = normalizeSubmissionType_(raw);
    if (!type) throw new Error('Unknown submission type: ' + activity.submission_type);
    const bg = String(activity.background || 'blank').trim().toLowerCase();
    if (SKETCH_BACKGROUNDS.indexOf(bg) === -1) throw new Error('Unknown drawing background: ' + activity.background);
    let url = '';
    if (bg === 'image') {
      url = normalizeImageUrl_(activity.background_url);
      if (!url) throw new Error(String(activity.background_url || '').trim()
        ? 'The figure address must be a web link starting with https://.'
        : 'Enter the address (URL) of the figure for students to draw on.');
    }
    return { submission_type: type, peer_review: prBool(activity.peer_review), background: bg, background_url: url };
  }
  const key = String(activity || DEFAULT_PRESET).trim().toLowerCase();
  if (!PRESETS[key]) throw new Error('Unknown activity type: ' + activity);
  return { submission_type: PRESETS[key].submission_type, peer_review: PRESETS[key].peer_review, background: 'blank', background_url: '' };
}

/** A session's activity settings. Sessions created before settings existed have blank
 *  cells: they're treated as text with peer review allowed (how the app used to work).
 *  preset is 'respond' or 'peer' (the peer review choice); label is the activity name. */
function getSessionSettings_(session) {
  const rawType = String((session && session.submission_type) || '').trim().toLowerCase() || 'text';
  const type = normalizeSubmissionType_(rawType);
  const rawPeer = session ? session.peer_review : '';
  const peer = (rawPeer === '' || rawPeer === undefined || rawPeer === null) ? true : prBool(rawPeer);
  const rawBg = String((session && session.sketch_background) || '').trim().toLowerCase();
  let background = SKETCH_BACKGROUNDS.indexOf(rawBg) >= 0 ? rawBg : 'blank';
  const background_url = background === 'image' ? normalizeImageUrl_(session && session.sketch_image_url) : '';
  if (background === 'image' && !background_url) background = 'blank';   // figure address missing or unusable
  if (!type) return { submission_type: rawType, peer_review: peer, preset: '', label: 'Custom', background, background_url };
  return { submission_type: type, peer_review: peer, preset: peer ? 'peer' : 'respond', label: activityLabel_(type, peer), background, background_url };
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

/** Start (or reopen) a session. activity is { submission_type, peer_review, background,
 *  background_url } or a preset
 *  name ('respond' | 'peer'). A session in its peer review phase keeps its settings, so a
 *  review isn't stranded. */
function apiStartSession(token, session_id, duration_mins, activity){
  const instructor_id = requireInstructor_(token);
  const inst = getInstructorById_(instructor_id);
  if (!inst) throw new Error('Instructor not found.');
  if (!String(session_id || '').trim()) throw new Error('Enter a session ID.');
  const chosen = resolveActivity_(activity);

  const sh = getSheetByName(SHEET_SESSIONS);
  ensureHeaderColumn_(sh, 'submission_type');
  ensureHeaderColumn_(sh, 'peer_review');
  ensureHeaderColumn_(sh, 'sketch_background');
  ensureHeaderColumn_(sh, 'sketch_image_url');
  const { header: hdr, rows } = readTable(sh);

  // Required columns only (these must exist in your sheet)
  const idCol    = idxRequired(hdr, 'session_id');
  const instCol  = idxRequired(hdr, 'instructor_id');

  const rowIndex = rows.findIndex(r =>
    String(r[idCol]).trim().toLowerCase() === String(session_id).trim().toLowerCase() &&
    String(r[instCol]).trim() === String(instructor_id).trim()
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
    setIfExists(sh, base, hdr, 'sketch_background', chosen.background);
    setIfExists(sh, base, hdr, 'sketch_image_url', chosen.background_url);
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
        case 'sketch_background': return chosen.background;
        case 'sketch_image_url': return chosen.background_url;
        default:              return '';
      }
    });
    sh.appendRow(row);
  }
  invalidateStudentView_(instructor_id);
  const settings = getSessionSettings_(getSession(session_id, instructor_id));
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
    String(r[instCol]).trim() === String(instructor_id).trim()
  );
  if (idxRow === -1) throw new Error('Session not found for instructor.');
  const base = 2 + idxRow;
  if (phase === 'review' && !getSessionSettings_(getSession(session_id, instructor_id)).peer_review) {
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
    String(r[instCol]).trim() === String(instructor_id).trim()
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
 *           settings: { submission_type, peer_review, preset, label, background, background_url } }.
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
